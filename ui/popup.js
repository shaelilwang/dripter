/* Dripter — popup.js */
const store = globalThis.DRIP.store;

const $ = (id) => document.getElementById(id);
const BOOKMARKS_URL = 'https://x.com/i/bookmarks';
// /i/history renders the same post markup, so it harvests just as well.
const HARVEST_RE = /x\.com\/i\/(bookmarks|history)/;

let jobPoll = null;

function say(text, kind) {
  const box = $('msg');
  if (!text) { box.innerHTML = ''; return; }
  box.innerHTML = '';
  const n = document.createElement('div');
  n.className = 'notice' + (kind ? ' ' + kind : '');
  n.textContent = text;
  box.appendChild(n);
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

/** Talk to the content script; returns null if it isn't there. */
async function askTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (_) {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

async function refresh() {
  const [counts, stats, settings, next] = await Promise.all([
    store.counts(), store.getStats(), store.getSettings(), store.peekNext(),
  ]);

  $('c-left').textContent = counts.snippetsLeft;
  $('c-ready').textContent = counts.ready + counts.reading;
  $('c-pending').textContent = counts.pending;
  $('c-read').textContent = stats.snippetsRead;
  $('enabled').checked = !!settings.enabled;

  const box = $('upnext');
  box.textContent = '';
  if (!next) {
    box.className = 'panel muted';
    box.textContent = counts.fetchable
      ? `${counts.fetchable} bookmark${counts.fetchable === 1 ? '' : 's'} still need bodies — run "Fetch article bodies".`
      : counts.pending
        ? `${counts.pending} bookmark${counts.pending === 1 ? '' : 's'} held back as unlikely. Switch fetching to "Everything" in settings to open them anyway.`
        : 'Queue empty. Harvest your bookmarks to get started.';
  } else {
    box.className = 'panel';
    const t = document.createElement('div');
    t.className = 'truncate';
    t.style.fontWeight = '700';
    t.textContent = next.title || 'Untitled';
    const s = document.createElement('div');
    s.className = 'muted';
    s.style.marginTop = '4px';
    s.textContent = next.snippet.text.slice(0, 130) +
      (next.snippet.text.length > 130 ? '…' : '');
    const m = document.createElement('div');
    m.className = 'small muted';
    m.style.marginTop = '5px';
    m.textContent = `${next.index + 1} / ${next.total}`;
    box.append(t, s, m);
  }

  const tab = await activeTab();
  const onBookmarks = tab && HARVEST_RE.test(tab.url || '');
  $('harvest').textContent = onBookmarks ? 'Harvest this list' : 'Open Bookmarks to harvest';
  $('doctor').disabled = !(tab && /(^https:\/\/(x|twitter)\.com)/.test(tab.url || ''));
  // Diagnosing only means anything on a page that holds an article.
  $('diagnose').disabled = !(tab && /(x|twitter)\.com\/.+\/status\/|\/i\/article\//.test(tab.url || ''));
  $('diagnose').title = $('diagnose').disabled
    ? 'Open the article itself (an x.com/…/status/… page) first'
    : 'Run the extractor here and report what it sees';
  $('reread').disabled = $('diagnose').disabled;
  $('reread').title = $('reread').disabled
    ? 'Open the article itself (an x.com/…/status/… page) first'
    : 'Read this page again and replace what is stored for it';
  $('fetch').disabled = counts.fetchable === 0;
  $('fetch').textContent = counts.fetchable
    ? `Fetch article bodies (${counts.fetchable})`
    : 'Fetch article bodies';

  const mf = chrome.runtime.getManifest();
  $('version').textContent = 'v' + mf.version;
}

/* ------------------------------------------------------------------ */
/* actions                                                             */
/* ------------------------------------------------------------------ */

$('enabled').addEventListener('change', async (e) => {
  await store.setSettings({ enabled: e.target.checked });
  const tab = await activeTab();
  if (tab) await askTab(tab.id, { type: e.target.checked ? 'DRIP_RESWEEP' : 'DRIP_CLEAR_CARDS' });
});

$('harvest').addEventListener('click', async () => {
  const tab = await activeTab();
  if (!tab || !HARVEST_RE.test(tab.url || '')) {
    await chrome.tabs.create({ url: BOOKMARKS_URL });
    window.close();
    return;
  }

  $('harvest').disabled = true;
  say('Scrolling your bookmarks… keep this tab open.');

  const res = await askTab(tab.id, { type: 'DRIP_HARVEST' });
  $('harvest').disabled = false;

  if (!res) say('No response from the page. Reload x.com and try again.', 'err');
  else if (!res.ok) say(res.error || 'Harvest failed.', 'err');
  else {
    const bits = [`${res.found} new`];
    if (res.revisited) bits.push(`${res.revisited} already had`);
    say(bits.join(', ') + (res.stoppedEarly ? ' — stopped once it reached ones you already had.' : '.'), 'ok');
  }

  refresh();
});

$('fetch').addEventListener('click', async () => {
  say('Opening a background window to read each one…');
  const res = await chrome.runtime.sendMessage({ type: 'DRIP_FETCH_BODIES' });
  if (!res || !res.ok) { say((res && res.error) || 'Could not start.', 'err'); return; }
  pollJob();
});

$('doctor').addEventListener('click', async () => {
  const tab = await activeTab();
  if (!tab) return;
  const res = await askTab(tab.id, { type: 'DRIP_DOCTOR' });
  if (!res || !res.ok) {
    // Don't open the options page here: it would show the PREVIOUS report and
    // read as though this run succeeded on this page.
    say('Content script not running in this tab, so nothing was read. ' +
        'Reload the x.com tab and try again.', 'err');
    return;
  }
  await chrome.storage.local.set({ lastDoctor: res.report });
  chrome.runtime.openOptionsPage();
  window.close();
});

$('reread').addEventListener('click', async () => {
  const tab = await activeTab();
  if (!tab) return;
  $('reread').disabled = true;
  say('Reading this page… it scrolls to the bottom first, so give it a few seconds.');

  const res = await askTab(tab.id, { type: 'DRIP_EXTRACT_HERE' });
  $('reread').disabled = false;

  if (!res) {
    say('No response from the page. Reload it and try again.', 'err');
  } else if (!res.ok) {
    say(res.error || 'Could not read this page.', 'err');
  } else if (res.extracted && res.extracted.ok) {
    say(`Stored “${res.title}” — ${res.snippets} card${res.snippets === 1 ? '' : 's'}.`, 'ok');
  } else {
    const why = (res.extracted && res.extracted.reason) || 'nothing readable found';
    say(`Didn't store it: ${why}.`, 'err');
  }
  refresh();
});

$('diagnose').addEventListener('click', async () => {
  const tab = await activeTab();
  if (!tab) return;
  say('Running the extractor on this page…');
  const res = await askTab(tab.id, { type: 'DRIP_DIAGNOSE' });
  if (!res || !res.ok) {
    say('Content script not running in this tab, so nothing was read. ' +
        'Reload the page and try again.', 'err');
    return;
  }
  await chrome.storage.local.set({ lastDiagnosis: res.report });
  chrome.runtime.openOptionsPage();
  window.close();
});

$('opts').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

/* ------------------------------------------------------------------ */
/* job progress                                                        */
/* ------------------------------------------------------------------ */

function pollJob() {
  clearInterval(jobPoll);
  jobPoll = setInterval(async () => {
    const res = await chrome.runtime.sendMessage({ type: 'DRIP_JOB_STATUS' });
    const job = res && res.job;
    if (!job) { clearInterval(jobPoll); return; }

    const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
    const box = $('msg');
    box.innerHTML = '';
    const n = document.createElement('div');
    n.className = 'notice';
    const line = document.createElement('div');
    line.className = 'truncate';
    line.textContent = job.finished
      ? `Done — ${job.ok} read, ${job.failed} failed.`
      : `${job.done} / ${job.total} · ${job.current || ''}`;
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.marginTop = '7px';
    const fill = document.createElement('i');
    fill.style.width = pct + '%';
    bar.appendChild(fill);
    n.append(line, bar);
    box.appendChild(n);

    refresh();
    if (job.finished) clearInterval(jobPoll);
  }, 700);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'DRIP_HARVEST_PROGRESS') {
    say(`Scrolling… ${msg.found} new` +
        (msg.revisited ? `, ${msg.revisited} already had.` : ' so far.'));
  }
});

// Report a re-read that finished after the popup was dismissed.
(async () => {
  const { lastReread } = await chrome.storage.local.get('lastReread');
  if (!lastReread || Date.now() - lastReread.at > 5 * 60 * 1000) return;
  await chrome.storage.local.remove('lastReread');
  if (lastReread.extracted && lastReread.extracted.ok) {
    say(`Re-read “${lastReread.title}” — ${lastReread.snippets} card` +
        `${lastReread.snippets === 1 ? '' : 's'}.`, 'ok');
  } else {
    say('Last re-read failed: ' +
        ((lastReread.extracted && lastReread.extracted.reason) || 'unknown'), 'err');
  }
})();

refresh();
chrome.runtime.sendMessage({ type: 'DRIP_JOB_STATUS' }).then((r) => {
  if (r && r.job && !r.job.finished) pollJob();
}).catch(() => {});
