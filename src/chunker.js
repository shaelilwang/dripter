/* Article Drip — chunker.js
 *
 * Turns extracted article text into tweet-sized snippets, entirely offline.
 *
 * Input is an array of blocks: { type: 'heading' | 'para', text: '...' }
 * Output is an array of snippets: { text, kind, block, i }
 *
 * Rules, in priority order:
 *   1. Never merge across a block boundary. A paragraph break is a real
 *      authorial signal; honoring it is most of what makes chunks readable.
 *   2. Headings get their own snippet and act as section markers.
 *   3. Inside a paragraph, pack whole sentences greedily up to maxChars.
 *   4. A sentence longer than maxChars is split on clause boundaries
 *      (; — : ,) preferring a break in the back half of the budget.
 *   5. Only if there is no clause boundary do we break on a word boundary.
 *   6. Any forced break is marked with an ellipsis on both sides so you can
 *      see the seam and know the thought continues.
 *
 * Runs in the browser and in node (see tests/chunker.test.js).
 */
;(function (root) {
  root.AD = root.AD || {};

  const DEFAULTS = {
    /*
     * Cards are sized by STRUCTURE, not by a character budget.
     *
     * The unit is whatever the author already made a unit: a section runs
     * from one heading to the next, and a thread post is a post. A card
     * carries the whole thing, however long that happens to be, and the card
     * itself clamps the overflow behind "Show more" the way X does with its
     * own long posts.
     *
     * maxChars is only a safety valve for a pathologically long run, and it
     * splits at paragraph boundaries first. Set it to 0 for no cap at all.
     * Chasing a target length is what turned one thread into 264 cards
     * showing a single bullet each.
     */
    maxChars: 2500,
    minChars: 40,    // below this a trailing chunk is a "runt" worth merging
    mergeRunts: true,
    groupBySection: true,
  };

  // Words that end in a period and essentially never end a sentence.
  // Deliberately excludes anything that is also a common English word --
  // "no.", "sun.", "max." are far more often words than abbreviations, and
  // wrongly suppressing a break there is worse than missing "No. 5".
  const ABBREVIATIONS = new Set([
    'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'mt', 'rev', 'hon',
    'gen', 'sen', 'rep', 'gov', 'lt', 'col', 'capt', 'sgt', 'cmdr', 'adm',
    'vs', 'etc', 'al', 'cf', 'approx', 'est',
    'inc', 'ltd', 'corp', 'llc', 'plc', 'dept', 'univ', 'assn',
    'tue', 'thu', 'fri',
  ]);
  // Months and "Wed." live only in the numeric set below: they precede a day
  // number when abbreviated, but "slipped to Aug." and "they wed." are prose.

  // Reference abbreviations -- only non-breaking when a number follows, which
  // is what separates "No. 5" from "She said no." and "Ch. 2" from "the ch.".
  const NUMERIC_ABBREVIATIONS = new Set([
    'no', 'nos', 'vol', 'fig', 'figs', 'ch', 'chap', 'sec', 'para', 'art',
    'p', 'pp', 'pg', 'pt', 'ed', 'eds', 'st', 'ave', 'rd', 'apt', 'ste',
    'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct',
    'nov', 'dec', 'mon', 'tues', 'sat', 'sun',
  ]);

  // Multi-dot abbreviations, checked against the raw tail of the text.
  const DOTTED = /(?:^|[\s(])(?:e\.g|i\.e|a\.m|p\.m|u\.s|u\.k|e\.u|d\.c|ph\.d|b\.c|a\.d|et\.al)\.$/i;

  const ELLIPSIS = '…';

  /* ------------------------------------------------------------------ */
  /* text normalization                                                  */
  /* ------------------------------------------------------------------ */

  function normalize(text) {
    return String(text == null ? '' : text)
      // zero-width and bidi junk that X's renderer sprinkles in
      .replace(/[​-‍⁠﻿؜‪-‮]/g, '')
      // non-breaking and exotic spaces -> plain space
      .replace(/[   -   　]/g, ' ')
      // normalize newlines, then collapse runs of spaces/tabs
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .trim();
  }

  /** A block is a heading if it's short, unpunctuated, and not a fragment. */
  function looksLikeHeading(text) {
    if (text.length > 80) return false;
    if (/[.!?,;:]\s*$/.test(text)) return false;
    if (text.split(/\s+/).length > 12) return false;
    // Headings open with a capital or a number; a fragment mid-sentence
    // usually doesn't. This is what keeps broken-up prose out.
    if (!/^["'“(\[]?[A-Z0-9]/.test(text)) return false;
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* sentence splitting                                                  */
  /* ------------------------------------------------------------------ */

  /**
   * Decide whether a candidate terminator is a real sentence end.
   * `before` is everything up to and including the punctuation.
   * `after` is the remainder starting at the next non-space char.
   */
  function isRealBreak(before, after, punct) {
    // ! and ? are nearly always genuine.
    if (punct !== '.' && punct !== ELLIPSIS) return true;

    // "3.14" / "v1.2" — digit on both sides.
    if (/\d\.$/.test(before) && /^\d/.test(after)) return false;

    // Multi-dot abbreviations: e.g. / i.e. / U.S. / Ph.D.
    if (DOTTED.test(before)) return false;

    // Single capital initial: "J. R. R. Tolkien"
    if (/(?:^|[\s("'])[A-Z]\.$/.test(before)) return false;

    // Known abbreviation as the final word.
    const m = before.match(/([A-Za-z]+)\.$/);
    if (m) {
      const word = m[1].toLowerCase();
      if (ABBREVIATIONS.has(word)) return false;
      // "No. 5" / "Fig. 3" / "Jan. 12" -- only when a number actually follows.
      if (NUMERIC_ABBREVIATIONS.has(word) && /^[0-9IVXLC]/.test(after)) return false;
    }

    // A lowercase letter starting the next chunk usually means we misfired.
    // (Opening quotes/brackets are stripped before this check.)
    const firstLetter = after.replace(/^["'“‘(\[]+/, '')[0];
    if (firstLetter && firstLetter === firstLetter.toLowerCase() &&
        /[a-z]/.test(firstLetter)) return false;

    return true;
  }

  function splitSentences(text) {
    const out = [];
    // punctuation run, optional closing quotes/brackets, then whitespace
    const re = /([.!?…]+)(["'”’)\]]*)\s+/g;
    let last = 0;
    let m;

    while ((m = re.exec(text)) !== null) {
      const endOfPunct = m.index + m[1].length + m[2].length;
      const before = text.slice(last, m.index + m[1].length);
      const after = text.slice(re.lastIndex);
      const punct = m[1][m[1].length - 1];

      if (!isRealBreak(before, after, punct)) continue;

      const piece = text.slice(last, endOfPunct).trim();
      if (piece) out.push(piece);
      last = re.lastIndex;
    }

    const tail = text.slice(last).trim();
    if (tail) out.push(tail);
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* oversized-sentence splitting                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Split `s` into a head no longer than `budget` and the remainder.
   * Prefers a clause boundary in the back half of the budget, then a word
   * boundary. Adds ellipsis marks so the seam is visible.
   */
  function forceSplit(s, budget) {
    // Reserve two chars: the worst case appends " …" to the head.
    const room = Math.max(1, budget - 2);
    const floor = Math.floor(room * 0.55);
    const window = s.slice(0, room);

    let cut = -1;

    // Clause boundaries, best first.
    const clausePatterns = [
      /[;—]\s/g,          // semicolon, em dash
      /[:–]\s/g,          // colon, en dash
      /,\s(?=(?:and|but|or|which|who|that|while|because|although|though|so)\b)/g,
      /,\s/g,
    ];
    for (const re of clausePatterns) {
      re.lastIndex = 0;
      let m;
      let best = -1;
      while ((m = re.exec(window)) !== null) {
        const idx = m.index + m[0].length;
        if (idx >= floor && idx <= room) best = idx;
      }
      if (best > 0) { cut = best; break; }
    }

    // Fall back to the last space in the window.
    if (cut < 0) {
      const sp = window.lastIndexOf(' ');
      cut = sp > floor ? sp + 1 : room;
    }

    const head = s.slice(0, cut).replace(/\s+$/, '');
    const rest = s.slice(cut).replace(/^\s+/, '');
    if (!rest) return [head, ''];

    // Don't double up punctuation when the head already ends in one.
    const headOut = /[.,;:—–]$/.test(head)
      ? head + ELLIPSIS
      : head + ' ' + ELLIPSIS;

    return [headOut, ELLIPSIS + ' ' + rest];
  }

  /* ------------------------------------------------------------------ */
  /* packing                                                             */
  /* ------------------------------------------------------------------ */

  function packParagraph(text, opts) {
    const sentences = splitSentences(text);
    const out = [];
    let cur = '';

    const flushOversized = () => {
      while (cur.length > opts.maxChars) {
        const [head, rest] = forceSplit(cur, opts.maxChars);
        out.push(head);
        cur = rest;
        if (!cur) break;
      }
    };

    for (const s of sentences) {
      if (!cur) {
        cur = s;
      } else if (cur.length + 1 + s.length <= opts.maxChars) {
        cur += ' ' + s;
      } else {
        out.push(cur);
        cur = s;
      }
      flushOversized();
    }
    if (cur) out.push(cur);

    // Merge a too-short trailing chunk back into its predecessor when the
    // combined length still fits. Avoids stranding "It didn't." on its own.
    if (opts.mergeRunts && out.length > 1) {
      const lastIdx = out.length - 1;
      const a = out[lastIdx - 1];
      const b = out[lastIdx];
      if (b.length < opts.minChars &&
          !b.startsWith(ELLIPSIS) &&
          a.length + 1 + b.length <= opts.maxChars) {
        out.splice(lastIdx - 1, 2, a + ' ' + b);
      }
    }

    return out;
  }

  /* ------------------------------------------------------------------ */
  /* section packing                                                     */
  /* ------------------------------------------------------------------ */

  const isBullet = (s) => /^[•\-*–—]\s|^\d+[.)]\s/.test(String(s).trimStart());

  /**
   * Bullets in a run belong tight together; prose paragraphs get air.
   *
   * Tests the LAST LINE of what's accumulated so far, not its start. A
   * section that opens with prose and then lists bullets would otherwise
   * compare against the opening sentence every time and space every bullet
   * out with a blank line.
   */
  function joinerFor(soFar, next) {
    const lines = String(soFar).split('\n');
    return isBullet(lines[lines.length - 1]) && isBullet(next) ? '\n' : '\n\n';
  }

  /**
   * Turn a section's paragraphs into cards.
   *
   * Default behaviour is to keep the whole section together — the author's
   * own boundary is the right one. The cap only intervenes for a runaway
   * section, and even then it breaks between paragraphs; a sentence-level
   * split happens only when one paragraph alone exceeds the cap.
   *
   * A paragraph marked `atomic` is never merged with its neighbours. Thread
   * posts use that: a post is already a unit and shouldn't be glued to the
   * next one or torn apart.
   */
  function packSection(paras, opts) {
    const cap = opts.maxChars > 0 ? opts.maxChars : Infinity;
    const out = [];
    let cur = '';
    const flush = () => { if (cur) { out.push(cur); cur = ''; } };

    for (const para of paras) {
      const text = para.text;

      if (para.atomic) {
        flush();
        if (text.length <= cap) out.push(text);
        else for (const piece of packParagraph(text, { ...opts, maxChars: cap })) out.push(piece);
        continue;
      }

      if (text.length > cap) {
        flush();
        for (const piece of packParagraph(text, { ...opts, maxChars: cap })) out.push(piece);
        continue;
      }

      const candidate = cur ? cur + joinerFor(cur, text) + text : text;
      if (candidate.length <= cap) cur = candidate;
      else { flush(); cur = text; }
    }

    flush();
    return out;
  }

  /** Split blocks into { heading, paras } runs, one per heading. */
  function toSections(blocks, opts, trustHeuristic) {
    const sections = [];
    let cur = { heading: null, paras: [] };
    const flush = () => {
      if (cur.heading || cur.paras.length) sections.push(cur);
      cur = { heading: null, paras: [] };
    };

    for (const block of blocks) {
      const text = normalize(block && block.text);
      if (!text) continue;

      const isHeading = block.type === 'heading' ||
        (block.type !== 'para' && trustHeuristic && looksLikeHeading(text));

      if (isHeading && text.length <= 120) {
        flush();
        cur.heading = text;
      } else {
        cur.paras.push({ text, atomic: !!(block && block.atomic) });
      }
    }
    flush();
    return sections;
  }

  /* ------------------------------------------------------------------ */
  /* public API                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * @param {Array<{type:string,text:string}>|string} blocks
   * @param {object} [options]
   * @returns {Array<{text:string,kind:string,block:number,i:number}>}
   */
  function chunk(blocks, options) {
    const opts = Object.assign({}, DEFAULTS, options || {});

    // Accept a raw string for convenience: split it into blocks on blank lines.
    if (typeof blocks === 'string') {
      blocks = normalize(blocks)
        .split(/\n{1,}/)
        .map((t) => t.trim())
        .filter(Boolean)
        .map((t) => ({ type: looksLikeHeading(t) ? 'heading' : 'para', text: t }));
    }

    const snippets = [];
    let i = 0;

    /*
     * Guard against the heading heuristic running away.
     *
     * When an extractor hands us fragmented text — one short line per nested
     * div, or a list of article titles instead of one article's prose — a
     * large share of blocks look like headings, and the reader ends up with
     * a card full of bold fragments and no actual content.
     *
     * A real article is mostly prose. If most untyped blocks read as headings
     * the heuristic is wrong about this document, so stop trusting it here.
     * Blocks explicitly typed by the extractor are always honoured.
     */
    const untyped = blocks.filter((b) => b && !b.type && normalize(b.text));
    const headingish = untyped.filter((b) => looksLikeHeading(normalize(b.text)));
    const trustHeuristic =
      !(untyped.length >= 4 && headingish.length / untyped.length > 0.5);

    if (!opts.groupBySection) {
      // One card per paragraph. Kept for callers that want the old shape.
      blocks.forEach((block, bi) => {
        const text = normalize(block && block.text);
        if (!text) return;
        const isHeading = block.type === 'heading' ||
          (block.type !== 'para' && trustHeuristic && looksLikeHeading(text));
        if (isHeading && text.length <= opts.maxChars) {
          snippets.push({ text, kind: 'heading', block: bi, i: i++ });
          return;
        }
        for (const t of packParagraph(text, opts)) {
          snippets.push({ text: t, kind: 'para', block: bi, i: i++ });
        }
      });
      return snippets;
    }

    // A heading rides along with the prose underneath it rather than taking a
    // card of its own — a card that is nothing but a heading tells you
    // nothing, and you have to advance past it to reach the actual content.
    for (const sec of toSections(blocks, opts, trustHeuristic)) {
      const parts = packSection(sec.paras, opts);

      if (!parts.length) {
        if (sec.heading) {
          snippets.push({ text: sec.heading, kind: 'heading', heading: null, i: i++ });
        }
        continue;
      }

      parts.forEach((text, k) => {
        snippets.push({
          text,
          kind: 'para',
          // Continuation cards keep the heading for context, marked so it's
          // clear you're still inside the same section.
          heading: !sec.heading ? null
            : (k === 0 ? sec.heading : sec.heading + ' (cont.)'),
          i: i++,
        });
      });
    }

    return snippets;
  }

  const api = {
    chunk,
    normalize,
    splitSentences,
    looksLikeHeading,
    forceSplit,
    DEFAULTS,
  };

  root.AD.chunker = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
