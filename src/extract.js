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

  const tidy = (s) => (s || '').replace(/[ \t]+/g, ' ').trim();

  /**
   * Walk the rendered Article body into ordered heading/para blocks.
   *
   * The semantic path is only taken when the semantic elements actually
   * account for most of the text. X emits headings as real <h2> but body
   * paragraphs as plain <div>, so "three or more semantic elements" was
   * satisfied by the headings alone — and every div of prose was thrown away.
   * The reader got an article of nothing but headings.
   *
   * When coverage is poor we fall back to innerText, which respects rendered
   * layout, and recover the heading structure by matching lines against the
   * text of the real <h1>-<h6> elements.
   */
  function blocksFromArticle(bodyEl) {
    const blocks = [];
    const push = (type, text) => {
      const t = tidy(text);
      if (t) blocks.push({ type, text: t });
    };

    const fullText = (bodyEl.innerText || '').trim();
    const totalChars = fullText.length;

    const semantic = Array.from(
      bodyEl.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,blockquote')
    ).filter((el) => !el.parentElement.closest('p,li,blockquote'));

    const semanticChars = semantic
      .reduce((n, el) => n + tidy(el.innerText).length, 0);

    // Trust the markup only if it carries the article, not just its titles.
    if (semantic.length >= 3 && totalChars > 0 &&
        semanticChars >= totalChars * 0.6) {
      for (const el of semantic) {
        const tag = el.tagName.toLowerCase();
        const text = tidy(el.innerText);
        if (!text) continue;
        // Verbatim. No injected bullet glyphs or quote marks: a list item
        // that didn't start with "•" in the source must not start with one
        // here. Line breaks alone carry the structure.
        if (/^h[1-6]$/.test(tag)) push('heading', text);
        else push('para', text);
      }
      return blocks;
    }

    // Fall back to rendered text. richText() would emit a newline after every
    // DIV and shatter prose into one fragment per div; innerText breaks where
    // the browser actually breaks.
    const headingTexts = new Set(
      Array.from(bodyEl.querySelectorAll('h1,h2,h3,h4,h5,h6'))
        .map((el) => tidy(el.innerText))
        .filter(Boolean)
    );

    for (const line of fullText.split(/\n+/)) {
      const t = tidy(line);
      if (!t) continue;
      // Keep the heading structure the markup did give us.
      push(headingTexts.has(t) ? 'heading' : 'para', t);
    }
    return blocks;
  }

  /** Did we actually come away with the article, or just its furniture? */
  function assessBlocks(blocks, bodyEl) {
    const chars = blocks.reduce((n, b) => n + b.text.length, 0);
    const headings = blocks.filter((b) => b.type === 'heading').length;
    const pageChars = bodyEl ? (bodyEl.innerText || '').trim().length : 0;
    return {
      blocks: blocks.length,
      chars,
      headings,
      headingRatio: blocks.length ? headings / blocks.length : 0,
      coverage: pageChars ? Math.min(1, chars / pageChars) : null,
    };
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

    /*
     * Read the title BEFORE scrolling.
     *
     * The header is above the body, and X unmounts it once you scroll away —
     * so by the time we reach the bottom there is nothing left to read it
     * from. That is why "Diagnose", which measures the page as-is, kept
     * reporting the correct title while extraction, which rides to the
     * bottom first, kept storing the author's name instead. Same page, same
     * code, different scroll position.
     */
    const earlyTitle = articleTitleFor(bodyEl, []);

    // Articles lazy-render as you scroll; ride to the bottom before reading.
    await dom.autoScroll({ maxSteps: 25, settleMs: 500 });
    await dom.waitForStable(() => dom.richText(bodyEl).length, { quietMs: 800 });

    let blocks = blocksFromArticle(bodyEl);
    const lateTitle = articleTitleFor(bodyEl, blocks);
    const title = earlyTitle || lateTitle;
    blocks = dropTitleEcho(blocks, title);

    return {
      title,
      titleVia: earlyTitle ? 'before-scroll' : (lateTitle ? 'after-scroll' : 'none'),
      blocks,
      source: 'article',
      via,
      quality: assessBlocks(blocks, bodyEl),
    };
  }

  /**
   * Work out what the article is actually called.
   *
   * The `articleTitle` selectors are guesses and mostly miss, and when they
   * do the card fell back to the author's name — so every card was headed
   * "Josh Rosen" while the real title sat unused in the body as its first
   * heading. Read it from the body instead, which is where it demonstrably
   * is.
   *
   * Deliberately scoped to the article body and never searched page-wide.
   * The `articleTitle` list ends in a bare `h1`, and a document-wide query
   * for that happily returns whatever X put in its own page chrome — which
   * would title the article with something from the surrounding UI. Better
   * no title than a confidently wrong one; the harvested name stands in.
   */
  function articleTitleFor(bodyEl, blocks) {
    // Confirmed testid first. It lives outside the body, so it has to be
    // found page-wide — safe because the name can only be an article title.
    const exact = sel.q('articleTitleExact');
    if (exact) {
      const t = tidy(exact.innerText).split('\n')[0];
      if (t) return t;
    }

    const inBody = sel.q('articleTitle', bodyEl);
    if (inBody) {
      const t = tidy(inBody.innerText).split('\n')[0];
      if (t) return t;
    }

    // The heading the article opens with is its title, when it has one.
    if (blocks.length && blocks[0].type === 'heading' && blocks[0].text) {
      return blocks[0].text;
    }

    return titleAboveBody(bodyEl);
  }

  // X's own furniture around an article. None of these is a title.
  const CHROME_LABELS = new Set([
    'article', 'conversation', 'post', 'thread', 'home', 'explore', 'search',
    'notifications', 'messages', 'bookmarks', 'profile', 'communities',
    'lists', 'premium', 'more', 'grok', 'jobs', 'verified', 'replies',
  ]);

  /**
   * Find the article's title in the region above its body.
   *
   * On a live Article page the title is NOT a heading: the only h1/h2 outside
   * the rich-text body are X's chrome ("Article", "Conversation"), and the h2s
   * inside it are the article's own section headings. So there is nothing to
   * match on by tag or testid — but the title is, reliably, the largest text
   * rendered above the body.
   *
   * Restricted to what precedes the body inside the main column, so section
   * headings and reply furniture can't be mistaken for it, and gated on a
   * font size well above body copy so that finding nothing yields nothing
   * rather than a confident guess.
   */
  function titleAboveBody(bodyEl) {
    const scope = sel.q('primaryColumn');
    if (!scope || !bodyEl || !scope.contains(bodyEl)) return null;

    const candidates = [];
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT);
    let node;

    while ((node = walker.nextNode())) {
      if (node === bodyEl) break;          // everything after this is body/replies
      if (node.contains(bodyEl)) continue; // ancestors wrap the whole page

      const text = tidy(node.innerText);
      if (!text || text.length < 8 || text.length > 200) continue;
      if (text.includes('\n')) continue;              // a title is one line
      if (CHROME_LABELS.has(text.toLowerCase())) continue;

      const size = parseFloat(getComputedStyle(node).fontSize) || 0;
      if (size < 20) continue;                        // body copy and smaller

      candidates.push({ text, size, depth: node.querySelectorAll('*').length });
    }

    if (!candidates.length) return null;

    // Biggest type wins; among equals prefer the tightest element wrapping the
    // text, so we get the title itself rather than a container around it.
    candidates.sort((a, b) => (b.size - a.size) || (a.depth - b.depth));
    return candidates[0].text;
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

    return {
      title: threadTitleFrom(parts[0]),
      blocks,
      source: 'thread',
      postCount: parts.length,
    };
  }

  /**
   * A thread has no title markup, but its opening line is nearly always the
   * hook that tells you what it's about — a far better card heading than the
   * author's name, which is what the fallback used to produce.
   *
   * Only the first line, and only if it reads like an opener: a list item or
   * a full paragraph is the thread's content, not its name.
   */
  function threadTitleFrom(firstPost) {
    const line = String(firstPost || '').split('\n')[0].trim();
    if (!line) return null;
    if (line.length > 120) return null;
    if (/^[•\-*–—]\s|^\d+[.)]\s/.test(line)) return null;
    return line;
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

    /*
     * Check we actually came away with the article before storing it.
     *
     * An extraction can "succeed" and still be useless: pulling only the <h2>
     * headings and none of the <div> prose produced articles that were
     * nothing but titles. Refuse those rather than filling the feed with
     * headings, and say why in the library so it can be retried.
     */
    const q = result.quality || {};
    if (result.source === 'article' && q.blocks >= 3 && q.headingRatio > 0.8) {
      await store.updateItem(item.id, {
        state: 'failed', fetchedAt: Date.now(),
        debug: Object.assign({ via: result.via }, q),
      });
      return {
        ok: false,
        reason: `grabbed ${q.headings}/${q.blocks} blocks as headings and almost no prose`,
      };
    }
    if (result.source === 'article' && q.coverage != null && q.coverage < 0.4) {
      await store.updateItem(item.id, {
        state: 'failed', fetchedAt: Date.now(),
        debug: Object.assign({ via: result.via }, q),
      });
      return {
        ok: false,
        reason: `only captured ${Math.round(q.coverage * 100)}% of the page's text`,
      };
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

    const snippets = chunker.chunk(result.blocks, {
      maxCards: settings.maxCards,
      maxChars: settings.maxChars,
    });
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
      debug: Object.assign({
        via: result.via || result.source,
        source: result.source,
        titleVia: result.titleVia || null,
        blocks: result.blocks.length,
        chars,
        headings,
        postCount: result.postCount || null,
      }, result.quality || {}),
    });
    await store.setSnippets(item.id, snippets);
    return { ok: true, kind, snippets: snippets.length, chars, headings };
  }

  /**
   * Run the extraction pipeline read-only and report every stage.
   *
   * When a card comes out wrong, the cause could be the body selector, the
   * block walk, the title lookup, or a stale stored item — and from the
   * outside all four look identical. This says which, on the page the reader
   * is actually looking at, using the real code paths rather than a guess
   * about them.
   */
  async function diagnose() {
    const report = {
      // Stamped so a pasted report says which build produced it. Without
      // this, a cached report from an older build is indistinguishable from
      // a fresh one, and the wrong thing gets debugged.
      extensionVersion: chrome.runtime.getManifest().version,
      url: location.href,
      path: location.pathname,
      at: new Date().toISOString(),
    };

    let bodyEl = sel.q('articleBody');
    report.namedBodySelector = bodyEl ? sel.pick('articleBody') : null;
    if (!bodyEl) {
      bodyEl = findProseFallback(1200);
      report.usedStructuralFallback = !!bodyEl;
    }
    report.bodyFound = !!bodyEl;

    if (bodyEl) {
      report.body = {
        tag: bodyEl.tagName.toLowerCase(),
        testid: bodyEl.getAttribute('data-testid') || null,
        chars: (bodyEl.innerText || '').trim().length,
      };
    }

    // Every heading in the main column, and whether it sits inside the body
    // we picked. A title living outside it is the whole problem.
    const scope = sel.q('primaryColumn') || document.body;
    report.headings = Array.from(scope.querySelectorAll('h1,h2,h3,h4,h5,h6'))
      .slice(0, 15)
      .map((h) => ({
        tag: h.tagName.toLowerCase(),
        text: tidy(h.innerText).slice(0, 120),
        insideBody: !!(bodyEl && bodyEl.contains(h)),
      }));

    if (bodyEl) {
      const blocks = blocksFromArticle(bodyEl);
      report.blockCount = blocks.length;
      report.firstBlocks = blocks.slice(0, 6).map((b) => ({
        type: b.type || 'para',
        text: b.text.slice(0, 90),
      }));
      report.quality = assessBlocks(blocks, bodyEl);
      report.titleSelectorExact = sel.pick('articleTitleExact');
      report.titleSelectorInBody = sel.pick('articleTitle', bodyEl);
      report.titleChosen = articleTitleFor(bodyEl, blocks);
      report.titleAboveBody = titleAboveBody(bodyEl);

      // Every large line above the body, so a wrong pick is visible.
      const scope2 = sel.q('primaryColumn');
      if (scope2 && scope2.contains(bodyEl)) {
        const cands = [];
        const w = document.createTreeWalker(scope2, NodeFilter.SHOW_ELEMENT);
        let n;
        while ((n = w.nextNode())) {
          if (n === bodyEl) break;
          if (n.contains(bodyEl)) continue;
          const t = tidy(n.innerText);
          if (!t || t.length < 8 || t.length > 200 || t.includes('\n')) continue;
          const size = parseFloat(getComputedStyle(n).fontSize) || 0;
          if (size < 16) continue;
          cands.push({ text: t.slice(0, 90), size, tag: n.tagName.toLowerCase(),
            testid: n.getAttribute('data-testid') || null });
        }
        report.titleCandidates = cands.sort((a, b) => b.size - a.size).slice(0, 8);
      }
    }

    // And what we already hold for this page, which is what the card shows.
    const m = location.pathname.match(/\/status\/(\d+)/);
    if (m) {
      const item = await root.AD.store.getItem(m[1]);
      report.storedItem = item ? {
        id: item.id,
        title: item.title,
        kind: item.kind,
        state: item.state,
        snippetCount: (item.snippets || []).length,
        cursor: item.cursor,
        storedBlocks: (item.blocks || []).length,
        firstSnippetHeading: (item.snippets || [])[0]
          ? item.snippets[0].heading : null,
        firstSnippet: (item.snippets || [])[0]
          ? item.snippets[0].text.slice(0, 90) : null,
        debug: item.debug || null,
      } : 'nothing stored for this status id';
    }

    return report;
  }

  root.AD.extract = {
    extractInto, extractArticle, extractThread,
    blocksFromArticle, dropTitleEcho, findProseFallback, assessBlocks,
    articleTitleFor, threadTitleFrom, titleAboveBody, diagnose,
  };
})(globalThis);
