/* Article Drip — card.js
 *
 * Builds the snippet card and owns its interactions. Cards are plain DOM in
 * the page (not shadow roots) so they inherit X's font stack and feel native;
 * every class is `ad-`-prefixed to stay out of X's way.
 */
;(function (root) {
  root.AD = root.AD || {};
  const { dom, sel, store, life } = root.AD;

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

  /** WCAG relative luminance, used for both dark-detection and contrast. */
  function relLuminance({ r, g, b }) {
    const f = (c) => {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }

  function contrastRatio(a, b) {
    const l1 = relLuminance(a);
    const l2 = relLuminance(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }

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

    const dark = relLuminance(bg) < 0.4;

    // Read the foreground off real post text where possible; fall back to
    // <body>, whose colour on x.com often doesn't follow the active theme.
    const fgProbe = sel.q('themeProbeFg');
    let fg = parseRGB(fgProbe && getComputedStyle(fgProbe).color) ||
      parseRGB(getComputedStyle(document.body).color);

    // Whatever we sampled, it has to be readable on the background we
    // sampled. Getting this wrong renders the card invisible, so never take
    // the measurement on trust.
    const readable = dark
      ? { r: 231, g: 233, b: 234, a: 1 }
      : { r: 15, g: 20, b: 25, a: 1 };
    if (!fg || contrastRatio(fg, bg) < 4.5) fg = readable;

    const css = document.documentElement.style;
    css.setProperty('--ad-bg', `rgb(${bg.r},${bg.g},${bg.b})`);
    css.setProperty('--ad-fg', `rgb(${fg.r},${fg.g},${fg.b})`);
    css.setProperty('--ad-muted', dark ? 'rgb(139,152,165)' : 'rgb(83,100,113)');
    css.setProperty('--ad-border', dark ? 'rgb(47,51,54)' : 'rgb(207,217,222)');
    css.setProperty('--ad-accent', 'rgb(29,155,240)');
    css.setProperty('--ad-lightness', dark ? '62%' : '42%');
    return { dark, bg, fg, contrast: contrastRatio(fg, bg) };
  }

  // X re-themes without navigating, and its own colours can land after we
  // first sample. Re-check cheaply, but not on every mutation.
  let lastTheme = 0;
  function refreshTheme(force) {
    const now = Date.now();
    if (!force && now - lastTheme < 1000) return null;
    lastTheme = now;
    return applyTheme();
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

  /* ---------------------------------------------------------------- */
  /* "Show more" clamping                                              */
  /* ---------------------------------------------------------------- */

  /**
   * Reveal "Show more" only when the text is actually being cut off.
   *
   * Whether it overflows depends on wrapped height, which isn't known until
   * the card is in the document and laid out. A one-shot requestAnimationFrame
   * after render was unreliable — it can land while the node is still
   * detached, measure 0 against 0, and hide the control on a card that really
   * is clamped. A ResizeObserver fires when the element first gets a size and
   * again on every reflow, so the answer stays correct.
   */
  let clampObserver = null;

  function updateClamp(card) {
    if (!card) return;
    const textEl = card.querySelector('.ad-text');
    const moreEl = card.querySelector('.ad-more');
    if (!textEl || !moreEl) return;

    if (card.classList.contains('is-empty')) { moreEl.style.display = 'none'; return; }
    if (card.classList.contains('is-expanded')) { moreEl.style.display = ''; return; }

    const clamped = textEl.scrollHeight > textEl.clientHeight + 2;
    moreEl.style.display = clamped ? '' : 'none';
  }

  function watchClamp(textEl) {
    if (typeof ResizeObserver === 'undefined') return;
    if (!clampObserver) {
      clampObserver = new ResizeObserver((entries) => {
        for (const e of entries) updateClamp(e.target.closest('.ad-card'));
      });
      life.onTeardown(() => { clampObserver.disconnect(); clampObserver = null; });
    }
    clampObserver.observe(textEl);
  }

  /**
   * Lay the snippet out as real paragraphs.
   *
   * A single pre-wrap text node renders a blank line between paragraphs at
   * exactly one line-height, which reads as a solid wall on anything longer
   * than a tweet. Splitting on blank lines and giving each paragraph its own
   * block lets CSS space them properly — and keeps the author's own spacing,
   * since the blank lines are where they put them. Single newlines stay
   * inside a paragraph (pre-wrap), so a run of list lines stays tight.
   */
  function renderBody(textEl, text) {
    textEl.textContent = '';
    const paras = String(text == null ? '' : text).split(/\n{2,}/);
    for (const para of paras) {
      if (!para.trim()) continue;
      const node = el('p', 'ad-p');
      node.textContent = para;
      textEl.appendChild(node);
    }
  }

  function build() {
    const card = el('div', 'ad-card');
    card.setAttribute('data-ad-card', '1');
    card.setAttribute('role', 'article');

    // Left gutter avatar, same 40px as X's own, so the text column lines up
    // with every other post in the feed.
    card.appendChild(el('div', 'ad-avatar'));

    const body = el('div', 'ad-body');

    // The article's name leads, on its own line and at heading size — it is
    // the thing you need to recognise at a glance while scrolling past.
    // Author and position sit under it as secondary detail.
    const head = el('div', 'ad-head');
    head.appendChild(el('div', 'ad-title'));
    const sub = el('div', 'ad-sub');
    sub.appendChild(el('span', 'ad-meta'));
    sub.appendChild(el('span', 'ad-dot', '·'));
    sub.appendChild(el('span', 'ad-badge'));
    head.appendChild(sub);
    body.appendChild(head);

    body.appendChild(el('div', 'ad-heading'));
    const textEl = el('div', 'ad-text');
    body.appendChild(textEl);
    watchClamp(textEl);

    const more = el('button', 'ad-more', 'Show more');
    more.type = 'button';
    more.setAttribute('data-ad-act', 'more');
    body.appendChild(more);

    body.appendChild(el('div', 'ad-note'));

    const foot = el('div', 'ad-foot');
    const prog = el('div', 'ad-progress');
    prog.appendChild(document.createElement('i'));
    foot.appendChild(prog);

    const acts = el('div', 'ad-actions');
    for (const [act, label, title] of [
      ['back', '‹ Back', 'Go back to the previous part'],
      ['later', 'Later', 'Hold this article back; it resumes right here'],
      ['done', 'Done', 'Finish this article and stop showing it'],
      ['open', 'Open', 'Open the original on X'],
      ['next', 'Next ›', 'Mark this read and show the next part'],
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
    renderBody(textEl, p.snippet ? p.snippet.text : '');
    textEl.classList.toggle('is-heading', !!(p.snippet && p.snippet.kind === 'heading'));

    // Section heading rides above the prose it belongs to.
    const headEl = card.querySelector('.ad-heading');
    const sectionHeading = p.snippet && p.snippet.heading;
    headEl.textContent = sectionHeading || '';
    headEl.style.display = sectionHeading ? '' : 'none';

    // Long snippets clamp behind "Show more", the way X truncates its own
    // long posts.
    card.classList.remove('is-expanded');
    card.querySelector('.ad-more').textContent = 'Show more';
    updateClamp(card);

    const title = p.title || 'Untitled';
    card.querySelector('.ad-title').textContent = title;
    card.querySelector('.ad-title').title = title;

    const initial = (title.match(/[A-Za-z0-9]/) || ['·'])[0].toUpperCase();
    card.querySelector('.ad-avatar').textContent = isEmpty ? '·' : initial;

    const handle = p.author && p.author.handle ? '@' + p.author.handle : '';
    card.querySelector('.ad-meta').textContent = isEmpty ? '' : handle;
    card.querySelector('.ad-badge').textContent =
      isEmpty ? '' : `drip ${p.index + 1}/${p.total}`;

    // Hide the separator dots when there's nothing between them.
    for (const d of card.querySelectorAll('.ad-dot')) {
      d.style.display = isEmpty ? 'none' : '';
    }

    for (const b of card.querySelectorAll('.ad-actions button')) {
      b.style.display = isEmpty ? 'none' : '';
    }
    const backBtn = card.querySelector('[data-ad-act="back"]');
    if (backBtn) backBtn.disabled = isEmpty || !p.index;

    const noteEl = card.querySelector('.ad-note');
    if (noteEl) { noteEl.textContent = ''; noteEl.style.display = 'none'; }

    const pct = p.total ? Math.round(((p.index + 1) / p.total) * 100) : 0;
    card.querySelector('.ad-progress > i').style.width = pct + '%';
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

  /**
   * Which articles already have a card on screen.
   *
   * Read from the DOM rather than tracked in a variable: it can't go stale
   * when X recycles the timeline, and it needs no reset.
   */
  function displayedItems(except) {
    const seen = new Set();
    for (const c of document.querySelectorAll('[data-ad-card]')) {
      if (c === except) continue;
      if (c.dataset.adItem) seen.add(c.dataset.adItem);
    }
    return seen;
  }

  /**
   * Next snippet for a NEW card: always from an article not already on
   * screen, so the feed never shows two pieces of the same piece of writing.
   *
   * The previous version handed successive indices of one article to every
   * insertion point, which is why finishing a card and scrolling on landed
   * you in "3/24" of the same article — and why pressing Next could jump
   * several snippets at once, since it had to step past the indices the
   * other visible cards had already reserved.
   */
  const takeNext = (except) => store.peekNext(displayedItems(except));

  const releaseAll = () => {};

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

  /** Move this card on to a different article. */
  async function repaint(card) {
    card.classList.add('is-advancing');
    render(card, (await takeNext(card)) || EMPTY);
    card.classList.remove('is-advancing');
  }

  /**
   * Redraw this card at the given article's current position. Used by Back,
   * Skip and Next, which all stay within the piece you're reading rather
   * than throwing you into a different one mid-thought.
   */
  async function paintItem(card, itemId) {
    const payload = await store.peekItem(itemId);
    if (!payload) return repaint(card);   // article finished
    card.classList.add('is-advancing');
    render(card, payload);
    card.classList.remove('is-advancing');
  }

  /** Say something on the card without disturbing what it's showing. */
  let noteTimer = null;
  function note(card, text) {
    const el = card.querySelector('.ad-note');
    if (!el) return;
    el.textContent = text;
    el.style.display = '';
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
      el.textContent = '';
      el.style.display = 'none';
    }, 3200);
  }

  async function onClick(ev) {
    const btn = ev.target.closest('button[data-ad-act]');
    if (!btn) return;
    if (!life.check()) return;
    ev.preventDefault();
    ev.stopPropagation(); // don't let X treat this as a click on the feed

    const card = btn.closest('.ad-card');
    const id = card.dataset.adItem;
    const act = btn.getAttribute('data-ad-act');

    if (act === 'more') {
      const expanded = card.classList.toggle('is-expanded');
      btn.textContent = expanded ? 'Show less' : 'Show more';
      updateClamp(card);
      return;
    }

    if (act === 'open') {
      const item = id ? await store.getItem(id) : null;
      if (item) window.open(item.url || item.statusUrl, '_blank', 'noopener');
      return;
    }

    if (act === 'next') {
      await count(card);
      if (id) await paintItem(card, id);
      else await repaint(card);
      return;
    }

    if (act === 'back') {
      if (!id) return;
      await store.stepBack(id);
      await paintItem(card, id);
      return;
    }

    if (act === 'later') {
      // Deliberately does NOT flip the card. Holding an article back and
      // having it instantly replaced by a different one reads like the
      // button did something else entirely; and leaving the snippet in place
      // means it's still here if you change your mind.
      if (!id) return;
      await store.snooze(id);
      card.dataset.adCounted = '1';
      note(card, 'OK — showing this again later, right where you left it.');
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

  /*
   * Scrolling is what separates "read" from "happened to be rendered".
   *
   * On a page load, cards get injected a few posts down — often inside the
   * opening viewport. Visibility alone therefore counted them as read within
   * a second of the page appearing, so every refresh silently advanced the
   * article. Refreshing a few times burned through snippets nobody had seen.
   *
   * A card only becomes eligible once the reader has scrolled AFTER it was
   * placed. The tick is compared per card, so a card that appears mid-scroll
   * still has to wait for the next scroll of its own.
   */
  let scrollTick = 0;
  let scrollBound = false;
  let dwellMs = 900;
  const visible = new Set();

  /** Has the reader scrolled since this card was placed? */
  const scrolledSincePlacement = (card) =>
    Number(card.dataset.adTick || 0) !== scrollTick;

  function clearTimer(card) {
    const t = timers.get(card);
    if (t) { clearTimeout(t); timers.delete(card); }
  }

  function maybeStartDwell(card) {
    if (timers.has(card)) return;
    if (!scrolledSincePlacement(card)) return;
    timers.set(card, setTimeout(() => {
      timers.delete(card);
      // Re-check on fire: a pending timer must not outlive its conditions.
      if (visible.has(card) && scrolledSincePlacement(card)) count(card);
    }, dwellMs));
  }

  function bindScroll() {
    if (scrollBound) return;
    scrollBound = true;
    const onScroll = () => {
      scrollTick++;
      // IntersectionObserver only fires when intersection CHANGES. A card
      // that stays on screen while you scroll past neighbouring posts would
      // never be re-evaluated, so nudge the currently-visible ones here or
      // they could never become eligible at all.
      for (const card of visible) maybeStartDwell(card);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    life.onTeardown(() => window.removeEventListener('scroll', onScroll));
  }

  async function startDwellTracking() {
    const settings = await store.getSettings();
    if (!settings.markReadOnView || observer) return;
    dwellMs = settings.dwellMs;
    bindScroll();

    observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const card = e.target;
        if (e.isIntersecting && e.intersectionRatio >= 0.6) {
          visible.add(card);
          maybeStartDwell(card);
        } else {
          visible.delete(card);
          clearTimer(card);
        }
      }
    }, { threshold: [0, 0.6, 1] });

    life.onTeardown(() => {
      observer.disconnect();
      observer = null;
      visible.clear();
    });
  }

  function track(card) {
    bindScroll();
    // Stamp the scroll position this card was born at, so it can't be counted
    // as read merely for having been rendered into the opening viewport.
    card.dataset.adTick = String(scrollTick);
    if (observer) observer.observe(card);
  }

  root.AD.card = {
    create, render, applyTheme, startDwellTracking, track,
    takeNext, releaseAll, updateClamp, refreshTheme, contrastRatio,
    paintItem, displayedItems, EMPTY,
    // Test seams for tests/harness.html.
    _scroll: () => { scrollTick++; for (const c of visible) maybeStartDwell(c); },
    _eligible: (card) => scrolledSincePlacement(card),
    _seeCard: (card, isVisible) => {
      if (isVisible) { visible.add(card); maybeStartDwell(card); }
      else { visible.delete(card); clearTimer(card); }
    },
  };
})(globalThis);
