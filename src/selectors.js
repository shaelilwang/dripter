/* Article Drip — selectors.js
 *
 * EVERY x.com DOM selector lives here. Nothing else in this codebase should
 * contain a raw x.com selector string. When X reshuffles their markup (they
 * will), this is the only file you need to touch.
 *
 * Each entry is an ORDERED list. First one that matches wins, so put the
 * precise/stable selector first and progressively looser fallbacks after it.
 *
 * To find out what's currently broken: open x.com, click the extension icon,
 * hit "Selector Doctor". It runs every selector against the live page and
 * tells you which ones return nothing.
 */
;(function (root) {
  root.AD = root.AD || {};

  const SEL = {
    /* ---- timeline / feed structure ---- */

    // The scrolling column that holds feed items.
    timelineRoot: [
      '[aria-label^="Timeline: Your Home Timeline"]',
      '[aria-label^="Timeline:"]',
      '[data-testid="primaryColumn"] section',
      'main[role="main"] section',
    ],

    // One wrapper per feed item. This is what we insert our cards between.
    cell: [
      'div[data-testid="cellInnerDiv"]',
    ],

    // A single post.
    tweet: [
      'article[data-testid="tweet"]',
      'article[role="article"]',
    ],

    // The text body of a post.
    tweetText: [
      'div[data-testid="tweetText"]',
      'div[data-testid="tweetText"] span',
    ],

    // Display-name + @handle block inside a post.
    userName: [
      'div[data-testid="User-Name"]',
      'div[data-testid="UserName"]',
    ],

    // Permalink anchor (the one wrapping the timestamp).
    statusLink: [
      'a[href*="/status/"]:has(time)',
      'a[href*="/status/"]',
    ],

    // "Show this thread" affordance — marks a post as part of a thread.
    threadHint: [
      'a[href*="/status/"][role="link"] span',
    ],

    /* ---- native X Articles ---- */

    // Link into a native long-form Article, wherever it appears.
    // Often absent: a live bookmarks/history page showed Article markup with
    // no /i/article/ href anywhere, so treat this as a bonus, not a test.
    articleLink: [
      'a[href*="/i/article/"]',
      'a[href*="/article/"]',
    ],

    // Presence-only proof that a post IS a native Article, for when there is
    // no distinguishing href. 'article-cover-image' is confirmed live markup;
    // the wildcard catches whatever X renames it to next.
    articleMarker: [
      '[data-testid="article-cover-image"]',
      '[data-testid*="article" i]',
    ],

    // The rendered body of a native Article, on the Article page itself.
    // twitterArticleRichTextView is CONFIRMED against a live Article page:
    // 11.5k characters, 99.5% coverage. Keep it first.
    //
    // Deliberately NO generic tweetText fallback: it matched any ordinary
    // post, which made the Doctor report a false green and let
    // extractArticle() mistake a random post for an article body. When these
    // all miss, extract.js falls through to thread extraction on purpose.
    articleBody: [
      '[data-testid="twitterArticleRichTextView"]',
      '[data-testid="articleNoteTweet"]',
      '[data-testid="longformRichTextView"]',
    ],

    /*
     * Article title, by a testid specific enough to search the whole page.
     *
     * CONFIRMED live: data-testid="twitter-article-title" — hyphenated, while
     * the body is camelCase (twitterArticleRichTextView). X mixes both
     * conventions, so guessing the casing from the other one is how this was
     * missed for so long. The wildcard catches either style if they rename it.
     *
     * The title sits OUTSIDE the rich-text body, so this has to be looked up
     * page-wide — which is only safe because these names can't match anything
     * but an article title.
     */
    articleTitleExact: [
      '[data-testid="twitter-article-title"]',
      '[data-testid="twitterArticleTitle"]',
      '[data-testid*="article-title" i]',
      '[data-testid*="articletitle" i]',
    ],

    /*
     * Looser title candidates. Ends in a bare `h1`, so this one may ONLY be
     * queried scoped to the article body — page-wide it returns X's own
     * chrome heading ("Conversation").
     */
    articleTitle: [
      '[data-testid="twitter-article-title"]',
      '[data-testid="twitterArticleTitle"]',
      'h1[role="heading"]',
      'h1',
    ],

    /* ---- misc chrome ---- */

    primaryColumn: [
      '[data-testid="primaryColumn"]',
    ],

    // Used only to sample the live theme colors.
    themeProbeBg: [
      '[data-testid="primaryColumn"]',
      'main[role="main"]',
      'body',
    ],
    // Sample the foreground from actual post text: <body>'s colour on x.com
    // is often the light-theme default even in Dim or Lights-out, which
    // rendered our cards with near-black text on a black background.
    themeProbeFg: [
      'div[data-testid="tweetText"]',
      'article[data-testid="tweet"] div[dir="auto"]',
      '[data-testid="primaryColumn"]',
    ],
    themeProbeAccent: [
      '[data-testid="SideNav_NewTweet_Button"]',
      'a[href="/compose/post"]',
      '[role="button"][style*="rgb(29, 155, 240)"]',
    ],
  };

  /**
   * Where each key is expected to resolve, and which ones may legitimately
   * find nothing anywhere.
   *
   * Without this the Doctor flags an Article selector as broken while you're
   * standing on the timeline, which is exactly where it is *supposed* to find
   * nothing — a red warning that means nothing trains you to ignore red
   * warnings that do.
   */
  const META = {
    timelineRoot:     { pages: /^\/(home)?$|^\/i\// },
    cell:             { pages: /^\/(home)?$|^\/i\// },
    articleBody:      { pages: /\/status\/|\/article\// , note: 'Article pages only' },
    articleTitle:     { pages: /\/status\/|\/article\// , note: 'Article pages only' },
    articleTitleExact:{ optional: true, note: 'only on a native Article page' },
    articleLink:      { optional: true, note: 'X usually omits it; articleMarker covers detection' },
    articleMarker:    { optional: true, note: 'only present on a native Article' },
    threadHint:       { optional: true },
    themeProbeAccent: { optional: true },
    themeProbeFg:     { optional: true },
  };

  /** Resolve a selector key to the first selector string that matches. */
  function pick(key, scope) {
    const list = SEL[key];
    if (!list) throw new Error(`[article-drip] unknown selector key: ${key}`);
    const ctx = scope || document;
    for (const s of list) {
      try {
        if (ctx.querySelector(s)) return s;
      } catch (_) {
        /* :has() etc. can throw on old engines — just skip */
      }
    }
    return null;
  }

  /** First matching element for a selector key. */
  function q(key, scope) {
    const list = SEL[key];
    if (!list) throw new Error(`[article-drip] unknown selector key: ${key}`);
    const ctx = scope || document;
    for (const s of list) {
      try {
        const el = ctx.querySelector(s);
        if (el) return el;
      } catch (_) {}
    }
    return null;
  }

  /** All matching elements for the FIRST selector variant that hits. */
  function qa(key, scope) {
    const list = SEL[key];
    if (!list) throw new Error(`[article-drip] unknown selector key: ${key}`);
    const ctx = scope || document;
    for (const s of list) {
      try {
        const els = ctx.querySelectorAll(s);
        if (els.length) return Array.from(els);
      } catch (_) {}
    }
    return [];
  }

  /**
   * Describe what's ACTUALLY on this page, independent of our selectors.
   *
   * A selector miss is ambiguous on its own: the selector may be wrong, or
   * the thing it looks for may simply not be here. This answers the second
   * question directly — what link shapes, testids and content lengths exist —
   * so a fix can be based on the real DOM rather than a guess about it.
   */
  function census() {
    const tweets = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));

    const normalize = (h) => String(h || '')
      .replace(/^https?:\/\/(x|twitter)\.com/, '')
      .replace(/\/status\/\d+/, '/status/N')
      .replace(/\/\d{6,}/g, '/N')
      .replace(/[?#].*$/, '');

    const linkShapes = {};
    const outbound = new Set();
    const textLengths = [];
    let withCard = 0;
    let withThreadHint = 0;

    for (const t of tweets) {
      const body = t.querySelector('[data-testid="tweetText"]');
      textLengths.push(body ? body.innerText.length : 0);
      if (/show this thread/i.test(t.innerText)) withThreadHint++;
      if (t.querySelector('[data-testid^="card."]')) withCard++;

      for (const a of t.querySelectorAll('a[href]')) {
        const href = a.getAttribute('href') || '';
        const key = normalize(href);
        linkShapes[key] = (linkShapes[key] || 0) + 1;
        if (/^https?:\/\//.test(href) && !/(^|\/\/)(www\.)?(x|twitter)\.com/.test(href)) {
          outbound.add(href.slice(0, 120));
        }
      }
    }

    // Any testid mentioning "article", with enough context to act on it.
    // Knowing the name isn't enough -- we need to know whether it sits inside
    // a post (so we can classify that post) and what it links to (so we can
    // reach the body). A page can carry Article markup and no Article href.
    const articleish = Array.from(document.querySelectorAll('[data-testid]'))
      .filter((e) => /artic/i.test(e.getAttribute('data-testid')))
      .slice(0, 20)
      .map((e) => {
        const host = e.closest('article[data-testid="tweet"]');
        const link = (host || document).querySelector('a[href*="/status/"], a[href*="/article/"]');
        return {
          testid: e.getAttribute('data-testid'),
          insideTweet: !!host,
          nearestHref: link ? normalize(link.getAttribute('href')) : null,
        };
      });

    // Links anywhere on the page, not just inside posts -- an Article link
    // living outside the tweet element would be invisible to the scan above.
    const pageWide = {};
    for (const a of document.querySelectorAll('a[href]')) {
      const key = normalize(a.getAttribute('href'));
      if (/\/article|\/i\//.test(key)) pageWide[key] = (pageWide[key] || 0) + 1;
    }

    return {
      posts: tweets.length,
      withCard,
      withThreadHint,
      longestTexts: textLengths.sort((a, b) => b - a).slice(0, 8),
      longPosts: textLengths.filter((n) => n >= 400).length,
      articleish,
      articleMarkers: document.querySelectorAll('[data-testid="article-cover-image"]').length,
      outbound: Array.from(outbound).slice(0, 10),
      linkShapes: Object.entries(linkShapes)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([shape, n]) => ({ shape, n })),
      pageWideSpecialLinks: Object.entries(pageWide)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([shape, n]) => ({ shape, n })),
    };
  }

  /**
   * Run every selector against the current page and report hits/misses.
   * This is what the "Selector Doctor" button surfaces.
   */
  function doctor() {
    const report = [];
    for (const key of Object.keys(SEL)) {
      const variants = SEL[key].map((s) => {
        let n = 0;
        let error = null;
        try {
          n = document.querySelectorAll(s).length;
        } catch (e) {
          error = String(e.message || e);
        }
        return { selector: s, count: n, error };
      });
      const total = variants.reduce((a, v) => a + v.count, 0);
      const meta = META[key] || {};
      const relevant = !meta.optional &&
        (!meta.pages || meta.pages.test(location.pathname));
      report.push({
        key, ok: total > 0, variants,
        optional: !!meta.optional,
        note: meta.note || null,
        // A miss only matters on a page where this key should have resolved.
        problem: total === 0 && relevant,
      });
    }
    return {
      extensionVersion: chrome.runtime.getManifest().version,
      url: location.href,
      path: location.pathname,
      at: new Date().toISOString(),
      results: report,
      brokenKeys: report.filter((r) => !r.ok).map((r) => r.key),
      problemKeys: report.filter((r) => r.problem).map((r) => r.key),
      benignKeys: report.filter((r) => !r.ok && !r.problem).map((r) => r.key),
      census: census(),
    };
  }

  root.AD.SEL = SEL;
  root.AD.sel = { pick, q, qa, doctor, census };
})(globalThis);
