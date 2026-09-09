/* Article Drip — chunker.js
 *
 * Turns an extracted article into a handful of feed cards, entirely offline.
 *
 * Input is an array of blocks: { type: 'heading' | 'para', atomic?, text }
 * Output is an array of snippets: { text, kind, heading, i }
 *
 * The content is never rewritten. Cards are decided by moving BOUNDARIES,
 * not by cutting text to a length:
 *
 *   1. Blocks become sections: a heading starts one, and a thread post is a
 *      section on its own.
 *   2. Adjacent sections are merged until there are at most `maxCards` of
 *      them, balanced by length so cards come out roughly even.
 *   3. Each group becomes one card. The group's first heading goes in the
 *      card header; any further headings stay inline so nothing is lost.
 *
 * Only if `maxChars` is set above 0 does sentence-level splitting come back,
 * which inserts ellipsis marks and therefore does change what you read.
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
    // Roughly how much text a card carries. Splitting happens only at
    // paragraph and sentence boundaries the author already wrote, and never
    // by inserting or removing characters. 0 means no target at all.
    maxChars: 1000,
    // Optional hard ceiling on cards per article, reached by merging whole
    // sections. 0 = off, which lets maxChars decide how many cards there are.
    maxCards: 0,
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
  /* sentence packing                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Split one long paragraph into card-sized pieces at sentence boundaries.
   *
   * A sentence longer than the target is emitted whole rather than cut. The
   * previous version broke mid-sentence and stitched ellipses over the seam,
   * which meant the reader saw text the author never wrote.
   */
  function packSentences(text, target) {
    const out = [];
    let cur = '';
    for (const sentence of splitSentences(text)) {
      if (!cur) { cur = sentence; continue; }
      if (cur.length + 1 + sentence.length <= target) cur += ' ' + sentence;
      else { out.push(cur); cur = sentence; }
    }
    if (cur) out.push(cur);
    // No sentence boundaries at all: keep it in one piece.
    return out.length ? out : [text];
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
   * Pack paragraphs into cards of roughly `target` characters.
   *
   * Breaks ONLY where the author already broke: between paragraphs first,
   * and between sentences when a single paragraph overruns on its own. A
   * sentence is never cut, and nothing is ever inserted — no ellipses, no
   * markers. If one sentence is longer than the target, that card is simply
   * longer; mangling the text to hit a number is not a trade worth making.
   *
   * A paragraph marked `atomic` never merges with its neighbours. Thread
   * posts use that: a post is the author's unit, so it starts its own card
   * and the next one doesn't get glued onto it.
   */
  function packToTarget(paras, target) {
    const cap = target > 0 ? target : Infinity;
    const out = [];
    let cur = '';
    const flush = () => { if (cur) { out.push(cur); cur = ''; } };

    for (const para of paras) {
      const text = para.text;

      if (para.atomic) {
        flush();
        if (text.length <= cap) out.push(text);
        else for (const piece of packSentences(text, cap)) out.push(piece);
        continue;
      }

      if (text.length > cap) {
        flush();
        for (const piece of packSentences(text, cap)) out.push(piece);
        continue;
      }

      if (!cur) { cur = text; continue; }
      const joiner = joinerFor(cur, text);
      if (cur.length + joiner.length + text.length <= cap) cur += joiner + text;
      else { flush(); cur = text; }
    }

    flush();
    return out;
  }

  /**
   * Split blocks into { heading, paras } runs, one per heading.
   *
   * ONLY an explicit `type: 'heading'` counts — that comes from a real
   * <h1>-<h6> in the source. Guessing at headings from text shape invented
   * structure the author never wrote: a thread post opening "1. Electronics
   * fundamentals" was promoted to a bold header and lifted out of its own
   * body. If the source didn't mark it up, it's prose.
   */
  function toSections(blocks, opts) {
    const sections = [];
    let cur = { heading: null, paras: [] };
    const flush = () => {
      if (cur.heading || cur.paras.length) sections.push(cur);
      cur = { heading: null, paras: [] };
    };

    for (const block of blocks) {
      const text = normalize(block && block.text);
      if (!text) continue;

      if (block.type === 'heading' && text.length <= 120) {
        flush();
        cur.heading = text;
      } else if (block && block.atomic) {
        // A thread post is its own section, so a 20-post thread has 20
        // sections to distribute rather than one giant one.
        flush();
        cur.paras.push({ text, atomic: true });
        flush();
      } else {
        cur.paras.push({ text, atomic: false });
      }
    }
    flush();
    return sections;
  }

  const sectionChars = (sec) =>
    (sec.heading ? sec.heading.length : 0) +
    sec.paras.reduce((n, p) => n + p.text.length, 0);

  /**
   * Merge adjacent sections until there are at most `maxGroups` of them.
   *
   * Only the boundaries move — no text is split, trimmed or rewritten, so
   * what you read is exactly what the author wrote. Groups are balanced by
   * character count so one card isn't a paragraph while the next is half the
   * article.
   */
  function groupSections(sections, maxGroups) {
    const n = sections.length;
    if (!maxGroups || maxGroups < 1 || n <= maxGroups) {
      return sections.map((s) => [s]);
    }

    const weights = sections.map(sectionChars);
    const total = weights.reduce((a, b) => a + b, 0);

    const groups = [];
    let cur = [];
    let curW = 0;
    let consumed = 0;

    for (let i = 0; i < n; i++) {
      cur.push(sections[i]);
      curW += weights[i];
      consumed += weights[i];

      const remainingSections = n - i - 1;
      const remainingGroups = maxGroups - groups.length - 1;

      // Every remaining group needs at least one section, so stop here if
      // we're about to starve them.
      if (remainingSections <= remainingGroups) {
        groups.push(cur); cur = []; curW = 0;
        continue;
      }

      // Close once this group is as near its share as it's going to get.
      //
      // Look one section ahead rather than closing the moment the share is
      // reached: always overshooting leaves the tail starved (twelve equal
      // sections came out 3,3,3,2,1 instead of 2,2,3,2,3).
      const share = (total - (consumed - curW)) / (maxGroups - groups.length);
      const nextW = i + 1 < n ? weights[i + 1] : 0;
      const stopHere = Math.abs(curW - share);
      const takeMore = Math.abs(curW + nextW - share);

      if (remainingGroups > 0 && stopHere <= takeMore) {
        groups.push(cur); cur = []; curW = 0;
      }
    }
    if (cur.length) groups.push(cur);

    // Belt and braces: never hand back more groups than asked for.
    while (groups.length > maxGroups) {
      const tail = groups.pop();
      groups[groups.length - 1] = groups[groups.length - 1].concat(tail);
    }
    return groups;
  }

  /** Flatten a group of sections into card-sized pieces, verbatim. */
  function groupText(group, opts) {
    const paras = [];
    group.forEach((sec, k) => {
      // The first section's heading goes in the card header; any further
      // headings stay inline so no content is lost.
      if (k > 0 && sec.heading) paras.push({ text: sec.heading, atomic: false });
      for (const p of sec.paras) paras.push(p);
    });

    // maxChars and maxCards are alternative modes, not stacked. Asking for at
    // most N cards means N is the answer, so the length target steps aside —
    // and so does the rule that thread posts stand alone, since merging them
    // is precisely what the cap asked for.
    if (opts.maxCards > 0) {
      let text = '';
      for (const p of paras) {
        text = text ? text + joinerFor(text, p.text) + p.text : p.text;
      }
      return text ? [text] : [];
    }

    return packToTarget(paras, opts.maxChars);
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

    // Accept a raw string for convenience: split it into blocks on blank
    // lines. Everything is prose — a plain string carries no markup, so
    // there is nothing to justify calling any line a heading.
    if (typeof blocks === 'string') {
      blocks = normalize(blocks)
        .split(/\n{1,}/)
        .map((t) => t.trim())
        .filter(Boolean)
        .map((t) => ({ type: 'para', text: t }));
    }

    const snippets = [];
    let i = 0;

    // A heading rides along with the prose underneath it rather than taking a
    // card of its own — a card that is nothing but a heading tells you
    // nothing, and you have to advance past it to reach the actual content.
    const sections = toSections(blocks, opts);
    const groups = groupSections(sections, opts.maxCards);

    for (const group of groups) {
      const heading = group[0].heading;
      const parts = groupText(group, opts).filter(Boolean);

      if (!parts.length) {
        // Nothing but a heading in this group — show it rather than drop it.
        if (heading) {
          snippets.push({ text: heading, kind: 'heading', heading: null, i: i++ });
        }
        continue;
      }

      parts.forEach((text, k) => {
        snippets.push({
          text,
          kind: 'para',
          heading: !heading ? null
            : (k === 0 ? heading : heading + ' (cont.)'),
          i: i++,
        });
      });
    }

    return snippets;
  }

  const api = {
    chunk,
    groupSections,
    toSections,
    normalize,
    splitSentences,
    packSentences,
    packToTarget,
    DEFAULTS,
  };

  root.AD.chunker = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
