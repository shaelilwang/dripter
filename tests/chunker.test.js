/* Run with:  node tests/chunker.test.js
 * No dependencies, no test framework. Exits non-zero on failure.
 */
const C = require('../src/chunker.js');

let pass = 0;
let fail = 0;

function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '\n       ' + detail : ''}`); }
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, `expected ${e}\n       actual   ${a}`);
}

console.log('\nsentence splitting');
eq('plain sentences',
  C.splitSentences('One thing. Two things. Three.'),
  ['One thing.', 'Two things.', 'Three.']);

eq('abbreviation Dr. does not break',
  C.splitSentences('Dr. Chen disagreed. She left.'),
  ['Dr. Chen disagreed.', 'She left.']);

eq('e.g. does not break',
  C.splitSentences('Use a cache, e.g. Redis. It helps.'),
  ['Use a cache, e.g. Redis.', 'It helps.']);

eq('U.S. does not break',
  C.splitSentences('The U.S. economy slowed. Rates held.'),
  ['The U.S. economy slowed.', 'Rates held.']);

eq('initials do not break',
  C.splitSentences('J. R. R. Tolkien wrote it. Everyone knows.'),
  ['J. R. R. Tolkien wrote it.', 'Everyone knows.']);

eq('decimals do not break',
  C.splitSentences('It grew 3. 5 percent last year.'),
  ['It grew 3. 5 percent last year.']);

eq('question and exclamation break',
  C.splitSentences('Why though? Because it works! Fine.'),
  ['Why though?', 'Because it works!', 'Fine.']);

eq('quote after terminator stays attached',
  C.splitSentences('She said "no." Then she left.'),
  ['She said "no."', 'Then she left.']);

eq('the word "no." still breaks',
  C.splitSentences('The answer was no. We moved on.'),
  ['The answer was no.', 'We moved on.']);

eq('"No. 5" does not break',
  C.splitSentences('See No. 5 for details. Then stop.'),
  ['See No. 5 for details.', 'Then stop.']);

eq('"Jan. 12" does not break',
  C.splitSentences('It shipped Jan. 12 without fanfare. Nobody noticed.'),
  ['It shipped Jan. 12 without fanfare.', 'Nobody noticed.']);

eq('month name as a word still breaks',
  C.splitSentences('The deadline slipped to Aug. Everyone groaned.'),
  ['The deadline slipped to Aug.', 'Everyone groaned.']);

console.log('\nsection model');
{
  // Cards are sized by structure: a section is one card, and its heading
  // rides along with the prose rather than taking a card of its own.
  const out = C.chunk([
    { type: 'heading', text: 'Why this matters' },
    { type: 'para', text: 'Short paragraph one.' },
    { type: 'para', text: 'Short paragraph two.' },
  ]);
  eq('a section becomes one card', out.length, 1);
  eq('paragraphs are joined, not split apart',
    out[0].text, 'Short paragraph one.\n\nShort paragraph two.');
  eq('the heading rides along', out[0].heading, 'Why this matters');
  eq('and is not duplicated into the body', out[0].text.includes('Why this matters'), false);
}
{
  const out = C.chunk([
    { type: 'heading', text: 'First' },
    { type: 'para', text: 'Alpha.' },
    { type: 'heading', text: 'Second' },
    { type: 'para', text: 'Beta.' },
  ]);
  eq('each heading starts a new card', out.length, 2);
  eq('first card belongs to the first section', out[0].heading, 'First');
  eq('second to the second', out[1].heading, 'Second');
  eq('bodies stay with their own section',
    out.map((s) => s.text), ['Alpha.', 'Beta.']);
}
{
  // A section that overruns the cap continues onto another card, and the
  // continuation says so rather than looking like a new section.
  const para = 'A sentence that runs on for a while and carries real weight. ';
  const out = C.chunk([
    { type: 'heading', text: 'Long One' },
    { type: 'para', text: para.repeat(4) },
    { type: 'para', text: para.repeat(4) },
  ], { maxChars: 300 });
  check('splits onto multiple cards', out.length > 1, `got ${out.length}`);
  eq('first card carries the plain heading', out[0].heading, 'Long One');
  check('later cards are marked as continuations',
    out.slice(1).every((s) => s.heading === 'Long One (cont.)'),
    JSON.stringify(out.map((s) => s.heading)));
}
{
  // Thread posts are atomic: a post is already the author's unit, so it is
  // never glued to the next one nor shredded into its own lines. This is the
  // 264-cards-of-one-bullet regression.
  const post = (n) => ({
    type: 'para', atomic: true,
    text: `Post ${n} opener:\n• first bullet\n• second bullet\n• third bullet`,
  });
  const out = C.chunk([post(1), post(2), post(3)]);
  eq('one card per post, not per line', out.length, 3);
  check('each post keeps its bullets together',
    out.every((s) => s.text.split('\n').length === 4),
    JSON.stringify(out.map((s) => s.text.split('\n').length)));
  check('posts are not merged with each other',
    out.every((s) => (s.text.match(/Post \d opener/g) || []).length === 1));
  check('a short numbered post is not mistaken for a heading',
    C.chunk([{ type: 'para', atomic: true, text: '1. Get a microcontroller' }])[0].kind === 'para');
}
{
  const long = 'Words and more words. '.repeat(400); // ~8800 chars
  eq('cap 0 means no cap at all', C.chunk([{ type: 'para', text: long }], { maxChars: 0 }).length, 1);
  check('a cap still applies when set',
    C.chunk([{ type: 'para', text: long }], { maxChars: 500 }).length > 5);
}
{
  // Bullet runs pack tight; prose paragraphs get a blank line between them.
  const bullets = C.chunk([
    { type: 'para', text: '• one' },
    { type: 'para', text: '• two' },
  ]);
  eq('bullets join on a single newline', bullets[0].text, '• one\n• two');

  // The realistic shape: a lead-in sentence, then a list. The run has to stay
  // tight even though the section starts with prose.
  const mixed = C.chunk([
    { type: 'para', text: 'Ask for the reasoning first, and grade that.' },
    { type: 'para', text: '• Require the intermediate steps' },
    { type: 'para', text: '• Score the approach separately' },
    { type: 'para', text: '• Reward calibrated uncertainty' },
  ]);
  eq('prose then bullets keeps the list tight',
    mixed[0].text,
    'Ask for the reasoning first, and grade that.\n' +
    '\n• Require the intermediate steps' +
    '\n• Score the approach separately' +
    '\n• Reward calibrated uncertainty');

  eq('numbered lists count as bullets too',
    C.chunk([{ type: 'para', text: '1. First' }, { type: 'para', text: '2. Second' }])[0].text,
    '1. First\n2. Second');
}

console.log('\ncards per article cap');
{
  const section = (n) => [
    { type: 'heading', text: `Stage ${n}: A Heading Here` },
    { type: 'para', text: `Body prose for stage ${n}. `.repeat(6) },
  ];
  const many = [];
  for (let n = 1; n <= 12; n++) many.push(...section(n));

  const out = C.chunk(many, { maxCards: 5 });
  eq('twelve sections collapse to five cards', out.length, 5);
  eq('fewer sections than the cap are left alone',
    C.chunk([...section(1), ...section(2)], { maxCards: 5 }).length, 2);
  eq('a cap of one yields a single card', C.chunk(many, { maxCards: 1 }).length, 1);

  // The whole point: merging must not lose or alter a single character.
  const joined = out.map((s) => (s.heading ? s.heading + '\n' : '') + s.text).join('\n');
  for (let n = 1; n <= 12; n++) {
    check(`stage ${n} heading survives`, joined.includes(`Stage ${n}: A Heading Here`));
  }
  check('no ellipsis was introduced', !joined.includes('…'), joined.slice(0, 80));
  check('first card keeps its own heading', out[0].heading === 'Stage 1: A Heading Here');

  // Cards should be roughly even rather than one huge and four tiny.
  const lens = out.map((s) => s.text.length);
  check('cards are balanced',
    Math.max(...lens) <= Math.min(...lens) * 2.5,
    JSON.stringify(lens));
}
{
  // A thread: every post is its own section, so the cap applies to posts.
  const posts = [];
  for (let n = 1; n <= 20; n++) {
    posts.push({ type: 'para', atomic: true, text: `Post number ${n} says a thing.` });
  }
  const out = C.chunk(posts, { maxCards: 5 });
  eq('twenty posts collapse to five cards', out.length, 5);
  const all = out.map((s) => s.text).join('\n');
  for (let n = 1; n <= 20; n++) {
    check(`post ${n} survives`, all.includes(`Post number ${n} says a thing.`));
  }
}
{
  // A heading-only article must still show its headings, not vanish.
  const out = C.chunk([
    { type: 'heading', text: 'Alpha' },
    { type: 'heading', text: 'Beta' },
  ], { maxCards: 5 });
  check('headings with no body are still shown',
    out.map((s) => s.text).join(' ').includes('Alpha'), JSON.stringify(out));
}

console.log('\nheading runaway guard');
{
  // Fragmented extraction: a list of titles, no prose. Every line reads as a
  // heading, which produced cards that were all bold fragments and no content.
  const fragments = [
    'Judge the Work Instead of the Answer',
    'The Cost of Being Wrong',
    'What Frontier Labs Know',
    'Codified Knowledge',
    'A Shorter Path',
  ].map((t) => ({ text: t }));

  const out = C.chunk(fragments);
  const headings = out.filter((s) => s.kind === 'heading').length;
  check('stops trusting the heuristic when most blocks look like headings',
    headings === 0, `${headings} of ${out.length} came back as headings`);
  const all = out.map((s) => s.text).join('\n');
  check('every fragment is still kept',
    fragments.every((f) => all.includes(f.text)), JSON.stringify(all));
}
{
  // A genuine article: one heading among real prose. The heuristic should
  // still fire here — the guard must not disable it wholesale.
  const blocks = [
    { text: 'Why This Matters' },
    { text: 'The rollout touched every service in the fleet, and the team had already burned its error budget.' },
    { text: 'Staging it across three regions was the only option left on the table that week.' },
    { text: 'Nobody wants to talk about the scheduler incident anymore, for reasons that are entirely fair.' },
  ];
  const out = C.chunk(blocks);
  eq('a lone heading among prose is still detected', out[0].heading, 'Why This Matters');
  check('the prose is carried as body, not as a heading card',
    out.every((s) => s.kind === 'para'));
  check('the heading is not repeated in the body',
    !out[0].text.startsWith('Why This Matters'), out[0].text.slice(0, 40));
}
{
  // Explicit types from the extractor always win over the guard.
  const blocks = [
    { type: 'heading', text: 'One' }, { type: 'heading', text: 'Two' },
    { type: 'heading', text: 'Three' }, { type: 'heading', text: 'Four' },
    { type: 'heading', text: 'Five' },
  ];
  const out = C.chunk(blocks);
  check('explicit heading blocks are always honoured',
    out.every((s) => s.kind === 'heading'));
}
{
  eq('a mid-sentence fragment is never a heading',
    C.looksLikeHeading('and then the whole thing fell over'), false);
  eq('a real heading still is', C.looksLikeHeading('Why This Matters'), true);
}

console.log('\npacking');
{
  const sentences = [];
  for (let i = 0; i < 12; i++) sentences.push(`Sentence number ${i} is here.`);
  const out = C.chunk([{ type: 'para', text: sentences.join(' ') }], { maxChars: 270 });
  check('multiple sentences pack into few chunks', out.length >= 2 && out.length <= 5,
    `got ${out.length} chunks`);
  check('every chunk within budget', out.every((s) => s.text.length <= 270),
    `max was ${Math.max(...out.map((s) => s.text.length))}`);
  check('no chunk splits a sentence mid-word',
    out.every((s) => !/\w…$/.test(s.text)));
  eq('round-trips all sentences',
    out.map((s) => s.text).join(' '),
    sentences.join(' '));
}

console.log('\noversized sentences');
{
  const long =
    'The migration touched every service in the fleet, which meant that the ' +
    'rollout had to be staged carefully across three regions, because a ' +
    'simultaneous cutover would have saturated the replication link, and the ' +
    'team had already burned its error budget for the quarter on an unrelated ' +
    'incident involving the scheduler that nobody wants to talk about anymore.';
  check('input really is oversized', long.length > 270, `len ${long.length}`);

  const out = C.chunk([{ type: 'para', text: long }], { maxChars: 270 });
  check('splits into multiple chunks', out.length > 1, `got ${out.length}`);
  check('every chunk within budget', out.every((s) => s.text.length <= 270),
    `max was ${Math.max(...out.map((s) => s.text.length))}`);
  check('seams are marked with ellipsis',
    out.slice(1).every((s) => s.text.startsWith('…')),
    JSON.stringify(out.map((s) => s.text.slice(0, 12))));
  check('no chunk breaks mid-word',
    out.every((s) => !/[A-Za-z]…$/.test(s.text)),
    JSON.stringify(out.map((s) => s.text.slice(-14))));

  const rejoined = out.map((s) => s.text)
    .join(' ').replace(/\s*…\s*…\s*/g, ' ').replace(/\s+/g, ' ').trim();
  eq('reassembles losslessly', rejoined, long);
}

console.log('\nno-space edge case');
{
  const wall = 'x'.repeat(600);
  const out = C.chunk([{ type: 'para', text: wall }], { maxChars: 270 });
  check('handles a single unbroken token', out.length > 1, `got ${out.length}`);
  check('still respects budget', out.every((s) => s.text.length <= 270),
    `max was ${Math.max(...out.map((s) => s.text.length))}`);
}

console.log('\nnormalization');
{
  const messy = 'Hello​  there friend.\n\n\nNext   para.';
  const out = C.chunk(messy);
  eq('strips zero-width and collapses space',
    out.map((s) => s.text),
    ['Hello there friend.\n\nNext para.']);
}

console.log('\nrunt merging');
{
  const out = C.chunk([{ type: 'para', text: 'A reasonably long opening sentence that carries the paragraph along nicely. No.' }]);
  eq('short trailing sentence gets absorbed', out.length, 1);
}

console.log('\nempties');
{
  eq('empty string', C.chunk(''), []);
  eq('blank blocks', C.chunk([{ type: 'para', text: '   ' }]), []);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
