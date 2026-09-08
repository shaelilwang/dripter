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

    // Prefer real semantic elements when X emits them — the tag tells us
    // outright what's a heading, with no guessing.
    const semantic = Array.from(
      bodyEl.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,blockquote')
    ).filter((el) => !el.parentElement.closest('p,li,blockquote'));

    if (semantic.length >= 3) {
      for (const el of semantic) {
        const tag = el.tagName.toLowerCase();
        const text = (el.innerText || '').trim();
        if (!text) continue;
        if (/^h[1-6]$/.test(tag)) push('heading', text);
        else if (tag === 'li') push('para', '• ' + text);
        else if (tag === 'blockquote') push('para', '“' + text + '”');
        else push('para', text);
      }
      return blocks;
    }

    // Otherwise X's nested-div rich text. Use innerText, NOT our own tree
    // walk: richText() emits a newline after every DIV, and in deeply nested
    // markup that shatters prose into one-fragment-per-div. innerText breaks
    // where the browser actually renders a break, which is what we want.
    const raw = bodyEl.innerText || '';
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

    let via = bodyEl ? (sel.pick('articleBody') || 'articleBody') : null;

    // Named selectors missed — try to find the prose structurally instead.
    if (!bodyEl) {
      await dom.autoScroll({ maxSteps: 12, settleMs: 450 });
      bodyEl = findProseFallback(1200);
      via = bodyEl ? 'structural-fallback' : null;
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
    let blocks = blocksFromArticle(bodyEl);

    blocks = dropTitleEcho(blocks, title);

    return { title, blocks, source: 'article', via };
  }

  /**
   * Drop leading blocks that merely restate the article title.
   *
   * The card header already shows the title, so a body opening with it makes
   * the very first snippet a duplicate of the line directly above it — you
   * reach an article in the feed and the first thing it hands you is its own
   * headline, which reads like the tool failed to find any content.
   */
  function dropTitleEcho(blocks, title) {
    if (!title || !blocks || !blocks.length) return blocks || [];
    const key = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const t = key(title);
    if (!t) return blocks;

    let i = 0;
    while (i < blocks.length && key(blocks[i].text) === t) i++;
    return blocks.slice(i);
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
      if (!cleaned) continue;

      // One block per POST, newlines and all.
      //
      // Splitting each post into its own lines is what produced a 264-card
      // thread showing one bullet at a time: a post with a ten-item list
      // became ten cards. The author already chose the unit — keep it.
      //
      // 'para' suppresses heading detection (a short post like "1. Get a
      // microcontroller" would otherwise read as a heading) and 'atomic'
      // stops posts being glued to each other.
      blocks.push({ type: 'para', atomic: true, text: cleaned });
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

    // Record what extraction actually saw. When a card shows headings instead
    // of prose the cause is upstream of the reader, and without this the only
    // way to tell a bad selector from a bad chunk is to guess.
    const headings = snippets.filter((s) => s.kind === 'heading').length;
    await store.updateItem(item.id, {
      kind,
      title: result.title || item.title,
      // Keep the extracted blocks. Re-chunking after a settings change then
      // costs nothing, instead of re-opening every article in a browser tab.
      blocks: result.blocks,
      debug: {
        via: result.via || result.source,
        blocks: result.blocks.length,
        chars,
        headings,
        postCount: result.postCount || null,
      },
    });
    await store.setSnippets(item.id, snippets);
    return { ok: true, kind, snippets: snippets.length, chars, headings };
  }

  root.AD.extract = {
    extractInto, extractArticle, extractThread,
    blocksFromArticle, dropTitleEcho, findProseFallback,
  };
})(globalThis);
