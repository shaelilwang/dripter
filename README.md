# Article Drip

Takes the X Articles and threads you've bookmarked, chops them into
tweet-sized snippets, and slides them into your home feed between real posts —
so the stuff you saved gets read in the same scroll where you saved it.

No API keys. No paid X tier. No servers. Everything runs locally in your
browser against the session you're already logged into.

---

## What it actually does

1. **Harvest** — records every bookmark. It deliberately doesn't filter by
   length: X renders native Articles in the bookmarks list as ordinary, often
   short, posts, so the list can't tell you what's long-form.
2. **Fetch** — opens each one in a background window, which is where the
   Article body actually lives, and works out what it really is: Article,
   thread, long post, or not worth dripping.
3. **Chunk** — splits it by *structure*, never by length. Sections (heading to
   heading) and thread posts are the units, and adjacent ones are merged until
   an article fits in at most 5 cards. Only the boundaries move — the text is
   verbatim. Nothing is cut, reworded, bulleted or quoted that wasn't already,
   and a line is only shown as a heading if the source marked it up as one.
   Cards clamp overflow behind "Show more", as X does with its own long posts.
4. **Drip** — as you scroll `/home`, inserts a snippet card after every Nth
   real post. Each card tracks where you are (`12 / 47`) and remembers.

Progress is per-article and persistent. A card counts as read once you've
scrolled after it appeared and it's been on screen a moment — merely loading
a page never advances anything, so refreshing costs you nothing. Hit
**Next ›** to burn through several in place.

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
4. Open [x.com/i/bookmarks](https://x.com/i/bookmarks) — `x.com/i/history`
   works too, and harvests the same way
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
| Cards per article | 5 | An article becomes at most this many cards, merged at section boundaries |
| Maximum card length | 0 (off) | Above 0, splits sentences to hit a length and inserts ellipses — changes what you read |
| Order | Sequential | Finish one article before starting the next |
| Count as read after | 900 ms | Dwell time before a card auto-advances |
| Minimum thread length | 3 posts | Shorter self-threads get skipped |
| Minimum post length | 500 chars | Lone posts shorter than this are skipped |
| What to open when fetching | Likely only | "Everything" opens every bookmark to find Articles disguised as plain posts |

The library lists every article with a progress bar, and lets you restart,
finish, or remove any of them individually.

**Bulk actions** act on whatever the state filter above them is showing —
select `reading` and "Mark read" retires only those:

| Button | What it does |
|---|---|
| Mark all read | Retires them so they stop appearing in your feed. Nothing is deleted. |
| Retry failed | Puts failed extractions back in the queue for the next fetch. |
| Remove finished | Drops finished articles from the library entirely. |
| Re-chunk everything | Re-splits already-fetched articles with the current settings. No re-fetching — the extracted text is kept, and reading position carries across. |

### Nothing gets re-done

- **Re-harvesting never rewinds you.** Re-seeing a bookmark refreshes its title
  and author only — state, snippets and reading position are left alone.
- **Fetching never re-fetches.** The job only picks up `pending` items, so
  anything already read is skipped.
- **Re-harvests stop early.** Bookmarks are newest-first, so once three
  screenfuls in a row turn up nothing new, the scroll stops rather than
  re-reading your whole backlog. Turn this off under "What to collect" if you
  ever need a full re-scan.

Snippets also clear themselves as you read: a card that stays on screen for
900 ms counts as read and the article advances. That's the "count as read
after" setting, and the switch above it turns it off if you'd rather only
advance by pressing **Next ›**.

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
- **Fetch keeps failing** — X was probably still rendering. Failed items are
  *not* retried automatically; the fetch job only looks at `pending`. Use
  **Retry failed** in the library to requeue them, then fetch again.
- **Nothing harvested** — you have to be on `x.com/i/bookmarks` or
  `x.com/i/history` with the list visible before clicking Harvest.
- **An article shows only headings** — extraction now refuses these rather
  than shipping them, so it lands in the library as `failed` with the reason.
  Check the per-item line: it reports coverage and heading ratio.
- **Harvest stops early** — keep the tab in the foreground while it scrolls.
- **Cards fade out and say "reload tab to resume"** — you reloaded the
  extension while that x.com tab was open. Chrome doesn't reload content
  scripts in open tabs, so the script running there lost its connection to the
  extension. Reload the x.com tab. (After any `chrome://extensions` reload,
  reload your x.com tabs too.)

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

**Partly verified:** a live authenticated Doctor run confirmed the structural
selectors — `cellInnerDiv`, `tweet`, `tweetText`, `User-Name`, and the
timestamp permalink. Those are real, not guesses.

**Not verified:** the `articleBody` selectors, which only appear on an Article
page. `extract.js` therefore carries `findProseFallback()`, a structural search
for the deepest element holding the page's prose, so extraction works even when
the named selectors miss. It logs to the console when it fires — if you see
that, run Selector Doctor on that page and add the real selector to
`src/selectors.js` so the fallback stops being needed.

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
