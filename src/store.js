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
    maxChars: 270,         // snippet budget
    order: 'sequential',   // 'sequential' | 'roundRobin' | 'shuffle'
    autoAdvance: false,    // tapping Next loads the following snippet in place
    markReadOnView: true,  // count a snippet read once it's been on screen
    dwellMs: 900,          // how long on screen before it counts
    includeThreads: true,
    includeArticles: true,
    minThreadPosts: 3,     // below this a "thread" isn't worth dripping
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

  /** Insert if new; refresh cheap metadata if we've seen it before. */
  async function upsertItem(item) {
    const items = await getItems();
    const prev = items[item.id];
    if (prev) {
      items[item.id] = Object.assign({}, prev, {
        title: item.title || prev.title,
        author: item.author || prev.author,
        preview: item.preview || prev.preview,
        kind: prev.kind === 'post' ? (item.kind || prev.kind) : prev.kind,
        lastSeenAt: Date.now(),
      });
    } else {
      items[item.id] = Object.assign({
        state: 'pending',
        snippets: [],
        cursor: 0,
        addedAt: Date.now(),
        lastSeenAt: Date.now(),
      }, item);
    }
    await set({ items });
    return items[item.id];
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
      snippets: clean.map((s) => ({ text: s.text, kind: s.kind || 'para' })),
      cursor: 0,
      state: clean.length ? 'ready' : 'failed',
      fetchedAt: Date.now(),
    });
  }

  const isLive = (it) =>
    (it.state === 'ready' || it.state === 'reading') &&
    it.snippets && it.cursor < it.snippets.length;

  /**
   * Pick the next snippet to show, honoring the reading order setting.
   * Does NOT advance the cursor — call consume() once it's actually read.
   */
  async function peekNext() {
    const settings = await getSettings();
    const items = await getItems();
    const live = Object.values(items).filter(isLive);
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

  async function resetItem(id) {
    return updateItem(id, { cursor: 0, state: 'ready' });
  }
  async function markDone(id) {
    return updateItem(id, { state: 'done' });
  }

  async function counts() {
    const items = Object.values(await getItems());
    const c = { total: items.length, pending: 0, ready: 0, reading: 0, done: 0, failed: 0, snippetsLeft: 0 };
    for (const it of items) {
      c[it.state] = (c[it.state] || 0) + 1;
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
    getItems, getItem, upsertItem, updateItem, removeItem,
    setSnippets, peekNext, consume, resetItem, markDone,
    counts, exportAll, importAll,
  };

  root.AD.store = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
