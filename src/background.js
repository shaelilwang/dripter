/* Dripter — background.js (MV3 service worker)
 *
 * Owns the one job the content scripts can't do alone: visiting each pending
 * bookmark to pull its body.
 *
 * Tabs are opened in a separate unfocused window rather than as background
 * tabs in your current one. That matters: Chrome throttles rAF and defers
 * rendering work in hidden tabs, and X lazy-renders long articles — a hidden
 * tab reliably yields a truncated body. An unfocused but visible window
 * renders normally and never steals your focus.
 */
importScripts('/src/store.js');

const DRIP = globalThis.DRIP;

const EXTRACT_TIMEOUT_MS = 45000;
const READY_TIMEOUT_MS = 20000;
const PAUSE_BETWEEN_MS = 900;

let job = null;         // { total, done, ok, failed, current, cancelled }
let workWindowId = null;
let workTabId = null;
let readyWaiter = null; // resolve fn for the current DRIP_CONTENT_READY handshake
let keepAlive = null;

/* ------------------------------------------------------------------ */
/* keepalive                                                           */
/* ------------------------------------------------------------------ */

// MV3 workers get suspended after ~30s idle, which would strand a long run.
// Touching a chrome API on an interval is the supported way to stay resident.
function startKeepAlive() {
  if (keepAlive) return;
  keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
}
function stopKeepAlive() {
  clearInterval(keepAlive);
  keepAlive = null;
}

/* ------------------------------------------------------------------ */
/* work window                                                         */
/* ------------------------------------------------------------------ */

async function ensureWorkWindow() {
  if (workWindowId != null) {
    try {
      await chrome.windows.get(workWindowId);
      return;
    } catch (_) {
      workWindowId = null;
      workTabId = null;
    }
  }
  const win = await chrome.windows.create({
    url: 'about:blank',
    focused: false,
    width: 1100,
    height: 900,
    type: 'normal',
  });
  workWindowId = win.id;
  workTabId = win.tabs && win.tabs[0] ? win.tabs[0].id : null;
}

async function closeWorkWindow() {
  if (workWindowId == null) return;
  try { await chrome.windows.remove(workWindowId); } catch (_) {}
  workWindowId = null;
  workTabId = null;
}

/* ------------------------------------------------------------------ */
/* one item                                                            */
/* ------------------------------------------------------------------ */

function waitForReady(tabId) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { readyWaiter = null; resolve(false); }, READY_TIMEOUT_MS);
    readyWaiter = (id) => {
      if (id !== tabId) return false;
      clearTimeout(timer);
      readyWaiter = null;
      resolve(true);
      return true;
    };
  });
}

function sendWithTimeout(tabId, message, ms) {
  return Promise.race([
    chrome.tabs.sendMessage(tabId, message),
    new Promise((_, rej) => setTimeout(() => rej(new Error('extraction timed out')), ms)),
  ]);
}

async function processItem(item) {
  await ensureWorkWindow();
  if (workTabId == null) throw new Error('could not open a working tab');

  const ready = waitForReady(workTabId);
  await chrome.tabs.update(workTabId, { url: item.url || item.statusUrl });

  if (!(await ready)) {
    await DRIP.store.updateItem(item.id, { state: 'failed', fetchedAt: Date.now() });
    return { ok: false, reason: 'page never signalled ready' };
  }

  // Let X settle past its initial skeleton render.
  await new Promise((r) => setTimeout(r, 1200));

  try {
    const res = await sendWithTimeout(workTabId, { type: 'DRIP_EXTRACT', item }, EXTRACT_TIMEOUT_MS);
    return res && res.ok ? res : { ok: false, reason: (res && (res.reason || res.error)) || 'unknown' };
  } catch (e) {
    await DRIP.store.updateItem(item.id, { state: 'failed', fetchedAt: Date.now() });
    return { ok: false, reason: String(e.message || e) };
  }
}

/* ------------------------------------------------------------------ */
/* the run                                                             */
/* ------------------------------------------------------------------ */

async function runFetchBodies() {
  if (job && !job.finished) return job;

  const settings = await DRIP.store.getSettings();
  const items = Object.values(await DRIP.store.getItems())
    // `likely !== false` keeps items harvested before the flag existed.
    .filter((i) => i.state === 'pending' &&
      (settings.fetchScope === 'all' || i.likely !== false))
    .sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));

  job = { total: items.length, done: 0, ok: 0, failed: 0, current: null, finished: false, cancelled: false };
  if (!items.length) { job.finished = true; return job; }

  startKeepAlive();

  (async () => {
    for (const item of items) {
      if (job.cancelled) break;
      job.current = item.title || item.id;
      const res = await processItem(item);
      job.done++;
      if (res.ok) job.ok++; else job.failed++;
      job.lastReason = res.ok ? null : res.reason;
      await new Promise((r) => setTimeout(r, PAUSE_BETWEEN_MS));
    }
    job.current = null;
    job.finished = true;
    await closeWorkWindow();
    stopKeepAlive();
  })();

  return job;
}

/* ------------------------------------------------------------------ */
/* messages                                                            */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'DRIP_CONTENT_READY') {
    const id = sender.tab && sender.tab.id;
    if (readyWaiter && id != null) readyWaiter(id);
    return;
  }

  if (msg.type === 'DRIP_FETCH_BODIES') {
    runFetchBodies()
      .then((j) => sendResponse({ ok: true, job: j }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }

  if (msg.type === 'DRIP_JOB_STATUS') {
    sendResponse({ ok: true, job });
    return true;
  }

  if (msg.type === 'DRIP_JOB_CANCEL') {
    if (job) job.cancelled = true;
    closeWorkWindow();
    stopKeepAlive();
    sendResponse({ ok: true });
    return true;
  }
});

chrome.windows.onRemoved.addListener((id) => {
  if (id === workWindowId) { workWindowId = null; workTabId = null; }
});

chrome.runtime.onInstalled.addListener(async () => {
  // Materialize defaults so the options page has something to show.
  await DRIP.store.setSettings({});
});
