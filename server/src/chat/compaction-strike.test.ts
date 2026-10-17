// The compaction check's pure pieces (card-0a3653): countWords strips
// markdown structure markers (table pipes and separator rows are structure;
// cell text is words), parseStrikeList strips exactly one surrounding fence
// and accepts only a bare JSON array of strings, and applyStrikes is
// deletion-only against the ORIGINAL document — an exact, shape-safe copy
// deletes, a nested copy dedupes, a fact-surface strike marks its fact
// struck, and anything else deletes nothing. Garbage decisions belong to
// the caller (generateCompact).
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyStrikes, countWords, parseStrikeList, strikeIsWellFormed } from './compaction.ts';

test('countWords ignores markdown structure markers', () => {
  assert.equal(countWords('## Overview\n\nThe build passed all 149 tests.'), 7);
  assert.equal(countWords('- one\n- two\n- three'), 3);
  // Table data rows count their cells (review 3 P1-9); only pipes and
  // separator rows are structure.
  assert.equal(countWords('| col | col |\n| --- | --- |\n| grok-4.7 | xhigh |'), 4);
  assert.equal(countWords('| --- | --- |'), 0);
  assert.equal(countWords('   '), 0);
});

test('parseStrikeList strips one fence, accepts a bare JSON array of strings only', () => {
  assert.deepEqual(parseStrikeList('[]'), []);
  assert.deepEqual(parseStrikeList('["the build passed"]'), ['the build passed']);
  assert.deepEqual(parseStrikeList('```json\n["the build passed"]\n```'), ['the build passed']);
  assert.throws(() => parseStrikeList('```\n[]\n```\nnope'), /fenced block/);
  assert.throws(() => parseStrikeList('Here is the list: []'), /not JSON/);
  assert.throws(() => parseStrikeList('{"strikes": []}'), /not an array/);
  assert.throws(() => parseStrikeList('[1, 2]'), /not an array of strings/);
  assert.throws(() => parseStrikeList(''), /no text/);
});

test('applyStrikes deletes exact, shape-safe copies only', () => {
  const doc = 'The build passed. The check failed. The cap held.';
  const struck = applyStrikes(doc, ['The check failed.']);
  assert.equal(struck.compact, 'The build passed.  The cap held.');
  assert.deepEqual(struck.applied, ['The check failed.']);
  assert.deepEqual(struck.unmatched, []);
  assert.deepEqual(struck.rejected, []);
});

test('applyStrikes matches against the original, so nested and duplicate strikes dedupe', () => {
  const doc = 'The build passed. The suite is green.';
  const passage = 'The build passed. The suite is green.';
  const nested = 'The suite is green.';
  const struck = applyStrikes(doc, [passage, nested, passage]);
  assert.equal(struck.compact, '');
  assert.deepEqual(struck.applied, [passage, nested]);
  assert.deepEqual(struck.unmatched, []);
  assert.deepEqual(struck.rejected, []);
});

test('a shape-unsafe strike is rejected and deletes nothing', () => {
  const doc = 'Max decided not to use Gemini for the check.';
  // Too short to be a claim:
  let struck = applyStrikes(doc, ['not to']);
  assert.equal(struck.rejected.length, 1);
  assert.equal(struck.compact, doc);
  // Ends mid-sentence, so deleting it would splice meaning:
  struck = applyStrikes(doc, ['Max decided not to use']);
  assert.equal(struck.rejected.length, 1);
  assert.equal(struck.compact, doc);
  assert.equal(struck.applied.length, 0);
  // A heading, a redaction placeholder and the Current State summary are
  // never strikable; a claim outside Current State is:
  const host = '## Current State\n\nEverything is fine.\n\n## Decisions\n\nThe cap held.';
  assert.equal(strikeIsWellFormed('## Decisions', '## Decisions\n\nThe cap held.'), false);
  assert.equal(strikeIsWellFormed('[redacted secret]', host), false);
  assert.equal(strikeIsWellFormed('Everything is fine.', host), false);
  assert.equal(strikeIsWellFormed('The cap held.', host), true);
});

test('a strike list that copies nothing is all-unmatched, not garbage', () => {
  const doc = 'The build passed all 149 tests and the type check is clean.';
  const struck = applyStrikes(doc, ['the test failed', 'nothing matched here', 'also not in the doc']);
  assert.equal(struck.applied.length, 0);
  assert.equal(struck.unmatched.length, 3);
  assert.equal(struck.compact, doc);
});

test('a fact-surface strike marks the fact struck without touching the document', () => {
  const doc = 'The build passed all 149 tests.';
  const factContent = 'The server suite is 149 green.';
  const surfaces = [
    { idx: 0, text: factContent },
    { idx: 0, text: `- suite count: ${factContent}` },
  ];
  const struck = applyStrikes(doc, [factContent], surfaces);
  assert.equal(struck.compact, doc);
  assert.deepEqual(struck.applied, [factContent]);
  assert.equal(struck.struckFacts.has(0), true);
});
