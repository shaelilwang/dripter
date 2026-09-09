/* Dripter — inject.js
 *
 * Slides snippet cards into the rendered home timeline.
 *
 * The hard part is that X virtualizes the feed: cells are created, destroyed
 * and recycled constantly as you scroll. So we never track "how many posts
 * have gone by" incrementally — that drifts the moment React churns. Instead
 * every pass is a full idempotent SWEEP of the current children:
 *
 *   walk cells in DOM order, counting since the last card we see;
 *   when the count reaches N and no card follows, insert one.
 *
 * Run it twice with no scrolling and nothing changes. Run it after React has
 * torn half the list out and it repairs itself.
 */
;(function (root) {
  root.DRIP = root.DRIP || {};
  const { sel, dom, store, card, life } = root.DRIP;

  const CARD_SELECTOR = '[data-drip-card]';

  let settings = null;
  let sweeping = false;
  let dirty = false;
  let observer = null;
  let layoutMode = null; // 'flow' | 'absolute'

  /* ---------------------------------------------------------------- */
  /* placement                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * X has shipped both a normal-flow timeline and an absolutely-positioned
   * virtualized one. Inserting a sibling into the latter would render at the
   * wrong offset, so detect which we're in and place accordingly.
   */
  function detectLayout(cell) {
    if (layoutMode) return layoutMode;
    const pos = getComputedStyle(cell).position;
    layoutMode = pos === 'absolute' ? 'absolute' : 'flow';
    return layoutMode;
  }

  function placeCard(cell, node) {
    if (detectLayout(cell) === 'absolute') {
      // Grow the cell rather than adding a sibling X hasn't accounted for.
      cell.appendChild(node);
    } else {
      cell.insertAdjacentElement('afterend', node);
    }
  }

  const isCard = (n) => n.nodeType === 1 && n.matches && n.matches(CARD_SELECTOR);
  const holdsCard = (n) => n.nodeType === 1 && n.querySelector &&
    !!n.querySelector(CARD_SELECTOR);

  /* ---------------------------------------------------------------- */
  /* the sweep                                                         */
  /* ---------------------------------------------------------------- */

  async function sweep() {
    if (sweeping) { dirty = true; return; }
    if (!life.check()) return;
    sweeping = true;

    try {
      if (!settings) settings = await store.getSettings();
      if (!settings.enabled) return;
      if (!isHome()) return;

      // Keep the card colours in step with X's live theme.
      card.refreshTheme();

      const timeline = sel.q('timelineRoot');
      if (!timeline) return;

      const cells = sel.qa('cell', timeline);
      if (!cells.length) return;

      const every = Math.max(1, settings.everyNPosts | 0);
      const pending = [];
      let since = 0;

      for (const cell of cells) {
        // In 'absolute' mode the card lives inside the cell; in 'flow' mode
        // it's the next sibling. Either counts as "a card is here".
        if (holdsCard(cell)) { since = 0; continue; }

        const after = cell.nextElementSibling;
        if (after && isCard(after)) { since = 0; continue; }

        since++;
        if (since >= every) { pending.push(cell); since = 0; }
      }

      if (!pending.length) return;

      // Insert one at a time so each gets a distinct snippet.
      for (const cell of pending) {
        if (!cell.isConnected) continue;
        const payload = await card.takeNext();  // excludes articles already on screen
        if (!payload) break; // queue exhausted
        const node = card.create(payload);
        stopObserving();
        placeCard(cell, node);
        startObserving();
        // Measure the clamp now the node is attached and can be laid out.
        // render() runs while it is still detached, where everything measures
        // zero, and the ResizeObserver alone has proved unreliable at
        // catching the transition into the document.
        card.updateClamp(node);
        card.track(node);
      }
    } catch (e) {
      // An orphaned content script (extension reloaded under us) would throw
      // here on every mutation forever. Stop once, quietly.
      if (life.isContextError(e)) life.teardown('the extension was reloaded');
      else console.warn('[dripter] sweep failed', e);
    } finally {
      sweeping = false;
      if (dirty) { dirty = false; setTimeout(sweep, 60); }
    }
  }

  /* ---------------------------------------------------------------- */
  /* wiring                                                            */
  /* ---------------------------------------------------------------- */

  let isHome = () => /^\/(home)?$/.test(location.pathname);

  let debounce = null;
  function schedule() {
    clearTimeout(debounce);
    debounce = setTimeout(sweep, 180);
  }

  function startObserving() {
    if (observer) return;
    observer = new MutationObserver((records) => {
      if (!life.check()) return;
      for (const r of records) {
        // Ignore mutations we caused ourselves.
        const ours = [...r.addedNodes, ...r.removedNodes].some(
          (n) => n.nodeType === 1 && (isCard(n) || holdsCard(n))
        );
        if (!ours) { schedule(); return; }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function stopObserving() {
    if (!observer) return;
    observer.disconnect();
    observer = null;
  }

  /**
   * Leave the cards in place but make it obvious they're inert, rather than
   * offering buttons that quietly do nothing.
   */
  function markCardsStale() {
    for (const n of document.querySelectorAll(CARD_SELECTOR)) {
      n.classList.add('is-stale');
      for (const b of n.querySelectorAll('button')) b.disabled = true;
      const badge = n.querySelector('.drip-badge');
      if (badge) badge.textContent = 'reload tab to resume';
    }
  }

  /** Drop every card we've placed — used when you toggle the drip off. */
  function clearCards() {
    for (const n of document.querySelectorAll(CARD_SELECTOR)) n.remove();
    card.releaseAll();
  }

  async function refreshSettings() {
    settings = await store.getSettings();
    if (!settings.enabled) { clearCards(); return; }
    // Picks up markReadOnView being switched on after start().
    await card.startDwellTracking();
    schedule();
  }

  async function start() {
    settings = await store.getSettings();
    card.applyTheme();
    await card.startDwellTracking();

    startObserving();
    schedule();

    dom.onRouteChange(() => {
      if (!isHome()) return;
      card.applyTheme();
      schedule();
    });

    // X's theme switch doesn't reload, so re-sample on visibility changes.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) { card.applyTheme(); schedule(); }
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      if (changes.settings) refreshSettings();
      else if (changes.items) schedule();
    });
  }

  // Registered at load rather than inside start(): if the extension is
  // reloaded before or during startup, the cards still need marking and the
  // observers still need dropping.
  life.onTeardown(() => {
    stopObserving();
    clearTimeout(debounce);
    markCardsStale();
  });

  root.DRIP.inject = {
    start, sweep, clearCards, refreshSettings,
    // Seams for tests/harness.html, which drives the sweep off-site.
    _setHomeCheck: (fn) => { isHome = fn; },
    _resetLayout: () => { layoutMode = null; },
    _reload: async () => { settings = await store.getSettings(); },
  };
})(globalThis);
