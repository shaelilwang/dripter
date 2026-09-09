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

**X mixes testid casing.** The Article body is `twitterArticleRichTextView`
(camelCase); the Article title is `twitter-article-title` (hyphenated). Both
confirmed live. Guessing one convention from the other is what hid the title
selector for several rounds — when adding a selector, try both casings, and
add a `[data-testid*="..." i]` wildcard alongside.

**The title sits OUTSIDE the rich-text body**, so `articleTitleExact` is
queried page-wide. That is only safe because those names cannot match anything
else; the looser `articleTitle` list ends in a bare `h1` and must stay scoped
to the body, or it returns X's "Conversation" chrome heading.

**An Article page's title is not a heading.** Confirmed by diagnosing a live
Article: the only h1/h2 outside the rich-text body are X's own chrome
("Article", "Conversation"), and every h2 inside it is one of the article's
section headings. `titleAboveBody()` therefore finds the title by type size —
the largest single line rendered above the body, inside primaryColumn, at 20px
or more. Nothing found means no title claimed; the harvested name stands in.
`[data-testid="twitterArticleRichTextView"]` is confirmed as the body selector.

**Re-chunk cannot fix a bad capture.** It only rearranges stored blocks. An
item captured by an older extractor can hold one undifferentiated block with
no headings, and that needs `requeueMany()` plus a fetch to read the page
again. The diagnostic flags this by comparing stored block count against what
the live page yields.

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

**Two sizing modes, not stacked.** `maxChars` (default 1000) is the normal
driver: pack paragraphs to roughly that size, splitting an overlong paragraph
at sentence boundaries. `maxCards` (default 0 = off) is an alternative cap that
merges whole sections via `groupSections()`; when it is set it OVERRIDES
maxChars entirely and atomic posts merge too, because "at most N cards" is
exactly what was asked for. `groupSections` balances with a one-step lookahead
— closing the moment a group reaches its share starves the tail (twelve equal
sections came out 3,3,3,2,1).

**Splitting never mutates.** `packSentences` breaks between sentences only; a
sentence longer than the target is emitted whole. The old `forceSplit` cut
mid-sentence and stitched ellipses over the seam, showing the reader text the
author never wrote. It is deleted — don't bring it back.

**A single unstructured post must still produce several cards.** With no
headings the whole thing is one section, which used to mean one card and a
feed showing exactly one drip before running dry.

**Harvest reads `/i/history` as well as `/i/bookmarks`.** Same markup, and it
is where the user actually browses.

**The text is never altered. This is a hard rule the user has restated three
times.** No injected bullet glyphs, no added quote marks, no ellipses, no
rewording. `maxChars` defaults to 0 for exactly this reason. If you find
yourself adding a character the source didn't have, stop.

**A heading is only a heading if the markup said so.** `toSections` honours
`type: 'heading'` and nothing else. Inferring one from text shape promoted a
thread post's opening line ("1. Electronics fundamentals") into a bold header
and lifted it out of its own body — inventing structure the author never
wrote. `looksLikeHeading` and the heading-runaway guard it required are both
gone; don't reintroduce either.

**Settings must actually reach the chunker.** `maxCards` was added to the
options page and defaults but never passed by `extractInto` or `rechunkAll`,
so the cap silently did nothing and articles still came out at 50 cards. Both
call sites pass the full settings now.

**Never trust a sampled colour.** `applyTheme` reads the foreground from real
post text (`themeProbeFg`), because `<body>`'s colour on x.com is often the
light-theme default even in Dim/Lights-out — which rendered near-black cards
on a black background. Whatever is sampled is then checked with
`contrastRatio()` against the sampled background and replaced if it is below
4.5:1.

**Visibility is not reading.** Cards get injected a few posts down, often
inside the opening viewport, so dwell-on-screen alone counted them as read
within a second of every page load — refreshing burned through snippets. A
card is stamped with `scrollTick` when placed and only becomes eligible once
the reader scrolls afterwards. The scroll handler must also re-check
already-visible cards: IntersectionObserver fires on intersection CHANGES, so
a card that stays on screen would otherwise never be re-evaluated.

**One card per article, enforced by `peekNext(exclude)`.** `card.takeNext()`
passes the ids already rendered, read from the DOM so it cannot go stale. This
replaced a `handedOut` map that dealt successive indices of one article to
every insertion point — which is why Next appeared to jump three or four
snippets at once, since it had to step past indices the other visible cards
had reserved. Don't reintroduce per-index reservation.

**Back and Next stay inside the article** via `paintItem()`; only `Done` and
an exhausted article move the card on with `repaint()`. There was briefly a
Skip button that advanced without counting as read — it was removed as
redundant with Done, so don't add one back. `Later` calls
`store.snooze()` and deliberately does NOT change what the card shows — being
instantly replaced reads like the button did something else. The snooze holds
an article back only while something else is available.

**`packSentences` splits on line breaks first.** `splitSentences` treats \n as
ordinary whitespace, so feeding it a whole paragraph and rejoining with spaces
flattened every line break — a post with a lead-in line and a list came back as
one unbroken run. Split on `/(\n+)/`, keep the exact newline runs as
separators, and fall back to sentences only inside an over-long single line.

**Clamp measurement happens after insertion**, from `inject.sweep()` once the
node is attached. `render()` runs while it is still detached where everything
measures zero, and the ResizeObserver alone does not reliably catch the
transition into the document.

**The card body is one block per paragraph, not a pre-wrap text node.**
`renderBody()` splits on blank lines and emits an `.ad-p` per paragraph, so
the gap between them is a margin rather than a single blank line — a wall of
text was the complaint. Single newlines stay inside a paragraph (pre-wrap) so
list runs stay tight. `-webkit-line-clamp` still works over these block
children; the clamp test covers it.

**The title comes from the article body, not from a page-wide query.**
`articleTitleFor()` reads `articleTitle` scoped to `bodyEl`, then falls back to
the first heading block. It deliberately does NOT search the document: that
list ends in a bare `h1`, and page-wide it returns X's own chrome heading — a
confidently wrong title is worse than none, since the harvested name stands in.
Before this, the selectors always missed and every card was headed with the
author's name while the real title sat unused in the body.

`rechunkAll()` repairs items extracted before that, hoisting the opening
heading out of the stored blocks — gated on the current title being one of the
old author-name fallbacks, so a good title never gets overwritten by a section
heading.

## Scope boundaries the user set

- **X-native content only** — native Articles and threads. No fetching or
  parsing of external article URLs; that was explicitly descoped (paywalls,
  cross-origin permissions, unreliable parsing).
- **Local chunking only** — no LLM calls, no API keys. `chunker.js` has a clean
  seam if smart chunking is ever wanted, but it isn't wanted now.
- **Never writes to the account.** No posting, liking, following, or DMing.
  Read and render only.
