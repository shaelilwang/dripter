/* Article Drip — extract.js
 *
 * Pulls the full body of a native X Article or a thread out of the page we're
 * currently sitting on, converts it to blocks, and hands it to the chunker.
 *
 * Runs inside a background tab opened by background.js, then reports back.
 */
;(function (root) {
  root.AD = root.AD || {};
  const { sel, dom, chunker } = root.AD;

  /* ---------------------------------------------------------------- */
  /* native X Articles                                                 */
  /* ---------------------------------------------------------------- */

  /** Walk the rendered Article body into ordered heading/para blocks. */
  function blocksFromArticle(bodyEl) {
    const blocks = [];
    const push = (type, text) => {
      const t = (text || '').replace(/[ \t]+/g, ' ').trim();
      if (t) blocks.push({ type, text: t });
    };

    // Prefer real semantic elements when X emits them.
    const semantic = bodyEl.querySelectorAll('h1,h2,h3,h4,p,li,blockquote');
    if (semantic.length >= 3) {
      for (const el of semantic) {
        const tag = el.tagName.toLowerCase();
        const type = /^h[1-4]$/.test(tag) ? 'heading' : 'para';
        const text = dom.richText(el);
        if (tag === 'li') push('para', '• ' + text.trim());
        else if (tag === 'blockquote') push('para', '“' + text.trim() + '”');
        else push(type, text);
      }
      return blocks;
    }

    // Fall back to X's div-soup: split the flattened text on blank lines and
    // let the chunker's heading heuristic sort it out.
    const raw = dom.richText(bodyEl);
    for (const para of raw.split(/\n+/)) push(undefined, para);
    return blocks;
  }

  /**
   * Last-resort structural find, for when none of the articleBody testids
   * match — which is likely, since X's Article markup couldn't be inspected
   * up front and they rename things.
   *
   * Picks the deepest element still holding most of the page's prose. Going
   * deepest matters: every ancestor up to <body> contains the article text
   * too, and the shallow ones drag in nav and sidebar chrome.
   *
   * The length floor keeps this from firing on an ordinary post page.
   */
  function findProseFallback(minChars) {
    const scope = sel.q('primaryColumn') || document.body;
    const candidates = [];

    for (const el of scope.querySelectorAll('div, section, main')) {
      // Skip posts themselves and anything wrapping a whole timeline.
      if (el.closest('article[data-testid="tweet"]')) continue;
      if (el.querySelector('[data-testid="cellInnerDiv"]')) continue;

      const len = (el.innerText || '').trim().length;
      if (len < minChars) continue;

      let depth = 0;
      for (let p = el; p && p !== scope; p = p.parentElement) depth++;
      candidates.push({ el, len, depth });
    }

    if (!candidates.length) return null;

    const maxLen = Math.max(...candidates.map((c) => c.len));
    // Among everything holding ~all the prose, take the most deeply nested.
    return candidates
      .filter((c) => c.len >= maxLen * 0.9)
      .sort((a, b) => b.depth - a.depth)[0].el;
  }

  async function extractArticle() {
    let bodyEl = await dom.waitFor(() => {
      const el = sel.q('articleBody');
      return el && dom.richText(el).trim().length > 200 ? el : null;
    }, { timeout: 12000 });

    // Named selectors missed — try to find the prose structurally instead.
    if (!bodyEl) {
      await dom.autoScroll({ maxSteps: 12, settleMs: 450 });
      bodyEl = findProseFallback(1200);
      if (bodyEl) console.info('[article-drip] articleBody selectors missed; ' +
        'used the structural fallback. Run Selector Doctor here and add the ' +
        'real selector to src/selectors.js.');
    }

    if (!bodyEl) return null;

    // Articles lazy-render as you scroll; ride to the bottom before reading.
    await dom.autoScroll({ maxSteps: 25, settleMs: 500 });
    await dom.waitForStable(() => dom.richText(bodyEl).length, { quietMs: 800 });

    const titleEl = sel.q('articleTitle');
    const title = titleEl ? dom.richText(titleEl).trim().split('\n')[0] : null;
    const blocks = blocksFromArticle(bodyEl);

    return { title, blocks, source: 'article' };
  }

  /* ---------------------------------------------------------------- */
  /* threads                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * On a status page, collect consecutive posts by the root author.
   * We stop at the first post from someone else — that's where replies begin.
   */
  async function extractThread(expectedHandle) {
    const first = await dom.waitFor(() => sel.q('tweet'), { timeout: 12000 });
    if (!first) return null;

    await dom.autoScroll({ maxSteps: 30, settleMs: 650 });

    const rootHandle = (expectedHandle ||
      (root.AD.collect.authorOf(first).handle) || '').toLowerCase();

    const parts = [];
    const seenIds = new Set();

    for (const tweetEl of sel.qa('tweet')) {
      const link = root.AD.collect.permalinkOf(tweetEl);
      if (!link) continue;
      if (seenIds.has(link.id)) continue;

      if (rootHandle && link.handle.toLowerCase() !== rootHandle) {
        // Someone else's post: the self-thread is over.
        if (parts.length) break;
        continue;
      }

      const textEl = sel.q('tweetText', tweetEl);
      const text = textEl ? dom.richText(textEl).trim() : '';
      if (!text) continue;

      seenIds.add(link.id);
      parts.push(text);
    }

    if (!parts.length) return null;

    const blocks = [];
    for (const p of parts) {
      // Strip thread counters like "3/12" and trailing "🧵" so they don't
      // survive into snippets with their own, now-wrong, numbering.
      const cleaned = p
        .replace(/(^|\s)\d{1,2}\s*\/\s*\d{0,2}(?=\s|$)/g, ' ')
        .replace(/🧵/g, '')
        .trim();
      for (const para of cleaned.split(/\n+/)) {
        const t = para.trim();
        if (t) blocks.push({ type: undefined, text: t });
      }
    }

    return { title: null, blocks, source: 'thread', postCount: parts.length };
  }

  /* ---------------------------------------------------------------- */

  /**
   * Extract whatever this page holds for `item`, chunk it, and store it.
   * Returns { ok, snippets, reason }.
   */
  /**
   * Extract whatever this page holds for `item`, chunk it, and store it.
   *
   * The kind recorded at harvest time is only a guess — X renders Articles in
   * the bookmarks list as plain posts, so the list simply doesn't carry the
   * information. This page does: if an Article body renders here, it's an
   * Article, whatever we guessed earlier. So classify here and correct the
   * record, rather than trusting the guess and extracting the wrong thing.
   *
   * Returns { ok, snippets, kind, reason }.
   */
  async function extractInto(item) {
    const store = root.AD.store;
    const settings = await store.getSettings();

    // Always try the Article body first, regardless of the recorded kind.
    let result = await extractArticle();
    let kind = 'article';

    if (!result) {
      result = await extractThread(item.author && item.author.handle);
      kind = result && result.postCount >= settings.minThreadPosts ? 'thread' : 'post';
    }

    if (!result || !result.blocks.length) {
      await store.updateItem(item.id, { state: 'failed', fetchedAt: Date.now() });
      return { ok: false, reason: 'no readable body found on the page' };
    }

    // A single short post is readable in the feed as-is; dripping it would
    // just be noise. Mark it skipped, not failed — nothing went wrong.
    const chars = result.blocks.reduce((n, b) => n + b.text.length, 0);
    if (kind === 'post' && chars < settings.minPostChars) {
      await store.updateItem(item.id, {
        kind, state: 'skipped', fetchedAt: Date.now(),
      });
      return { ok: false, skipped: true, kind, reason: `too short to drip (${chars} chars)` };
    }

    const snippets = chunker.chunk(result.blocks, { maxChars: settings.maxChars });
    if (!snippets.length) {
      await store.updateItem(item.id, { state: 'failed', fetchedAt: Date.now() });
      return { ok: false, reason: 'body was empty after chunking' };
    }

    await store.updateItem(item.id, {
      kind,
      title: result.title || item.title,
    });
    await store.setSnippets(item.id, snippets);
    return { ok: true, kind, snippets: snippets.length };
  }

  root.AD.extract = { extractInto, extractArticle, extractThread, blocksFromArticle };
})(globalThis);
