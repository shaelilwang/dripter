/* Article Drip — main.js
 *
 * Entry point for the content script bundle. Decides what this particular
 * x.com page is for, and answers messages from the popup and the worker.
 */
;(function (root) {
  root.AD = root.AD || {};
  const { sel, store, collect, extract, inject } = root.AD;

  const path = () => location.pathname;
  const isBookmarks = () => /^\/i\/bookmarks/.test(path());
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
      case 'AD_PING':
        reply({ path: path(), onBookmarks: isBookmarks(), onHome: isHome() });
        return true;

      case 'AD_DOCTOR':
        reply({ report: sel.doctor() });
        return true;

      case 'AD_HARVEST':
        if (!isBookmarks()) {
          reply(Promise.reject(new Error('Not on the bookmarks page.')));
          return true;
        }
        reply(collect.harvestAll((p) => {
          try { chrome.runtime.sendMessage({ type: 'AD_HARVEST_PROGRESS', ...p }); }
          catch (_) {}
        }));
        return true;

      case 'AD_EXTRACT':
        reply(extract.extractInto(msg.item));
        return true;

      case 'AD_RESWEEP':
        reply(inject.sweep().then(() => ({})));
        return true;

      case 'AD_CLEAR_CARDS':
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
    chrome.runtime.sendMessage({ type: 'AD_CONTENT_READY', path: path() });
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
    root.AD.dom.onRouteChange((p) => {
      if (/^\/(home)?$/.test(p)) startInject();
    });
  }

  // Opportunistic harvest: if you're just browsing your bookmarks normally,
  // pick up whatever scrolls past without you asking.
  if (isBookmarks()) {
    (async () => {
      const settings = await store.getSettings();
      const tick = () => collect.harvestVisible(settings).catch(() => {});
      setInterval(tick, 1500);
      tick();
    })();
  }
})(globalThis);
