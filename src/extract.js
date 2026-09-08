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

  async function extractArticle() {
    const bodyEl = await dom.waitFor(() => {
      const el = sel.q('articleBody');
      return el && dom.richText(el).trim().length > 200 ? el : null;
    }, { timeout: 12000 });

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
  async function extractInto(item) {
    const settings = await root.AD.store.getSettings();
    let result = null;

    if (item.kind === 'article') {
      result = await extractArticle();
      // An Article link that didn't render an Article body: fall back to the
      // post itself rather than losing the bookmark entirely.
      if (!result) result = await extractThread(item.author && item.author.handle);
    } else {
      result = await extractThread(item.author && item.author.handle);
    }

    if (!result || !result.blocks.length) {
      await root.AD.store.updateItem(item.id, { state: 'failed', fetchedAt: Date.now() });
      return { ok: false, reason: 'no readable body found on the page' };
    }

    if (result.source === 'thread' &&
        item.kind === 'thread' &&
        result.postCount < settings.minThreadPosts) {
      await root.AD.store.updateItem(item.id, { state: 'failed', fetchedAt: Date.now() });
      return { ok: false, reason: `only ${result.postCount} posts — below your thread minimum` };
    }

    const snippets = chunker.chunk(result.blocks, { maxChars: settings.maxChars });
    if (!snippets.length) {
      await root.AD.store.updateItem(item.id, { state: 'failed', fetchedAt: Date.now() });
      return { ok: false, reason: 'body was empty after chunking' };
    }

    if (result.title && !item.title) {
      await root.AD.store.updateItem(item.id, { title: result.title });
    }
    await root.AD.store.setSnippets(item.id, snippets);
    return { ok: true, snippets: snippets.length };
  }

  root.AD.extract = { extractInto, extractArticle, extractThread, blocksFromArticle };
})(globalThis);
