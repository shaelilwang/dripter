/* Dripter — main.js
 *
 * Entry point for the content script bundle. Decides what this particular
 * x.com page is for, and answers messages from the popup and the worker.
 */
;(function (root) {
  root.DRIP = root.DRIP || {};
  const { sel, store, collect, extract, inject } = root.DRIP;

  const path = () => location.pathname;
  // /i/history lists what you've opened recently and carries the same post
  // markup, so it works as a harvest source alongside saved bookmarks.
  const isBookmarks = () => /^\/i\/(bookmarks|history)/.test(path());
  const isHome = () => /^\/(home)?$/.test(path());

  /* ---------------------------------------------------------------- */
  /* messages                                                          */
  /* ---------------------------------------------------------------- */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;

    // Every handler is async, so we always keep the channel open and reply
    // through the same shape: { ok, ...payload } or { ok: false, error }.
    const reply = (p) => Promise.resolve(p)
      .then((v) => sendResponse(Object.assign({ ok: true }, v)))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));

    switch (msg.type) {
      case 'DRIP_PING':
        reply({ path: path(), onBookmarks: isBookmarks(), onHome: isHome() });
        return true;

      case 'DRIP_DOCTOR':
        reply({ report: sel.doctor() });
        return true;

      case 'DRIP_HARVEST':
        if (!isBookmarks()) {
          reply(Promise.reject(new Error(
            'Open x.com/i/bookmarks (or /i/history) first — harvest reads the ' +
            'list that page renders.')));
          return true;
        }
        reply(collect.harvestAll((p) => {
          try { chrome.runtime.sendMessage({ type: 'DRIP_HARVEST_PROGRESS', ...p }); }
          catch (_) {}
        }));
        return true;

      case 'DRIP_DIAGNOSE':
        reply(extract.diagnose().then((report) => ({ report })));
        return true;

      /*
       * Re-read the article in this very tab and store the result.
       *
       * The background fetch job exists for doing the whole library, but
       * when one article is wrong it is a lot of machinery to fix the page
       * you are already looking at — and it resets everything else's
       * reading position on the way.
       */
      case 'DRIP_EXTRACT_HERE':
        reply((async () => {
          const m = path().match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/);
          if (!m) throw new Error('Open the article itself first (an x.com/…/status/… page).');
          const [, handle, id] = m;

          let item = await store.getItem(id);
          if (!item) {
            // Works even on an article that was never harvested.
            item = await store.upsertItem({
              id,
              url: location.origin + location.pathname,
              statusUrl: location.origin + location.pathname,
              kind: 'article',
              likely: true,
              author: { name: '', handle },
            });
          }

          const res = await extract.extractInto(item);
          const after = await store.getItem(id);
          const outcome = {
            extracted: res,
            title: after && after.title,
            snippets: after ? (after.snippets || []).length : 0,
            state: after && after.state,
          };

          // Reading a page takes ~15s, and the popup closes the moment you
          // click anything — which loses the reply and makes a run that
          // worked look like one that did nothing. Leave the result behind.
          await store.set({
            lastReread: Object.assign({ id, at: Date.now() }, outcome),
          });
          return outcome;
        })());
        return true;

      case 'DRIP_EXTRACT':
        reply(extract.extractInto(msg.item));
        return true;

      case 'DRIP_RESWEEP':
        reply(inject.sweep().then(() => ({})));
        return true;

      case 'DRIP_CLEAR_CARDS':
        inject.clearCards();
        reply({});
        return true;

      default:
        return;
    }
  });

  /* ---------------------------------------------------------------- */
  /* boot                                                              */
  /* ---------------------------------------------------------------- */

  // Tell the worker we're alive. If it opened this tab to extract something,
  // it will message us back with the item.
  try {
    chrome.runtime.sendMessage({ type: 'DRIP_CONTENT_READY', path: path() });
  } catch (_) {}

  let injectStarted = false;
  const startInject = () => {
    if (injectStarted) return;
    injectStarted = true;
    inject.start();
  };

  if (isHome()) {
    startInject();
  } else {
    // x.com is a SPA — it can navigate into /home without a reload.
    root.DRIP.dom.onRouteChange((p) => {
      if (/^\/(home)?$/.test(p)) startInject();
    });
  }

  // Opportunistic harvest: if you're just browsing your bookmarks normally,
  // pick up whatever scrolls past without you asking.
  if (isBookmarks()) {
    (async () => {
      const settings = await store.getSettings();
      const tick = () => collect.harvestVisible(settings).catch(() => {});
      root.DRIP.life.guardedInterval(tick, 1500);
      tick();
    })();
  }
})(globalThis);
