// The compaction check's pure pieces (card-0a3653): countWords strips
// markdown structure markers, parseStrikeList accepts only a bare JSON array
// of strings, and applyStrikes is deletion-only — an exact copy deletes,
// anything else deletes nothing, and a list that does not copy the document is
// garbage (the previous document stands).
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyStrikes, countWords, parseStrikeList } from './compaction.ts';

test('countWords ignores markdown structure markers', () => {
  assert.equal(countWords('## Overview\n\nThe build passed all 149 tests.'), 7);
  assert.equal(countWords('- one\n- two\n- three'), 3);
  assert.equal(countWords('| col | col |\n| --- | --- |'), 0);
  assert.equal(countWords('   '), 0);
});

test('parseStrikeList accepts a bare JSON array of strings, nothing else', () => {
  assert.deepEqual(parseStrikeList('[]'), []);
  assert.deepEqual(parseStrikeList('["the build passed"]'), ['the build passed']);
  assert.throws(() => parseStrikeList('```json\n[]\n```'), /fenced block/);
  assert.throws(() => parseStrikeList('Here is the list: []'), /not JSON/);
  assert.throws(() => parseStrikeList('{"strikes": []}'), /not an array/);
  assert.throws(() => parseStrikeList('[1, 2]'), /not an array of strings/);
  assert.throws(() => parseStrikeList(''), /no text/);
});

test('applyStrikes deletes exact copies only', () => {
  const doc = 'The build passed. The check failed. The cap held.';
  const struck = applyStrikes(doc, ['The check failed.']);
  assert.equal(struck.compact, 'The build passed.  The cap held.');
  assert.deepEqual(struck.applied, ['The check failed.']);
  assert.deepEqual(struck.unmatched, []);
});

test('applyStrikes ignores a strike that does not copy the document while applying one that does', () => {
  const doc = 'The build passed. The check failed.';
  const struck = applyStrikes(doc, ['The check failed.', 'The test failed.', '']);
  assert.equal(struck.compact, 'The build passed. ');
  assert.deepEqual(struck.applied, ['The check failed.']);
  assert.deepEqual(struck.unmatched, ['The test failed.']);
});

test('a strike list that mostly misses the document is garbage', () => {
  const doc = 'The build passed all 149 tests and the type check is clean.';
  assert.throws(
    () => applyStrikes(doc, ['the test failed', 'nothing matched here', 'also not in the doc']),
    /did not copy the document/,
  );
});
