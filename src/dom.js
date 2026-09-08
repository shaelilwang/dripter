/* Article Drip — dom.js — small helpers shared by the content scripts. */
;(function (root) {
  root.AD = root.AD || {};

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Poll until fn() returns something truthy, or time out. */
  async function waitFor(fn, { timeout = 10000, interval = 150 } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      let v;
      try { v = fn(); } catch (_) { v = null; }
      if (v) return v;
      if (Date.now() > deadline) return null;
      await sleep(interval);
    }
  }

  /** Wait until the page stops growing, i.e. lazy content has settled. */
  async function waitForStable(measure, { quietMs = 900, timeout = 8000 } = {}) {
    const deadline = Date.now() + timeout;
    let last = -1;
    let lastChange = Date.now();
    for (;;) {
      const v = measure();
      if (v !== last) { last = v; lastChange = Date.now(); }
      if (Date.now() - lastChange >= quietMs) return last;
      if (Date.now() > deadline) return last;
      await sleep(150);
    }
  }

  /**
   * Scroll to the bottom repeatedly until nothing new loads.
   * onStep runs after each scroll so callers can harvest incrementally.
   */
  async function autoScroll({ maxSteps = 60, settleMs = 800, onStep } = {}) {
    let lastHeight = -1;
    let stagnant = 0;
    for (let step = 0; step < maxSteps; step++) {
      if (onStep) {
        try { await onStep(step); } catch (e) { console.warn('[article-drip] onStep', e); }
      }
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(settleMs);
      const h = document.documentElement.scrollHeight;
      if (h === lastHeight) {
        if (++stagnant >= 3) break;
      } else {
        stagnant = 0;
        lastHeight = h;
      }
    }
    if (onStep) {
      try { await onStep(-1); } catch (_) {}
    }
  }

  /** Visible text of an element with X's inline emoji images restored. */
  function richText(el) {
    if (!el) return '';
    let out = '';
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) { out += node.nodeValue; return; }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName;
      if (tag === 'IMG') { out += node.getAttribute('alt') || ''; return; }
      if (tag === 'BR') { out += '\n'; return; }
      for (const c of node.childNodes) walk(c);
      if (/^(P|DIV|LI|H1|H2|H3|H4|H5|H6|BLOCKQUOTE)$/.test(tag)) out += '\n';
    };
    walk(el);
    return out;
  }

  function isOnScreen(el) {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < (window.innerHeight || 0);
  }

  /** Stable non-cryptographic hash, used to give each article a color. */
  function hashCode(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return Math.abs(h >>> 0);
  }

  /** Watch SPA navigation — x.com never does a full page load. */
  function onRouteChange(cb) {
    let last = location.pathname + location.search;
    const fire = () => {
      const now = location.pathname + location.search;
      if (now !== last) { last = now; cb(now); }
    };
    for (const m of ['pushState', 'replaceState']) {
      const orig = history[m];
      history[m] = function () {
        const r = orig.apply(this, arguments);
        setTimeout(fire, 0);
        return r;
      };
    }
    window.addEventListener('popstate', () => setTimeout(fire, 0));
    setInterval(fire, 700); // belt and braces; X sometimes swaps views silently
  }

  root.AD.dom = {
    sleep, waitFor, waitForStable, autoScroll,
    richText, isOnScreen, hashCode, onRouteChange,
  };
})(globalThis);
