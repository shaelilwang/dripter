/* Run with:  node tests/store.test.js
 *
 * Exercises the reading state machine against an in-memory stand-in for
 * chrome.storage.local. This is the logic that decides what you see next and
 * whether progress survives — worth testing outside a browser.
 */

/* ---- chrome.storage.local shim ---------------------------------- */
let mem = {};
globalThis.chrome = {
  storage: {
    local: {
      get(keys, cb) {
        let out;
        if (keys == null) out = JSON.parse(JSON.stringify(mem));
        else if (typeof keys === 'string') out = { [keys]: mem[keys] };
        else if (Array.isArray(keys)) {
          out = {};
          for (const k of keys) out[k] = mem[k];
        } else {
          out = Object.assign({}, keys);
          for (const k of Object.keys(keys)) if (k in mem) out[k] = mem[k];
        }
        setTimeout(() => cb(out), 0);
      },
      set(obj, cb) {
        Object.assign(mem, JSON.parse(JSON.stringify(obj)));
        setTimeout(() => cb && cb(), 0);
      },
      clear(cb) { mem = {}; setTimeout(() => cb && cb(), 0); },
    },
  },
};

const store = require('../src/store.js');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '\n       ' + detail : ''}`); }
}
function eq(name, a, b) {
  check(name, JSON.stringify(a) === JSON.stringify(b),
    `expected ${JSON.stringify(b)}\n       actual   ${JSON.stringify(a)}`);
}

const reset = () => { mem = {}; };

async function seed(id, n, extra) {
  await store.upsertItem(Object.assign({
    id, url: `https://x.com/a/status/${id}`, kind: 'article',
    title: `Article ${id}`, author: { name: 'A', handle: 'a' },
  }, extra));
  await store.setSnippets(id,
    Array.from({ length: n }, (_, i) => ({ text: `${id}-snippet-${i}`, kind: 'para' })));
}

async function main() {
  console.log('\nitem lifecycle');
  reset();
  await seed('100', 3);
  let it = await store.getItem('100');
  eq('starts ready', it.state, 'ready');
  eq('cursor at zero', it.cursor, 0);
  eq('snippets stored', it.snippets.length, 3);

  console.log('\npeek and consume');
  let p = await store.peekNext();
  eq('peek returns first snippet', p.snippet.text, '100-snippet-0');
  eq('peek reports total', p.total, 3);
  check('peek does not advance', (await store.getItem('100')).cursor === 0);

  await store.consume('100', 0);
  eq('consume advances', (await store.getItem('100')).cursor, 1);
  eq('state becomes reading', (await store.getItem('100')).state, 'reading');

  await store.consume('100', 0);
  eq('consuming a stale index is a no-op', (await store.getItem('100')).cursor, 1);

  await store.consume('100', 1);
  await store.consume('100', 2);
  it = await store.getItem('100');
  eq('finishing marks done', it.state, 'done');
  eq('stats counted the reads', (await store.getStats()).snippetsRead, 3);
  eq('stats counted the finish', (await store.getStats()).articlesFinished, 1);
  eq('done article is not offered again', await store.peekNext(), null);

  console.log('\nsequential order');
  reset();
  await store.setSettings({ order: 'sequential' });
  await seed('200', 3);
  await new Promise((r) => setTimeout(r, 5));
  await seed('201', 3);

  p = await store.peekNext();
  eq('starts with the older bookmark', p.itemId, '200');
  await store.consume('200', 0);
  p = await store.peekNext();
  eq('stays on the started article', p.itemId, '200');
  eq('and moves to its next snippet', p.snippet.text, '200-snippet-1');

  await store.consume('200', 1);
  await store.consume('200', 2);
  p = await store.peekNext();
  eq('moves on once the first is finished', p.itemId, '201');

  console.log('\nround robin');
  reset();
  await store.setSettings({ order: 'roundRobin' });
  await seed('300', 3);
  await seed('301', 3);
  const first = (await store.peekNext()).itemId;
  await store.consume(first, 0);
  const second = (await store.peekNext()).itemId;
  check('rotates to the other article', second !== first, `${first} then ${second}`);

  console.log('\ncounts');
  reset();
  await store.setSettings({ order: 'sequential' });
  await seed('400', 4);
  await seed('401', 2);
  await store.upsertItem({ id: '402', url: 'u', kind: 'thread', title: 'unfetched' });
  await store.consume('400', 0);
  let c = await store.counts();
  eq('total', c.total, 3);
  eq('pending', c.pending, 1);
  eq('reading', c.reading, 1);
  eq('ready', c.ready, 1);
  eq('snippets left', c.snippetsLeft, 3 + 2);

  console.log('\nfailed extraction');
  reset();
  await store.upsertItem({ id: '500', url: 'u', kind: 'article', title: 'empty' });
  await store.setSnippets('500', []);
  eq('empty extraction is failed', (await store.getItem('500')).state, 'failed');
  eq('failed items are never offered', await store.peekNext(), null);

  console.log('\nupsert does not clobber progress');
  reset();
  await seed('600', 5);
  await store.consume('600', 0);
  await store.upsertItem({ id: '600', url: 'u', kind: 'article', title: 'Re-harvested' });
  it = await store.getItem('600');
  eq('cursor survives a re-harvest', it.cursor, 1);
  eq('snippets survive a re-harvest', it.snippets.length, 5);
  eq('title refreshes', it.title, 'Re-harvested');

  console.log('\nexport / import');
  reset();
  await seed('700', 5);
  await store.consume('700', 0);
  await store.consume('700', 1);
  const dump = await store.exportAll();
  eq('export is tagged', dump.format, 'article-drip/v1');

  // Simulate the other machine: same article, less progress.
  reset();
  await seed('700', 5);
  await store.importAll(dump, { merge: true });
  eq('merge keeps the further-read copy', (await store.getItem('700')).cursor, 2);

  // And the reverse: incoming copy is behind, local is ahead.
  await store.consume('700', 2);
  await store.consume('700', 3);
  await store.importAll(dump, { merge: true });
  eq('merge never rewinds local progress', (await store.getItem('700')).cursor, 4);

  let threw = null;
  try { await store.importAll({ format: 'nope' }); } catch (e) { threw = e; }
  check('rejects a foreign file', !!threw);

  console.log('\nsettings');
  reset();
  eq('defaults apply', (await store.getSettings()).everyNPosts, 4);
  await store.setSettings({ everyNPosts: 9 });
  eq('patch persists', (await store.getSettings()).everyNPosts, 9);
  eq('other defaults survive a patch', (await store.getSettings()).order, 'sequential');

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
