/* Article Drip — options.js */
const store = globalThis.AD.store;
const $ = (id) => document.getElementById(id);

const NUMBERS = ['everyNPosts', 'maxCards', 'maxChars', 'dwellMs', 'minThreadPosts', 'minPostChars'];
const FLAGS = ['markReadOnView', 'includeArticles', 'includeThreads', 'incrementalHarvest'];
const SELECTS = ['order', 'fetchScope'];

let filter = 'all';

function say(text, kind) {
  const box = $('msg');
  box.innerHTML = '';
  if (!text) return;
  const n = document.createElement('div');
  n.className = 'notice' + (kind ? ' ' + kind : '');
  n.style.marginBottom = '16px';
  n.textContent = text;
  box.appendChild(n);
  if (kind === 'ok') setTimeout(() => { if (box.contains(n)) n.remove(); }, 4000);
}

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

async function loadSettings() {
  const s = await store.getSettings();
  for (const k of NUMBERS) $(k).value = s[k];
  for (const k of FLAGS) $(k).checked = !!s[k];
  for (const k of SELECTS) $(k).value = s[k];
}

function wireSettings() {
  const save = async (k, v) => {
    await store.setSettings({ [k]: v });
    say('Saved.', 'ok');
  };
  for (const k of NUMBERS) {
    $(k).addEventListener('change', (e) => {
      const el = e.target;
      let v = parseInt(el.value, 10);
      const min = parseInt(el.min, 10);
      const max = parseInt(el.max, 10);
      if (isNaN(v)) v = store.DEFAULT_SETTINGS[k];
      v = Math.min(max, Math.max(min, v));
      el.value = v;
      save(k, v);
    });
  }
  for (const k of FLAGS) $(k).addEventListener('change', (e) => save(k, e.target.checked));
  for (const k of SELECTS) $(k).addEventListener('change', (e) => save(k, e.target.value));
}

/* ------------------------------------------------------------------ */
/* library                                                             */
/* ------------------------------------------------------------------ */

const STATES = ['all', 'pending', 'ready', 'reading', 'done', 'skipped', 'failed'];

function renderFilters(counts) {
  const wrap = $('filters');
  wrap.innerHTML = '';
  for (const s of STATES) {
    const b = document.createElement('button');
    b.className = 'tiny' + (filter === s ? ' on' : '');
    const n = s === 'all' ? counts.total : (counts[s] || 0);
    b.textContent = `${s} (${n})`;
    b.addEventListener('click', () => { filter = s; renderLibrary(); });
    wrap.appendChild(b);
  }
}

function itemRow(it) {
  const row = document.createElement('div');
  row.className = 'item';

  const pill = document.createElement('span');
  pill.className = 'pill ' + it.state;
  pill.textContent = it.state;
  row.appendChild(pill);

  const mid = document.createElement('div');
  mid.className = 'grow';

  const title = document.createElement('div');
  title.className = 'truncate';
  title.style.fontWeight = '600';
  title.textContent = it.title || it.id;
  title.title = it.title || '';
  mid.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'small muted truncate';
  const total = (it.snippets || []).length;
  const d = it.debug;
  const bits = [
    it.kind,
    it.author && it.author.handle ? '@' + it.author.handle : null,
    total ? `${it.cursor}/${total} snippets` : null,
    // Surface how the body was found and how much of it there was: a card
    // full of headings almost always means few chars via an odd route.
    d ? `${d.chars} chars via ${d.via}` : null,
    d && d.headings ? `${d.headings} headings` : null,
  ].filter(Boolean);
  meta.textContent = bits.join(' · ');
  meta.title = d ? JSON.stringify(d, null, 2) : '';
  mid.appendChild(meta);

  if (total) {
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.marginTop = '6px';
    const fill = document.createElement('i');
    fill.style.width = Math.round((it.cursor / total) * 100) + '%';
    bar.appendChild(fill);
    mid.appendChild(bar);
  }
  row.appendChild(mid);

  const acts = document.createElement('div');
  acts.className = 'row';
  const add = (label, fn, cls) => {
    const b = document.createElement('button');
    b.className = 'tiny' + (cls ? ' ' + cls : '');
    b.textContent = label;
    b.addEventListener('click', async () => { await fn(); renderLibrary(); });
    acts.appendChild(b);
  };
  add('Open', () => chrome.tabs.create({ url: it.url || it.statusUrl }));
  if (it.cursor > 0) add('Restart', () => store.resetItem(it.id));
  if (it.state !== 'done') add('Done', () => store.markDone(it.id));
  add('Remove', () => store.removeItem(it.id), 'danger');
  row.appendChild(acts);

  return row;
}

async function renderLibrary() {
  const [items, counts] = await Promise.all([store.getItems(), store.counts()]);
  renderFilters(counts);

  // Bulk buttons act on whatever the filter is currently showing, so say so.
  const scope = filter === 'all' ? 'everything' : `the ${filter} ones`;
  $('bulk-hint').textContent = `acts on ${scope}`;
  $('bulk-done').textContent = filter === 'all' ? 'Mark all read' : `Mark ${filter} read`;
  $('bulk-retry').disabled = (counts.failed || 0) === 0;
  $('bulk-remove').disabled = (counts.done || 0) === 0;

  const list = Object.values(items)
    .filter((it) => filter === 'all' || it.state === filter)
    .sort((a, b) => {
      const rank = { reading: 0, ready: 1, pending: 2, failed: 3, skipped: 4, done: 5 };
      const d = (rank[a.state] ?? 9) - (rank[b.state] ?? 9);
      return d || (b.addedAt || 0) - (a.addedAt || 0);
    });

  $('lib-count').textContent = `— ${counts.snippetsLeft} snippets left to read`;

  const wrap = $('items');
  wrap.innerHTML = '';
  if (!list.length) {
    const p = document.createElement('div');
    p.className = 'muted small';
    p.textContent = filter === 'all'
      ? 'Nothing here yet. Open x.com/i/bookmarks and harvest.'
      : `No items in "${filter}".`;
    wrap.appendChild(p);
    return;
  }
  for (const it of list) wrap.appendChild(itemRow(it));
}

/* ------------------------------------------------------------------ */
/* bulk actions                                                        */
/* ------------------------------------------------------------------ */

$('bulk-done').addEventListener('click', async () => {
  const label = filter === 'all' ? 'every article' : `every "${filter}" article`;
  if (!confirm(`Mark ${label} as read? They stop appearing in your feed. Nothing is deleted.`)) return;
  say(`Marked ${await store.markManyDone(filter)} as read.`, 'ok');
  renderLibrary();
});

$('bulk-retry').addEventListener('click', async () => {
  const n = await store.retryFailed();
  say(n ? `${n} queued for another attempt — run "Fetch article bodies" again.`
        : 'Nothing failed.', 'ok');
  renderLibrary();
});

$('rechunk').addEventListener('click', async () => {
  try {
    const { done, skipped, needsRefetch } = await store.rechunkAll();
    const bits = [`Re-chunked ${done} article${done === 1 ? '' : 's'}.`];
    if (skipped) bits.push(`${skipped} had no stored text at all.`);
    if (needsRefetch) {
      // Saying "done" while nothing visibly changed is worse than saying
      // nothing: re-chunking cannot add structure that was never captured.
      bits.push(`${needsRefetch} still can't be fixed this way — their stored ` +
        'text has no headings or title in it, so there is nothing to rearrange. ' +
        'Click "Re-fetch" above, then "Fetch article bodies" in the popup.');
    }
    say(bits.join(' '), needsRefetch ? 'err' : 'ok');
    if (needsRefetch) {
      $('refetch').classList.add('primary');
      $('refetch').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    renderLibrary();
  } catch (e) {
    say(String(e.message || e), 'err');
  }
});

$('refetch').addEventListener('click', async () => {
  const label = filter === 'all' ? 'every article' : `every "${filter}" article`;
  if (!confirm(`Re-open ${label} and read it again? Use this when the stored text ` +
    'itself is wrong — re-chunking only rearranges what was already captured. ' +
    'Reading position is reset for those articles.')) return;
  const n = await store.requeueMany(filter);
  say(n ? `${n} queued — now run "Fetch article bodies" from the popup.`
        : 'Nothing to re-fetch.', 'ok');
  renderLibrary();
});

$('bulk-remove').addEventListener('click', async () => {
  if (!confirm('Remove finished articles from the library? They can be harvested again later.')) return;
  say(`Removed ${await store.removeMany('done')}.`, 'ok');
  renderLibrary();
});

/* ------------------------------------------------------------------ */
/* import / export                                                     */
/* ------------------------------------------------------------------ */

$('export').addEventListener('click', async () => {
  const payload = await store.exportAll();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `article-drip-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});

$('import').addEventListener('click', () => $('file').click());

$('file').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const counts = await store.importAll(JSON.parse(await file.text()), { merge: true });
    say(`Imported. ${counts.total} articles, ${counts.snippetsLeft} snippets left.`, 'ok');
    await loadSettings();
    renderLibrary();
  } catch (err) {
    say(String(err.message || err), 'err');
  } finally {
    e.target.value = '';
  }
});

/* ------------------------------------------------------------------ */
/* danger zone                                                         */
/* ------------------------------------------------------------------ */

$('reset-progress').addEventListener('click', async () => {
  if (!confirm('Reset every article back to snippet 1? Your library is kept.')) return;
  const items = await store.getItems();
  for (const it of Object.values(items)) {
    if ((it.snippets || []).length) await store.resetItem(it.id);
  }
  say('Progress reset.', 'ok');
  renderLibrary();
});

$('wipe').addEventListener('click', async () => {
  if (!confirm('Delete all saved articles, snippets, progress and settings? This cannot be undone.')) return;
  await new Promise((r) => chrome.storage.local.clear(r));
  say('Everything deleted.', 'ok');
  await loadSettings();
  renderLibrary();
});

/* ------------------------------------------------------------------ */
/* doctor report                                                       */
/* ------------------------------------------------------------------ */

async function renderDoctor() {
  const { lastDoctor } = await chrome.storage.local.get('lastDoctor');
  const out = $('doctor-out');
  if (!lastDoctor) return;

  out.innerHTML = '';

  const ageMs = Date.now() - new Date(lastDoctor.at).getTime();
  const ageMin = Math.round(ageMs / 60000);

  const head = document.createElement('div');
  head.className = 'small muted';
  head.style.marginBottom = '8px';
  head.textContent = `${lastDoctor.path} · ${new Date(lastDoctor.at).toLocaleString()}`;
  out.appendChild(head);

  // A stale report reads exactly like a fresh one, which sends you debugging
  // the wrong page. If the Doctor can't reach the content script it leaves the
  // previous run on screen, so say plainly how old this is and where it's from.
  if (ageMs > 3 * 60 * 1000) {
    const stale = document.createElement('div');
    stale.className = 'notice';
    stale.style.marginBottom = '10px';
    stale.style.borderColor = 'color-mix(in srgb, var(--warn) 60%, transparent)';
    stale.textContent =
      `This reading is ${ageMin} minute${ageMin === 1 ? '' : 's'} old, taken on ` +
      `${lastDoctor.path}. If you meant to check a different page, open it and ` +
      `run Selector Doctor again — if the button reports an error, reload that ` +
      `tab first so the content script attaches.`;
    out.appendChild(stale);
  }

  const problems = lastDoctor.problemKeys || lastDoctor.brokenKeys || [];
  const benign = lastDoctor.benignKeys || [];

  if (problems.length) {
    const warn = document.createElement('div');
    warn.className = 'notice err';
    warn.style.marginBottom = '10px';
    warn.textContent =
      `Broken on a page where they should work: ${problems.join(', ')}. ` +
      'Fix these in src/selectors.js — add a working selector to the front of ' +
      "that key's list.";
    out.appendChild(warn);
  } else {
    const ok = document.createElement('div');
    ok.className = 'notice ok';
    ok.style.marginBottom = '10px';
    ok.textContent = benign.length
      ? `Everything this page should have is resolving. ${benign.length} ` +
        `selector${benign.length === 1 ? '' : 's'} found nothing, all of which ` +
        `belong to other pages or are optional: ${benign.join(', ')}.`
      : 'Every selector resolved on this page.';
    out.appendChild(ok);
  }

  for (const r of lastDoctor.results) {
    const line = document.createElement('div');
    line.className = 'dline';
    const k = document.createElement('span');
    k.className = 'dkey';
    k.textContent = (r.ok ? '✓ ' : r.problem ? '✕ ' : '– ') + r.key;
    k.style.color = r.ok ? 'var(--good)' : r.problem ? 'var(--bad)' : 'var(--muted)';
    if (r.note) k.title = r.note;
    const v = document.createElement('span');
    v.className = 'mono muted grow truncate';
    v.textContent = r.variants.map((x) => `${x.count}× ${x.selector}`).join('   |   ');
    v.title = r.variants.map((x) => `${x.count}  ${x.selector}`).join('\n');
    line.append(k, v);
    out.appendChild(line);
  }

  renderCensus(lastDoctor.census, out);
}

/**
 * What's actually on the page, regardless of whether our selectors found it.
 * A miss plus an empty census means the content isn't there; a miss plus a
 * populated census means the selector is wrong.
 */
function renderCensus(c, out) {
  if (!c) return;

  const h = document.createElement('div');
  h.style.cssText = 'margin-top:14px;padding-top:12px;border-top:1px solid var(--border);font-weight:700';
  h.textContent = 'What was on the page';
  out.appendChild(h);

  const line = (label, value, mono) => {
    const d = document.createElement('div');
    d.className = 'dline';
    const k = document.createElement('span');
    k.className = 'dkey';
    k.textContent = label;
    const v = document.createElement('span');
    v.className = (mono ? 'mono ' : '') + 'grow';
    v.style.whiteSpace = 'pre-wrap';
    v.style.overflowWrap = 'anywhere';
    v.textContent = value;
    d.append(k, v);
    out.appendChild(d);
  };

  line('posts loaded', String(c.posts));
  line('long posts (400+)', String(c.longPosts));
  line('with a card', String(c.withCard));
  line('"Show this thread"', String(c.withThreadHint));
  line('longest texts', (c.longestTexts || []).join(', ') || '—');
  line('article cover images', String(c.articleMarkers == null ? '?' : c.articleMarkers));
  line('article-ish markup',
    (c.articleish || []).length
      ? c.articleish.map((a) =>
          `${a.testid}  ${a.insideTweet ? 'in-post' : 'OUTSIDE-post'}  ${a.nearestHref || 'no link'}`
        ).join('\n')
      : 'none found', true);
  line('article/i links page-wide',
    (c.pageWideSpecialLinks || []).length
      ? c.pageWideSpecialLinks.map((x) => `${x.n}×  ${x.shape}`).join('\n')
      : 'none', true);
  line('outbound links',
    (c.outbound || []).length ? c.outbound.join('\n') : 'none', true);

  const lh = document.createElement('div');
  lh.className = 'dline';
  lh.style.marginTop = '6px';
  const lk = document.createElement('span');
  lk.className = 'dkey';
  lk.textContent = 'link shapes';
  const lv = document.createElement('span');
  lv.className = 'mono grow';
  lv.style.whiteSpace = 'pre-wrap';
  lv.textContent = (c.linkShapes || []).map((x) => `${String(x.n).padStart(3)}×  ${x.shape}`).join('\n') || '—';
  lh.append(lk, lv);
  out.appendChild(lh);
}

/* ------------------------------------------------------------------ */
/* article diagnosis                                                   */
/* ------------------------------------------------------------------ */

async function renderDiagnosis() {
  const { lastDiagnosis } = await chrome.storage.local.get('lastDiagnosis');
  const out = $('diag-out');
  if (!lastDiagnosis) return;

  out.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'small muted';
  head.style.marginBottom = '8px';
  head.textContent = `${lastDiagnosis.path} · ${new Date(lastDiagnosis.at).toLocaleString()}` +
    (lastDiagnosis.extensionVersion ? ` · built from v${lastDiagnosis.extensionVersion}` : '');
  out.appendChild(head);

  /*
   * A stale report reads exactly like a fresh one. This page is reached from
   * a button that just ran a diagnosis, so an old report sitting here means
   * the run didn't happen — and every conclusion drawn from it is about code
   * that has since changed. Say so before the numbers.
   */
  const ageMin = Math.round((Date.now() - new Date(lastDiagnosis.at).getTime()) / 60000);
  const running = chrome.runtime.getManifest().version;
  const staleBuild = lastDiagnosis.extensionVersion &&
    lastDiagnosis.extensionVersion !== running;

  if (ageMin > 3 || staleBuild || !lastDiagnosis.extensionVersion) {
    const stale = document.createElement('div');
    stale.className = 'notice err';
    stale.style.marginBottom = '10px';
    stale.textContent =
      `This report is ${ageMin} minute${ageMin === 1 ? '' : 's'} old` +
      (staleBuild || !lastDiagnosis.extensionVersion
        ? `, and was produced by ${lastDiagnosis.extensionVersion
            ? 'v' + lastDiagnosis.extensionVersion : 'an older build'} while ` +
          `v${running} is loaded. `
        : '. ') +
      'Re-run "Diagnose this article page" before trusting anything below — ' +
      'and if the extension was just reloaded, reload the x.com tab too.';
    out.appendChild(stale);
  }

  // A short verdict up front, so the common failures don't need reading JSON.
  const verdicts = [];
  if (!lastDiagnosis.bodyFound) {
    verdicts.push('No article body found on this page at all — the articleBody ' +
      'selectors missed and the structural fallback found nothing long enough.');
  } else {
    if (lastDiagnosis.usedStructuralFallback) {
      verdicts.push('Body found only by the structural fallback, so the ' +
        'articleBody selectors are wrong for this page.');
    }
    if (!lastDiagnosis.titleChosen) {
      const outside = (lastDiagnosis.headings || []).filter((h) => !h.insideBody);
      verdicts.push('No title found. ' + (outside.length
        ? `There are ${outside.length} heading(s) on the page OUTSIDE the body ` +
          'element — the title is probably one of them.'
        : 'There are no headings inside the body either.'));
    }
    if (lastDiagnosis.quality && lastDiagnosis.quality.coverage != null &&
        lastDiagnosis.quality.coverage < 0.6) {
      verdicts.push(`Only ${Math.round(lastDiagnosis.quality.coverage * 100)}% of ` +
        'the body text was captured.');
    }
  }
  const stored = lastDiagnosis.storedItem;
  if (stored && typeof stored === 'object' &&
      lastDiagnosis.blockCount > 3 && stored.storedBlocks <= 1) {
    verdicts.push(`The stored copy holds ${stored.storedBlocks} block(s) while this ` +
      `page yields ${lastDiagnosis.blockCount} — it was captured by an older ` +
      'extractor. Re-chunking cannot fix that; use "Re-fetch" in the library, ' +
      'then run "Fetch article bodies".');
  }
  if (stored && typeof stored === 'object' &&
      lastDiagnosis.titleChosen &&
      stored.title !== lastDiagnosis.titleChosen) {
    verdicts.push(`The stored copy still has the old title ("${stored.title}") — ` +
      `re-chunk or re-fetch to pick up "${lastDiagnosis.titleChosen}".`);
  }

  const v = document.createElement('div');
  v.className = 'notice ' + (verdicts.length ? 'err' : 'ok');
  v.style.marginBottom = '10px';
  v.style.whiteSpace = 'pre-wrap';
  v.textContent = verdicts.length ? verdicts.join('\n\n')
    : 'Extraction looks healthy on this page.';
  out.appendChild(v);

  const pre = document.createElement('pre');
  pre.className = 'mono';
  pre.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:420px;' +
    'overflow:auto;margin:0;padding:10px;border:1px solid var(--border);border-radius:8px';
  pre.textContent = JSON.stringify(lastDiagnosis, null, 2);
  out.appendChild(pre);

  const copy = document.createElement('button');
  copy.className = 'primary';
  copy.textContent = 'Copy report';
  copy.style.marginTop = '10px';
  copy.addEventListener('click', async () => {
    await navigator.clipboard.writeText(JSON.stringify(lastDiagnosis, null, 2));
    copy.textContent = 'Copied — paste it to Claude';
    setTimeout(() => { copy.textContent = 'Copy report'; }, 2500);
  });
  out.appendChild(copy);

  // This page opens automatically from the Diagnose button, and the report
  // sits well below the fold. Take the reader to it rather than leaving them
  // to hunt for it.
  if (Date.now() - new Date(lastDiagnosis.at).getTime() < 15000) {
    out.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

/* ------------------------------------------------------------------ */

wireSettings();
loadSettings();
renderLibrary();
renderDoctor();
renderDiagnosis();
chrome.storage.onChanged.addListener((c) => {
  if (c.items) renderLibrary();
  if (c.lastDoctor) renderDoctor();
  if (c.lastDiagnosis) renderDiagnosis();
});
