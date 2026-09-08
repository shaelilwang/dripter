/* Article Drip — card.js
 *
 * Builds the snippet card and owns its interactions. Cards are plain DOM in
 * the page (not shadow roots) so they inherit X's font stack and feel native;
 * every class is `ad-`-prefixed to stay out of X's way.
 */
;(function (root) {
  root.AD = root.AD || {};
  const { dom, sel, store } = root.AD;

  /* ---------------------------------------------------------------- */
  /* theme sampling                                                    */
  /* ---------------------------------------------------------------- */

  function parseRGB(str) {
    const m = /rgba?\(([^)]+)\)/.exec(str || '');
    if (!m) return null;
    const p = m[1].split(',').map((s) => parseFloat(s));
    if (p.length < 3 || p.some(isNaN)) return null;
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }

  const luminance = ({ r, g, b }) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

  /**
   * Read X's current theme off the live page and publish it as CSS vars.
   * Cheaper and far more robust than trying to detect which of the three
   * themes is active by name.
   */
  function applyTheme() {
    const probe = sel.q('themeProbeBg') || document.body;
    let bg = parseRGB(getComputedStyle(probe).backgroundColor);

    // Transparent containers: walk up until we find a painted ancestor.
    let node = probe;
    while ((!bg || bg.a === 0) && node && node !== document.documentElement) {
      node = node.parentElement;
      if (node) bg = parseRGB(getComputedStyle(node).backgroundColor);
    }
    if (!bg || bg.a === 0) bg = { r: 255, g: 255, b: 255, a: 1 };

    const fg = parseRGB(getComputedStyle(document.body).color) ||
      { r: 15, g: 20, b: 25, a: 1 };
    const dark = luminance(bg) < 0.5;

    const css = document.documentElement.style;
    css.setProperty('--ad-bg', `rgb(${bg.r},${bg.g},${bg.b})`);
    css.setProperty('--ad-fg', `rgb(${fg.r},${fg.g},${fg.b})`);
    css.setProperty('--ad-muted', dark ? 'rgb(139,152,165)' : 'rgb(83,100,113)');
    css.setProperty('--ad-border', dark ? 'rgb(47,51,54)' : 'rgb(207,217,222)');
    css.setProperty('--ad-accent', 'rgb(29,155,240)');
    css.setProperty('--ad-lightness', dark ? '62%' : '42%');
    return { dark };
  }

  /* ---------------------------------------------------------------- */
  /* rendering                                                         */
  /* ---------------------------------------------------------------- */

  const EMPTY = {
    empty: true,
    title: 'Nothing left to drip',
    snippet: {
      text: 'You\'re caught up. Open Bookmarks and run a harvest to queue more.',
      kind: 'para',
    },
  };

  function hueFor(id) {
    return dom.hashCode(String(id || 'x')) % 360;
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function build() {
    const card = el('div', 'ad-card');
    card.setAttribute('data-ad-card', '1');
    card.setAttribute('role', 'article');

    card.appendChild(el('div', 'ad-rail'));

    const body = el('div', 'ad-body');

    const head = el('div', 'ad-head');
    head.appendChild(el('span', 'ad-pill', 'Drip'));
    head.appendChild(el('span', 'ad-title'));
    head.appendChild(el('span', 'ad-meta'));
    body.appendChild(head);

    body.appendChild(el('div', 'ad-text'));

    const prog = el('div', 'ad-progress');
    prog.appendChild(document.createElement('i'));
    body.appendChild(prog);

    const foot = el('div', 'ad-foot');
    foot.appendChild(el('span', 'ad-count'));
    const acts = el('div', 'ad-actions');
    for (const [act, label, title] of [
      ['later', 'Later', 'Skip to a different article'],
      ['done', 'Done', 'Stop dripping this article'],
      ['open', 'Open', 'Open the original on X'],
      ['next', 'Next ›', 'Mark read and load the next snippet here'],
    ]) {
      const b = el('button', null, label);
      b.type = 'button';
      b.setAttribute('data-ad-act', act);
      b.title = title;
      acts.appendChild(b);
    }
    foot.appendChild(acts);
    body.appendChild(foot);

    card.appendChild(body);
    card.addEventListener('click', onClick);
    return card;
  }

  /** Paint a payload from store.peekNext() into an existing card. */
  function render(card, payload) {
    const p = payload || EMPTY;
    const isEmpty = !!p.empty;

    card.classList.toggle('is-empty', isEmpty);
    card.style.setProperty('--ad-hue', hueFor(p.itemId || 'empty'));
    card.dataset.adItem = p.itemId || '';
    card.dataset.adIndex = p.index == null ? '' : String(p.index);
    card.dataset.adCounted = '0';

    const textEl = card.querySelector('.ad-text');
    textEl.textContent = p.snippet ? p.snippet.text : '';
    textEl.classList.toggle('is-heading', !!(p.snippet && p.snippet.kind === 'heading'));

    card.querySelector('.ad-title').textContent = p.title || 'Untitled';
    card.querySelector('.ad-title').title = p.title || '';

    const handle = p.author && p.author.handle ? '@' + p.author.handle : '';
    card.querySelector('.ad-meta').textContent =
      isEmpty ? '' : [handle, p.kind === 'thread' ? 'thread' : 'article']
        .filter(Boolean).join(' · ');

    const pct = p.total ? Math.round(((p.index + 1) / p.total) * 100) : 0;
    card.querySelector('.ad-progress > i').style.width = pct + '%';
    card.querySelector('.ad-count').textContent =
      isEmpty ? '' : `${p.index + 1} / ${p.total}`;

    for (const b of card.querySelectorAll('.ad-actions button')) {
      b.style.display = isEmpty ? 'none' : '';
    }
    card.setAttribute('aria-label',
      isEmpty ? 'Article Drip: queue empty'
              : `Article Drip snippet ${p.index + 1} of ${p.total} from ${p.title}`);
    return card;
  }

  function create(payload) {
    return render(build(), payload);
  }

  /* ---------------------------------------------------------------- */
  /* snippet hand-out                                                  */
  /* ---------------------------------------------------------------- */

  // Highest snippet index already put on screen for each article. Both the
  // injector (placing new cards) and "Next" (repainting one in place) draw
  // through here, so two cards can never show the same text at once.
  // Memory-only by design: a reload re-derives everything from the store.
  const handedOut = new Map();

  async function takeNext() {
    const p = await store.peekNext();
    if (!p) return null;

    const last = handedOut.get(p.itemId);
    if (last == null || p.index > last) {
      handedOut.set(p.itemId, p.index);
      return p;
    }

    // Already on screen — hand out the one after it.
    const item = await store.getItem(p.itemId);
    const idx = last + 1;
    if (!item || !item.snippets || idx >= item.snippets.length) return null;

    handedOut.set(p.itemId, idx);
    return {
      itemId: item.id,
      title: item.title,
      author: item.author,
      url: item.url,
      kind: item.kind,
      index: idx,
      total: item.snippets.length,
      snippet: item.snippets[idx],
    };
  }

  const releaseAll = () => handedOut.clear();

  /* ---------------------------------------------------------------- */
  /* interaction                                                       */
  /* ---------------------------------------------------------------- */

  /** Consume the snippet a card is showing, exactly once. */
  async function count(card) {
    if (card.dataset.adCounted === '1') return false;
    const id = card.dataset.adItem;
    const idx = parseInt(card.dataset.adIndex, 10);
    if (!id || isNaN(idx)) return false;
    card.dataset.adCounted = '1';
    await store.consume(id, idx);
    return true;
  }

  async function repaint(card) {
    card.classList.add('is-advancing');
    const next = await takeNext();
    render(card, next || EMPTY);
    card.classList.remove('is-advancing');
  }

  async function onClick(ev) {
    const btn = ev.target.closest('button[data-ad-act]');
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation(); // don't let X treat this as a click on the feed

    const card = btn.closest('.ad-card');
    const id = card.dataset.adItem;
    const act = btn.getAttribute('data-ad-act');

    if (act === 'open') {
      const item = id ? await store.getItem(id) : null;
      if (item) window.open(item.url || item.statusUrl, '_blank', 'noopener');
      return;
    }

    if (act === 'next') {
      await count(card);
      await repaint(card);
      return;
    }

    if (act === 'later') {
      // Push this article to the back without consuming the snippet.
      if (id) await store.updateItem(id, { lastShownAt: Date.now() });
      await repaint(card);
      return;
    }

    if (act === 'done') {
      if (id) await store.markDone(id);
      await repaint(card);
      return;
    }
  }

  /* ---------------------------------------------------------------- */
  /* mark-as-read on dwell                                             */
  /* ---------------------------------------------------------------- */

  let observer = null;
  const timers = new WeakMap();

  async function startDwellTracking() {
    const settings = await store.getSettings();
    if (!settings.markReadOnView || observer) return;

    observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const card = e.target;
        if (e.isIntersecting && e.intersectionRatio >= 0.6) {
          if (timers.has(card)) continue;
          timers.set(card, setTimeout(() => {
            timers.delete(card);
            count(card);
          }, settings.dwellMs));
        } else {
          const t = timers.get(card);
          if (t) { clearTimeout(t); timers.delete(card); }
        }
      }
    }, { threshold: [0, 0.6, 1] });
  }

  function track(card) {
    if (observer) observer.observe(card);
  }

  root.AD.card = {
    create, render, applyTheme, startDwellTracking, track,
    takeNext, releaseAll, EMPTY,
  };
})(globalThis);
