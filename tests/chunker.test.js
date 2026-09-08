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

console.log('\nblock handling');
{
  const out = C.chunk([
    { type: 'heading', text: 'Why this matters' },
    { type: 'para', text: 'Short paragraph one.' },
    { type: 'para', text: 'Short paragraph two.' },
  ]);
  eq('paragraphs never merge across blocks',
    out.map((s) => s.text),
    ['Why this matters', 'Short paragraph one.', 'Short paragraph two.']);
  eq('heading is tagged', out[0].kind, 'heading');
}

console.log('\npacking');
{
  const sentences = [];
  for (let i = 0; i < 12; i++) sentences.push(`Sentence number ${i} is here.`);
  const out = C.chunk([{ type: 'para', text: sentences.join(' ') }]);
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

  const out = C.chunk([{ type: 'para', text: long }]);
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
  const out = C.chunk([{ type: 'para', text: wall }]);
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
    ['Hello there friend.', 'Next para.']);
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
