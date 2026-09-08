/* Article Drip — collect.js
 *
 * Harvests the bookmarks page (x.com/i/bookmarks) into the item store.
 * Reads only what's already rendered in your logged-in session — no API,
 * no tokens, no network calls of our own.
 *
 * We record metadata here and classify each bookmark as an Article, a thread
 * or a plain post. Bodies are fetched later by extract.js.
 */
;(function (root) {
  root.AD = root.AD || {};
  const { sel, dom } = root.AD;

  const STATUS_RE = /\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/;
  const ARTICLE_RE = /\/i\/article\/([A-Za-z0-9_-]+)/;

  /** Pull the canonical permalink out of a rendered post. */
  function permalinkOf(tweetEl) {
    // The timestamp anchor is the reliable one; other /status/ links in a post
    // can point at quoted posts or media.
    const timeEl = tweetEl.querySelector('time');
    let a = timeEl && timeEl.closest('a[href*="/status/"]');
    if (!a) {
      const all = sel.qa('statusLink', tweetEl);
      a = all.find((x) => STATUS_RE.test(x.getAttribute('href') || ''));
    }
    if (!a) return null;
    const href = a.getAttribute('href') || '';
    const m = href.match(STATUS_RE);
    if (!m) return null;
    return { handle: m[1], id: m[2], url: `https://x.com/${m[1]}/status/${m[2]}` };
  }

  /**
   * Display name and handle. The handle is only ever read from the DOM as a
   * fallback — harvestVisible overrides it with the one from the permalink,
   * which is canonical and can't be broken by markup changes.
   */
  function authorOf(tweetEl) {
    const block = sel.q('userName', tweetEl);
    const raw = block ? dom.richText(block) : '';
    const lines = raw.split('\n').map((s) => s.trim()).filter(Boolean);

    const handleLine = lines.find((l) => l.startsWith('@')) || '';
    // X nests name and handle in spans, which richText runs together; if the
    // line split found no handle, dig it out of the flattened text.
    const inline = handleLine || (raw.match(/@([A-Za-z0-9_]{1,15})/) || [])[0] || '';

    const nameLine = lines.find(
      (l) => !l.startsWith('@') && l !== '·' && !/^\d/.test(l)
    ) || '';

    return {
      name: nameLine.replace(/@[A-Za-z0-9_]{1,15}.*$/, '').trim(),
      handle: inline.replace(/^@/, ''),
    };
  }

  /** Does this post link out to a native X Article? */
  function articleLinkOf(tweetEl) {
    for (const a of sel.qa('articleLink', tweetEl)) {
      const href = a.getAttribute('href') || '';
      const m = href.match(ARTICLE_RE);
      if (m) {
        return {
          id: m[1],
          url: href.startsWith('http') ? href : `https://x.com${href}`,
        };
      }
    }
    return null;
  }

  /** Heuristics for "this is a thread, not a one-off post". */
  function looksLikeThread(tweetEl, text) {
    const t = dom.richText(tweetEl).toLowerCase();
    if (/show this thread|show more replies/.test(t)) return true;
    // Self-numbered threads: "1/", "1/12", "🧵"
    if (/(^|\s)1\s*\/\s*\d*(\s|$)/.test(text)) return true;
    if (text.includes('🧵')) return true;
    return false;
  }

  /**
   * A post can be a native Article with no Article href on it at all — X
   * surfaces those under a plain /handle/status/N permalink, distinguishable
   * only by markup like data-testid="article-cover-image". So presence of the
   * marker counts as much as a link does.
   */
  const hasArticleMarker = (tweetEl) => !!sel.q('articleMarker', tweetEl);

  function classify(tweetEl, text, articleLink, settings) {
    if (articleLink || hasArticleMarker(tweetEl)) {
      return settings.includeArticles ? 'article' : null;
    }
    if (looksLikeThread(tweetEl, text)) return settings.includeThreads ? 'thread' : null;
    return 'post';
  }

  /** Read every bookmark currently rendered and upsert it. */
  async function harvestVisible(settings) {
    const seen = [];
    for (const tweetEl of sel.qa('tweet')) {
      if (tweetEl.dataset.adSeen === '1') continue;

      const link = permalinkOf(tweetEl);
      if (!link) continue;

      const textEl = sel.q('tweetText', tweetEl);
      const text = textEl ? dom.richText(textEl).replace(/\s+/g, ' ').trim() : '';
      const articleLink = articleLinkOf(tweetEl);
      const kind = classify(tweetEl, text, articleLink, settings);
      if (!kind) { tweetEl.dataset.adSeen = '1'; continue; }

      // Deliberately no length filter here. X renders a native Article in the
      // bookmarks list as an ordinary, often short, post — the body only
      // exists once you click through. Dropping short posts at this stage
      // silently threw away the exact thing we're here to collect.
      //
      // `likely` records whether this looks worth the round trip, so the
      // fetch step can default to the promising ones without us having
      // permanently discarded the rest.
      const likely = kind === 'article' || kind === 'thread' || text.length >= 400;

      const author = authorOf(tweetEl);
      // The permalink is the source of truth for the handle.
      author.handle = link.handle || author.handle;

      const title =
        (articleLink && articleTitleFromCard(tweetEl)) ||
        firstLineAsTitle(text) ||
        `${author.name || '@' + link.handle}${kind === 'thread' ? ' — thread' : ''}`;

      await root.AD.store.upsertItem({
        id: link.id,
        url: kind === 'article' && articleLink ? articleLink.url : link.url,
        statusUrl: link.url,
        kind,
        likely,
        title,
        author,
        preview: text.slice(0, 200),
      });

      tweetEl.dataset.adSeen = '1';
      seen.push(link.id);
    }
    return seen;
  }

  function articleTitleFromCard(tweetEl) {
    const a = sel.q('articleLink', tweetEl);
    if (!a) return null;
    const txt = dom.richText(a).split('\n').map((s) => s.trim()).filter(Boolean);
    // Longest line in the card is almost always the headline.
    txt.sort((x, y) => y.length - x.length);
    return txt[0] && txt[0].length > 8 ? txt[0] : null;
  }

  function firstLineAsTitle(text) {
    if (!text) return null;
    const first = text.split(/(?<=[.!?])\s/)[0] || text;
    return first.length > 70 ? first.slice(0, 67).trimEnd() + '…' : first;
  }

  /**
   * Full harvest: scroll the bookmarks page to the end, collecting as we go.
   * onProgress({found, step}) lets the popup show a live count.
   */
  async function harvestAll(onProgress) {
    const settings = await root.AD.store.getSettings();
    const found = new Set();

    const timeline = await dom.waitFor(() => sel.q('timelineRoot'), { timeout: 8000 });
    if (!timeline) {
      throw new Error(
        "Couldn't find the bookmarks timeline. Make sure you're on x.com/i/bookmarks " +
        'and the list has loaded, then run Selector Doctor.'
      );
    }

    const startY = window.scrollY;
    await dom.autoScroll({
      maxSteps: 80,
      settleMs: 750,
      onStep: async (step) => {
        for (const id of await harvestVisible(settings)) found.add(id);
        if (onProgress) onProgress({ found: found.size, step });
      },
    });
    window.scrollTo(0, startY);

    await root.AD.store.bumpStats({ lastHarvest: Date.now() });
    return { found: found.size };
  }

  root.AD.collect = { harvestAll, harvestVisible, permalinkOf, authorOf };
})(globalThis);
