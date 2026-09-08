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
python3 -m http.server 8777          # then open /tests/harness.html for the
                                     # injection tests (needs a real browser)
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

## Scope boundaries the user set

- **X-native content only** — native Articles and threads. No fetching or
  parsing of external article URLs; that was explicitly descoped (paywalls,
  cross-origin permissions, unreliable parsing).
- **Local chunking only** — no LLM calls, no API keys. `chunker.js` has a clean
  seam if smart chunking is ever wanted, but it isn't wanted now.
- **Never writes to the account.** No posting, liking, following, or DMing.
  Read and render only.
