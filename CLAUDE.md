# Article Drip — notes for Claude

MV3 Chrome extension. Chunks the user's bookmarked X Articles and threads into
tweet-sized snippets and injects them into the rendered home timeline.

**No build step, no dependencies, no package.json.** Plain ES2020 in the
browser. Don't add a bundler, TypeScript, or npm — portability across machines
is an explicit product requirement, and "copy the folder and Load unpacked" is
the feature.

## Running things

```bash
./run-tests.sh                       # node suites: chunker + store
python3 tests/serve.py               # then open /tests/harness.html for the
                                     # injection tests (needs a real browser).
                                     # Use this, not `python -m http.server`:
                                     # that one lets the browser heuristically
                                     # cache src/*.js, so you end up testing
                                     # code you already changed.
```

The harness shims `chrome.*` in-page and builds a fake timeline matching
x.com's structural contract. It is the only way to test `inject.js` and
`card.js` without a logged-in session — use it when touching either.

## Architecture

Content scripts share one isolated-world global, `AD`. The manifest loads them
in dependency order (selectors → dom → chunker → store → collect → extract →
card → inject → main); a file may only reference earlier ones at load time,
though anything goes at call time.

| File | Role |
|---|---|
| `selectors.js` | **Every** x.com selector. Ordered fallback arrays + `doctor()`. |
| `chunker.js` | Pure text → snippets. No DOM. Node-testable, and tested. |
| `store.js` | `chrome.storage.local` + the reading state machine. Also node-testable. |
| `collect.js` | Harvests `/i/bookmarks` into items. |
| `extract.js` | Pulls Article / thread bodies from the page it's running on. |
| `card.js` | Card DOM, theme sampling, **and snippet hand-out reservation**. |
| `inject.js` | The timeline sweep. |
| `background.js` | Service worker. Drives the fetch job via an unfocused window. |

## Things that will bite you

**Selectors are unverified against live x.com.** They were written from X's
long-standing `data-testid` conventions, not observed from a logged-in
session — nobody has been able to confirm them. If the user reports "nothing
happens", get them to run Selector Doctor before you change any logic. The
failure mode of a bad selector looks identical to a logic bug.

**The sweep must stay idempotent.** `inject.js` never counts posts
incrementally — X virtualizes the feed, so any running tally drifts the moment
React recycles cells. Every pass re-walks the current children and inserts only
where a card is missing. If you change that function, keep the harness's
"virtualization churn" and "idempotency" tests green.

**Snippet hand-out is centralized in `card.takeNext()`.** Both the injector
(placing new cards) and the Next button (repainting in place) must draw through
it, or two visible cards show the same text. This was a real bug once; there's
a regression test named `Next does not duplicate a snippet another card shows`.

**Two timeline layout modes.** X has shipped both a normal-flow timeline and an
absolutely-positioned virtualized one. `placeCard()` detects which and either
inserts a sibling or nests inside the cell. Both are covered in the harness.

**Background tabs render badly.** The fetch job deliberately uses an unfocused
*window*, not a hidden tab: Chrome throttles rAF and defers rendering in hidden
tabs, and X lazy-renders long articles, so a hidden tab yields truncated text.
Don't "optimize" this into `tabs.create({active:false})`.

**MV3 workers get suspended** after ~30s idle, which would strand a long fetch
run. `background.js` holds a `chrome.runtime.getPlatformInfo` keepalive for the
duration of a job only.

**`consume(id, index)` is strict** — it no-ops unless `index === cursor`. That
makes out-of-order consumption safe by repeating a snippet rather than skipping
one. For a reading tool, repeating is the correct failure direction. Don't
"fix" it into an unconditional `cursor = index + 1`.

**Storage writes are whole-object.** `chrome.storage.local.set({items})`
rewrites the entire library every call, so per-item writes in a loop are
O(n^2). `upsertMany()` exists for that reason -- harvest batches a screenful
into one read/write. Don't reintroduce a per-item `upsertItem` inside a loop.

**Harvest's early stop keys on `scanned`, not `known`.** Re-running a harvest
without reloading the tab skips posts already marked `adSeen` that session, so
it reports neither fresh nor known items. An early-stop condition requiring
`known > 0` silently never fires there and the harvest scrolls to the bottom.

**Card theme vars belong on `:root`, never on `.ad-card`.** `applyTheme()`
samples X's live colors and writes them as inline properties on `<html>`. A
custom property declared on `.ad-card` itself beats one inherited from an
ancestor, so declaring the fallbacks there silently defeated all of it and the
card rendered white on Lights-out. The fallbacks live in `:root` for that
reason -- don't move them back.

**Use `innerText` for article bodies, not `dom.richText()`.** richText emits a
newline after every DIV; X's Article markup is deeply nested divs, so it
shatters prose into one fragment per div. Those fragments then trip the
chunker's heading heuristic and the reader gets a card of bold fragments with
no content. innerText breaks where the browser actually breaks.

**The chunker distrusts its own heading heuristic in bulk.** If more than half
of the untyped blocks look like headings, it treats them all as prose --
that ratio means the extractor handed over fragments, not a structured
document. Explicitly typed blocks always win.

**Cards are sized by structure, not by a character budget.** A section (one
heading to the next) is one card; a thread post is one card. `maxChars` is a
safety valve that splits between paragraphs, and 0 disables it. Targeting a
length is what turned a single thread into 264 cards showing one bullet each.
Thread blocks carry `atomic: true` so they are neither merged with their
neighbours nor shredded into their own lines, and `type: 'para'` so a short
post like "1. Get a microcontroller" isn't read as a heading.

**Headings ride on their section's first card** as `snippet.heading`, rather
than getting a card of their own — a card that is only a heading tells the
reader nothing and has to be advanced past. Continuations get "(cont.)".

**`joinerFor` tests the last line of the accumulated text, not its start.**
A section that opens with prose then lists bullets would otherwise compare
each bullet against the opening sentence and space the whole list out.

**Extracted blocks are stored on the item** so `rechunkAll()` can re-split
after a settings change without re-opening every article in a browser tab.

**Content scripts outlive the extension that injected them.** Reloading or
updating the extension does NOT reload content scripts in open tabs; theirs
keep running with a severed bridge, and every chrome.* call throws "Extension
context invalidated". `src/lifecycle.js` detects that (chrome.runtime.id goes
undefined), tears down once, and marks the on-screen cards stale. Anything new
that polls, observes, or touches chrome.* on a timer must register with
`life.onTeardown()` or use `life.guardedInterval()`, or it will spin forever in
an orphaned tab. Register at module load, not inside start() — teardown can
happen before startup finishes.

**Semantic markup is only trusted when it carries the text.** X emits headings
as real `<h2>` but body paragraphs as plain `<div>`. The old
`semantic.length >= 3` test was satisfied by the headings alone, so the
semantic branch won and every div of prose was discarded — articles arrived as
nothing but headings. `blocksFromArticle` now requires the semantic elements to
account for >=60% of `bodyEl.innerText` before trusting them, and otherwise
falls back to innerText while recovering headings by matching against the
`<h1>-<h6>` text. `assessBlocks()` reports coverage and heading ratio, and
`extractInto` refuses an extraction that is >80% headings or <40% coverage.

**Cards per article is capped by merging sections, never by cutting text.**
`groupSections()` moves boundaries only, balanced by length with a one-step
lookahead (closing the moment a group reaches its share starves the tail:
twelve equal sections came out 3,3,3,2,1). `maxChars` defaults to 0 and should
stay there — above 0 it re-enables sentence splitting, which inserts ellipses
and alters the text.

**Harvest reads `/i/history` as well as `/i/bookmarks`.** Same markup, and it
is where the user actually browses.

## Scope boundaries the user set

- **X-native content only** — native Articles and threads. No fetching or
  parsing of external article URLs; that was explicitly descoped (paywalls,
  cross-origin permissions, unreliable parsing).
- **Local chunking only** — no LLM calls, no API keys. `chunker.js` has a clean
  seam if smart chunking is ever wanted, but it isn't wanted now.
- **Never writes to the account.** No posting, liking, following, or DMing.
  Read and render only.
