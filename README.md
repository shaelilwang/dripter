# Article Drip

Takes the X Articles and threads you've bookmarked, chops them into
tweet-sized snippets, and slides them into your home feed between real posts —
so the stuff you saved gets read in the same scroll where you saved it.

No API keys. No paid X tier. No servers. Everything runs locally in your
browser against the session you're already logged into.

---

## What it actually does

1. **Harvest** — reads your bookmarks page and records which items are native
   X Articles or self-threads worth reading.
2. **Fetch** — visits each one in a background window and pulls its full text
   out of the page.
3. **Chunk** — splits that text into ~270-character snippets offline, breaking
   on sentence and paragraph boundaries rather than mid-thought.
4. **Drip** — as you scroll `/home`, inserts a snippet card after every Nth
   real post. Each card tracks where you are (`12 / 47`) and remembers.

Progress is per-article and persistent. Scroll past a card and it counts as
read; hit **Next ›** to burn through several in place without scrolling.

### One thing it can't do

It cannot put snippets into X's *server-side* For You ranking — no API, paid
or otherwise, exposes that. This injects into the feed **as rendered in your
browser**. The reading experience is what you asked for; the ranking model
upstream is untouched. Nothing is posted, sent, or written to your account.

---

## Install

No build step, no dependencies.

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select this folder
4. Open [x.com/i/bookmarks](https://x.com/i/bookmarks)
5. Click the extension icon → **Harvest bookmarks**
6. Click **Fetch article bodies** — a second window opens unfocused and works
   through them. Leave it alone; it closes itself.
7. Go to your feed and scroll.

Works in any Chromium browser: Chrome, Arc, Brave, Edge.

---

## Using it

**Popup** (extension icon) — counts, what's up next, the three action buttons,
and the on/off switch.

**Settings & library** (link at the bottom of the popup):

| Setting | Default | What it does |
|---|---|---|
| Insert a snippet every | 4 posts | Card density in the feed |
| Snippet length | 270 chars | Applies to newly fetched articles |
| Order | Sequential | Finish one article before starting the next |
| Count as read after | 900 ms | Dwell time before a card auto-advances |
| Minimum thread length | 3 posts | Shorter self-threads get skipped |

The library lists every article with a progress bar, and lets you restart,
finish, or remove any of them.

**Card buttons** — `Later` moves to a different article without consuming the
snippet, `Done` retires the article, `Open` opens the original, `Next ›` marks
this one read and loads the following snippet in place.

---

## Moving it between machines

**The code:** copy the folder, or `git clone` it, then Load unpacked. That's it
— nothing to install.

**Your library and progress:** Settings → **Export JSON**, then **Import JSON**
on the other machine. Import merges rather than overwrites, and for any article
on both sides it keeps whichever copy has read further, so syncing in either
direction never rewinds you.

`./make-zip.sh` builds a distributable `article-drip.zip` with the tests
stripped out.

---

## When it breaks

X reshuffles its DOM regularly. When that happens the extension goes quiet
rather than crashing — no cards, or a harvest that finds nothing.

**Every selector lives in one file: [`src/selectors.js`](src/selectors.js).**
Nothing else in the codebase contains an x.com selector string.

To find out what's wrong:

1. Open the page that's misbehaving (bookmarks, home, an Article)
2. Extension icon → **Selector Doctor**
3. The options page shows every selector with a live match count

A `✕` on the page that selector belongs to is your culprit. Add the new working
selector to the *front* of that key's array in `src/selectors.js` and reload the
extension. The lists are ordered fallbacks — leaving the old entries in place
costs nothing and keeps it working on older X builds.

Some `✕` marks are normal: `articleBody` only resolves on an Article page,
`cell` only on a timeline.

### Other things to try

- **No cards in the feed** — check the popup switch is on and "snippets left"
  is above zero. If it's zero, you need a Fetch.
- **Fetch keeps failing** — X was probably still rendering. Re-run it; failed
  items are retried. Check the library filter `failed` to see what didn't land.
- **Nothing harvested** — you have to be on `x.com/i/bookmarks` with the list
  visible before clicking Harvest.
- **Harvest stops early** — keep the tab in the foreground while it scrolls.

---

## Tests

```bash
./run-tests.sh
```

Runs the offline suites (chunker, store) in node, then tells you how to open
the browser harness — a fake timeline with x.com's structural contract that
exercises card injection, idempotency under virtualization churn, and the
snippet hand-out logic.

What's covered: text chunking and sentence splitting, the reading state
machine, export/import merge, and injection behavior.

**What isn't:** the selectors in `src/selectors.js` have not been verified
against a live logged-in x.com, because that needs your session. They follow
X's long-standing `data-testid` conventions and are layered with fallbacks, but
Selector Doctor is the ground truth — run it once after installing.

---

## Layout

```
manifest.json          MV3, no build step
src/
  selectors.js         every x.com selector, ordered fallbacks + doctor
  dom.js               waiting, auto-scroll, SPA route watching
  chunker.js           text -> snippets (pure, no DOM, node-testable)
  store.js             chrome.storage wrapper + reading state machine
  collect.js           harvests the bookmarks page
  extract.js           pulls Article / thread bodies
  card.js              snippet card + theme sampling + hand-out reservation
  card.css             card styling, themed off the live page
  inject.js            the idempotent timeline sweep
  main.js              content-script router
  background.js        service worker; drives the fetch job
ui/                    popup + options page
tests/                 node suites and the browser harness
```

## Notes

- Reads only pages you're already logged into. Nothing leaves your machine.
- Never posts, likes, follows, or modifies your account.
- Automated scrolling of your own bookmarks is a grey area under X's ToS.
  It's your data, in your browser, for your own reading — but that's the call
  you're making by running it.
