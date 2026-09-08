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
    articleLink: [
      'a[href*="/i/article/"]',
      'a[href*="/article/"]',
    ],

    // The rendered body of a native Article, on the Article page itself.
    articleBody: [
      '[data-testid="twitterArticleRichTextView"]',
      '[data-testid="articleNoteTweet"]',
      '[data-testid="longformRichTextView"]',
      'article[role="article"] [data-testid="tweetText"]',
    ],

    // Article title on the Article page.
    articleTitle: [
      '[data-testid="twitterArticleTitle"]',
      '[data-testid="articleTitle"]',
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
    themeProbeAccent: [
      '[data-testid="SideNav_NewTweet_Button"]',
      'a[href="/compose/post"]',
      '[role="button"][style*="rgb(29, 155, 240)"]',
    ],
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
      report.push({ key, ok: total > 0, variants });
    }
    return {
      url: location.href,
      path: location.pathname,
      at: new Date().toISOString(),
      results: report,
      brokenKeys: report.filter((r) => !r.ok).map((r) => r.key),
    };
  }

  root.AD.SEL = SEL;
  root.AD.sel = { pick, q, qa, doctor };
})(globalThis);
