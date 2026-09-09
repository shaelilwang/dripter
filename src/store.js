/* Article Drip — store.js
 *
 * All persistence. Usable from content scripts, the popup, the options page
 * and the service worker (no DOM dependencies).
 *
 * Shape of chrome.storage.local:
 *   settings : { ...DEFAULT_SETTINGS }
 *   items    : { [id]: Item }
 *   stats    : { snippetsRead, articlesFinished, lastHarvest }
 *
 * Item:
 *   id         canonical status/article id
 *   url        permalink
 *   kind       'article' | 'thread' | 'post'
 *   title      best-effort title
 *   author     { name, handle }
 *   preview    first ~200 chars, shown before the body is fetched
 *   state      'pending'  — seen in bookmarks, body not fetched yet
 *              'ready'    — body fetched and chunked
 *              'reading'  — at least one snippet consumed
 *              'done'     — finished or dismissed
 *              'failed'   — extraction produced nothing usable
 *   snippets   [{ text, kind }]
 *   cursor     index of the next unread snippet
 *   addedAt / fetchedAt / lastSeenAt
 */
;(function (root) {
  root.AD = root.AD || {};

  const DEFAULT_SETTINGS = {
    enabled: true,
    everyNPosts: 4,        // insert a card after every N real posts
    maxChars: 1000,        // rough card size; splits only at author boundaries
    maxCards: 0,           // optional hard cap on cards per article; 0 = off
    snoozeMs: 20 * 60 * 1000,  // how long "Later" holds an article back
    order: 'sequential',   // 'sequential' | 'roundRobin' | 'shuffle'
    autoAdvance: false,    // tapping Next loads the following snippet in place
    markReadOnView: true,  // count a snippet read once it's been on screen
    dwellMs: 900,          // how long on screen before it counts
    includeThreads: true,
    includeArticles: true,
    minThreadPosts: 3,     // below this a "thread" isn't worth dripping
    minPostChars: 500,     // a lone post shorter than this isn't worth dripping
    // 'likely' fetches only bookmarks that look long-form from the list;
    // 'all' visits every bookmark, which is slower but catches Articles that
    // are indistinguishable from ordinary posts until you open them.
    fetchScope: 'likely',
    // Stop scrolling a re-harvest once we reach bookmarks we already hold.
    incrementalHarvest: true,
  };

  const DEFAULT_STATS = { snippetsRead: 0, articlesFinished: 0, lastHarvest: null };

  const area = () => chrome.storage.local;

  function get(keys) {
    return new Promise((resolve) => area().get(keys, resolve));
  }
  function set(obj) {
    return new Promise((resolve) => area().set(obj, resolve));
  }

  async function getSettings() {
    const { settings } = await get('settings');
    return Object.assign({}, DEFAULT_SETTINGS, settings || {});
  }
  async function setSettings(patch) {
    const cur = await getSettings();
    const next = Object.assign({}, cur, patch);
    await set({ settings: next });
    return next;
  }

  async function getStats() {
    const { stats } = await get('stats');
    return Object.assign({}, DEFAULT_STATS, stats || {});
  }
  async function bumpStats(patch) {
    const cur = await getStats();
    const next = Object.assign({}, cur);
    for (const [k, v] of Object.entries(patch)) {
      next[k] = typeof v === 'number' ? (next[k] || 0) + v : v;
    }
    await set({ stats: next });
    return next;
  }

  async function getItems() {
    const { items } = await get('items');
    return items || {};
  }
  async function getItem(id) {
    return (await getItems())[id] || null;
  }

  /** Merge one harvested record over whatever we already hold. */
  function mergeItem(prev, item) {
    if (!prev) {
      return Object.assign({
        state: 'pending',
        snippets: [],
        cursor: 0,
        addedAt: Date.now(),
        lastSeenAt: Date.now(),
      }, item);
    }
    // Never touch state / snippets / cursor here: a re-harvest must not undo
    // reading progress or push a fetched article back into the queue.
    return Object.assign({}, prev, {
      title: item.title || prev.title,
      author: item.author || prev.author,
      preview: item.preview || prev.preview,
      kind: prev.kind === 'post' ? (item.kind || prev.kind) : prev.kind,
      likely: prev.likely === true ? true : (item.likely ?? prev.likely),
      lastSeenAt: Date.now(),
    });
  }

  /**
   * Upsert a batch in a single read/write.
   *
   * Doing this per item meant rewriting the whole items object once per
   * bookmark -- O(n^2) storage writes across a harvest, which is what made
   * re-running one feel like it was redoing all the work.
   *
   * Returns which ids were new vs. already known, so the harvester can tell
   * when it has scrolled back into territory it already has.
   */
  async function upsertMany(list) {
    const fresh = [];
    const known = [];
    if (!list || !list.length) return { fresh, known };

    const items = await getItems();
    for (const item of list) {
      (items[item.id] ? known : fresh).push(item.id);
      items[item.id] = mergeItem(items[item.id], item);
    }
    await set({ items });
    return { fresh, known };
  }

  /** Insert if new; refresh cheap metadata if we've seen it before. */
  async function upsertItem(item) {
    await upsertMany([item]);
    return getItem(item.id);
  }

  async function updateItem(id, patch) {
    const items = await getItems();
    if (!items[id]) return null;
    items[id] = Object.assign({}, items[id], patch);
    await set({ items });
    return items[id];
  }

  async function removeItem(id) {
    const items = await getItems();
    delete items[id];
    await set({ items });
  }

  /** Attach chunked snippets to an item and mark it ready. */
  async function setSnippets(id, snippets) {
    const clean = (snippets || []).filter((s) => s && s.text && s.text.trim());
    return updateItem(id, {
      snippets: clean.map((s) => ({
        text: s.text,
        kind: s.kind || 'para',
        heading: s.heading || null,
      })),
      cursor: 0,
      state: clean.length ? 'ready' : 'failed',
      fetchedAt: Date.now(),
    });
  }

  const isLive = (it) =>
    (it.state === 'ready' || it.state === 'reading') &&
    it.snippets && it.cursor < it.snippets.length;

  /** Build the payload a card renders from, for a given item at its cursor. */
  function payloadFor(item) {
    if (!item || !item.snippets || item.cursor >= item.snippets.length) return null;
    return {
      itemId: item.id,
      title: item.title,
      author: item.author,
      url: item.url,
      kind: item.kind,
      index: item.cursor,
      total: item.snippets.length,
      snippet: item.snippets[item.cursor],
    };
  }

  /** The payload for one specific article, wherever its cursor sits. */
  async function peekItem(id) {
    return payloadFor(await getItem(id));
  }

  /**
   * Pick the next snippet to show, honoring the reading order setting.
   * Does NOT advance the cursor — call consume() once it's actually read.
   *
   * `exclude` is the set of article ids already on screen. Only one card per
   * article is ever shown: reading one card and then scrolling into "3/24" of
   * the same article further down the feed is disorienting, and it was also
   * what made Next jump several snippets at once.
   */
  async function peekNext(exclude) {
    const settings = await getSettings();
    const items = await getItems();

    let live = Object.values(items).filter(isLive);
    if (exclude && exclude.size) live = live.filter((i) => !exclude.has(i.id));

    // "Later" holds an article back, but only while something else is
    // available — being snoozed should never mean nothing to read.
    const now = Date.now();
    const awake = live.filter((i) => !i.snoozedUntil || i.snoozedUntil <= now);
    if (awake.length) live = awake;

    if (!live.length) return null;

    let item;
    if (settings.order === 'shuffle') {
      item = live[Math.floor(Math.random() * live.length)];
    } else if (settings.order === 'roundRobin') {
      // Whichever live article was shown least recently.
      live.sort((a, b) => (a.lastShownAt || 0) - (b.lastShownAt || 0));
      item = live[0];
    } else {
      // sequential: finish what you started, oldest bookmark first
      const started = live.filter((i) => i.cursor > 0);
      const pool = started.length ? started : live;
      pool.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
      item = pool[0];
    }

    return payloadFor(item);
  }

  /** The payload for one specific article, wherever its cursor sits. */
  async function peekItem(id) {
    return payloadFor(await getItem(id));
  }

  /** Mark the snippet at `index` as read and advance. Idempotent. */
  async function consume(itemId, index) {
    const items = await getItems();
    const it = items[itemId];
    if (!it || it.cursor !== index) return null; // already advanced; no-op

    it.cursor = index + 1;
    it.lastShownAt = Date.now();
    it.state = it.cursor >= it.snippets.length ? 'done' : 'reading';
    items[itemId] = it;
    await set({ items });

    await bumpStats({
      snippetsRead: 1,
      articlesFinished: it.state === 'done' ? 1 : 0,
    });
    return it;
  }

  /** Step back one snippet, so you can re-read what you just passed. */
  async function stepBack(id) {
    const items = await getItems();
    const it = items[id];
    if (!it || !it.snippets || !it.snippets.length) return null;
    if ((it.cursor || 0) <= 0) return it;

    it.cursor = it.cursor - 1;
    it.state = it.cursor > 0 ? 'reading' : 'ready';
    items[id] = it;
    await set({ items });
    return it;
  }

  /** Move past a snippet without counting it as read. */
  async function skipForward(id) {
    const items = await getItems();
    const it = items[id];
    if (!it || !it.snippets) return null;
    if (it.cursor >= it.snippets.length) return it;

    it.cursor = it.cursor + 1;
    it.state = it.cursor >= it.snippets.length ? 'done' : 'reading';
    items[id] = it;
    await set({ items });
    return it;
  }

  /**
   * Hold an article back for a while without consuming anything, so it
   * resumes at exactly the snippet you left it on.
   */
  async function snooze(id, ms) {
    const settings = await getSettings();
    return updateItem(id, {
      snoozedUntil: Date.now() + (ms || settings.snoozeMs),
      lastShownAt: Date.now(),
    });
  }

  async function resetItem(id) {
    return updateItem(id, { cursor: 0, state: 'ready', snoozedUntil: 0 });
  }
  async function markDone(id) {
    return updateItem(id, { state: 'done' });
  }

  /**
   * Re-run the chunker over blocks we already extracted.
   *
   * Snippet boundaries are a presentation choice, so changing them shouldn't
   * mean re-opening every article. Reading position is carried across as a
   * fraction, since the old snippet index means nothing once the count moves.
   */
  async function rechunkAll() {
    const chunker = root.AD && root.AD.chunker;
    if (!chunker) throw new Error('chunker not loaded');

    const settings = await getSettings();
    const items = await getItems();
    let done = 0;
    let skipped = 0;

    for (const it of Object.values(items)) {
      if (!it.blocks || !it.blocks.length) { skipped++; continue; }

      const snippets = chunker.chunk(it.blocks, {
        maxCards: settings.maxCards,
        maxChars: settings.maxChars,
      });
      if (!snippets.length) { skipped++; continue; }

      const oldTotal = (it.snippets || []).length;
      const progress = oldTotal ? (it.cursor || 0) / oldTotal : 0;
      const cursor = Math.min(snippets.length, Math.round(progress * snippets.length));

      items[it.id] = Object.assign({}, it, {
        snippets: snippets.map((s) => ({
          text: s.text, kind: s.kind || 'para', heading: s.heading || null,
        })),
        cursor,
        state: it.state === 'done' ? 'done'
          : cursor >= snippets.length ? 'done'
          : cursor > 0 ? 'reading' : 'ready',
      });
      done++;
    }

    await set({ items });
    return { done, skipped };
  }

  /* ---- bulk operations: one read, one write, whatever the size ---- */

  const matches = (it, state) => !state || state === 'all' || it.state === state;

  /** Retire everything in `state` (or everything, if omitted). */
  async function markManyDone(state) {
    const items = await getItems();
    let n = 0;
    for (const it of Object.values(items)) {
      if (it.state === 'done' || !matches(it, state)) continue;
      items[it.id] = Object.assign({}, it, { state: 'done' });
      n++;
    }
    if (n) await set({ items });
    return n;
  }

  /**
   * Put failed items back in the fetch queue. Without this a transient
   * extraction failure stranded an article permanently -- the fetch job only
   * ever looks at 'pending', so nothing would retry it.
   */
  async function retryFailed() {
    const items = await getItems();
    let n = 0;
    for (const it of Object.values(items)) {
      if (it.state !== 'failed') continue;
      items[it.id] = Object.assign({}, it, { state: 'pending', snippets: [], cursor: 0 });
      n++;
    }
    if (n) await set({ items });
    return n;
  }

  /** Drop everything in `state` from the library entirely. */
  async function removeMany(state) {
    const items = await getItems();
    let n = 0;
    for (const it of Object.values(items)) {
      if (!matches(it, state)) continue;
      delete items[it.id];
      n++;
    }
    if (n) await set({ items });
    return n;
  }

  async function counts() {
    const items = Object.values(await getItems());
    const c = {
      total: items.length, pending: 0, ready: 0, reading: 0,
      done: 0, failed: 0, skipped: 0, snippetsLeft: 0, fetchable: 0,
    };
    const scope = (await getSettings()).fetchScope;
    for (const it of items) {
      c[it.state] = (c[it.state] || 0) + 1;
      if (it.state === 'pending' && (scope === 'all' || it.likely !== false)) c.fetchable++;
      if (isLive(it)) c.snippetsLeft += it.snippets.length - it.cursor;
    }
    return c;
  }

  async function exportAll() {
    const all = await get(null);
    return { format: 'article-drip/v1', exportedAt: new Date().toISOString(), data: all };
  }

  async function importAll(payload, { merge = true } = {}) {
    if (!payload || payload.format !== 'article-drip/v1') {
      throw new Error('Not an Article Drip export file.');
    }
    const incoming = payload.data || {};
    if (!merge) {
      await new Promise((r) => area().clear(r));
      await set(incoming);
      return await counts();
    }
    const items = await getItems();
    for (const [id, it] of Object.entries(incoming.items || {})) {
      const prev = items[id];
      // Keep whichever copy has read further, so importing never loses progress.
      items[id] = (prev && (prev.cursor || 0) >= (it.cursor || 0)) ? prev : it;
    }
    await set({
      items,
      settings: Object.assign({}, await getSettings(), incoming.settings || {}),
    });
    return await counts();
  }

  const api = {
    DEFAULT_SETTINGS,
    get, set,
    getSettings, setSettings,
    getStats, bumpStats,
    getItems, getItem, upsertItem, upsertMany, updateItem, removeItem,
    setSnippets, peekNext, peekItem, consume, resetItem, markDone,
    stepBack, skipForward, snooze,
    markManyDone, retryFailed, removeMany, rechunkAll,
    counts, exportAll, importAll,
  };

  root.AD.store = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
