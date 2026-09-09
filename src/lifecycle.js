/* Dripter — lifecycle.js
 *
 * Handles the content script outliving the extension that injected it.
 *
 * Reloading or updating an extension does NOT reload content scripts already
 * running in open tabs. Those scripts keep going, but their bridge back to the
 * extension is severed: every chrome.* call throws "Extension context
 * invalidated". Left alone, an orphan keeps observing mutations, keeps trying
 * to sweep, fills the console with errors, and leaves dead cards in the feed
 * whose buttons silently do nothing.
 *
 * So: detect it, tear everything down once, and tell the reader plainly that
 * the tab needs a reload.
 */
;(function (root) {
  root.DRIP = root.DRIP || {};

  const cleanups = [];
  let dead = false;

  /** chrome.runtime.id goes undefined the moment the context is severed. */
  function isAlive() {
    if (dead) return false;
    try {
      return !!(chrome && chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  function onTeardown(fn) {
    if (typeof fn === 'function') cleanups.push(fn);
  }

  function teardown(reason) {
    if (dead) return;
    dead = true;
    // Run every registered cleanup, even if one of them throws.
    for (const fn of cleanups.splice(0)) {
      try { fn(); } catch (_) {}
    }
    console.info(
      `[dripter] stopped: ${reason}. Reload this tab to start again.`
    );
  }

  /**
   * Call at the top of anything that touches chrome.* on a timer or an event.
   * Returns false once the context is gone, having torn down exactly once.
   */
  function check() {
    if (dead) return false;
    if (isAlive()) return true;
    teardown('the extension was reloaded or updated');
    return false;
  }

  /** Does this error mean the bridge is gone, rather than a real fault? */
  function isContextError(e) {
    return /Extension context invalidated|Receiving end does not exist|message port closed|Cannot access a chrome/i
      .test(String((e && e.message) || e));
  }

  /** Wrap a repeating callback so it stops itself when the context dies. */
  function guardedInterval(fn, ms) {
    const id = setInterval(() => {
      if (!check()) return;
      try { fn(); } catch (e) {
        if (isContextError(e)) teardown('the extension was reloaded or updated');
        else throw e;
      }
    }, ms);
    onTeardown(() => clearInterval(id));
    return id;
  }

  root.DRIP.life = {
    isAlive, onTeardown, teardown, check, isContextError, guardedInterval,
    get dead() { return dead; },
    // Test seam. Teardown is deliberately one-shot and irreversible in a real
    // tab — the only honest recovery there is a reload. The harness needs to
    // exercise it and then carry on, so it can undo the flag explicitly.
    _reset: () => { dead = false; cleanups.length = 0; },
  };
})(globalThis);
