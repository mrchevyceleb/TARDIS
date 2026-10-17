// The compaction check's pure pieces (card-0a3653, small version): countWords
// strips markdown structure markers (table pipes and separator rows are
// structure; cell text is words), and parseVerdict accepts only a bare JSON
// verdict — approve, or reject with reasons — stripping exactly one
// surrounding fence and treating anything unparseable as a rejection (the
// previous document stands; nothing unverifiable ever becomes the next
// baseline). uncheckedSaveAllowed gates the fail-open save: a placeholder
// under half the previous document never replaces a real memory.
import assert from 'node:assert/strict';
import test from 'node:test';
import { countWords, parseVerdict, uncheckedSaveAllowed } from './compaction.ts';

test('countWords ignores markdown structure markers', () => {
  assert.equal(countWords('## Overview\n\nThe build passed all 149 tests.'), 7);
  assert.equal(countWords('- one\n- two\n- three'), 3);
  // Table data rows count their cells; only pipes and separator rows are
  // structure — including the aligned | :---: | form.
  assert.equal(countWords('| col | col |\n| --- | --- |\n| grok-4.7 | xhigh |'), 4);
  assert.equal(countWords('| --- | --- |'), 0);
  assert.equal(countWords('| :---: | :---: |'), 0);
  assert.equal(countWords('   '), 0);
});

test('parseVerdict accepts a bare JSON verdict, nothing unverifiable', () => {
  assert.deepEqual(parseVerdict('{"verdict":"approve"}'), { approved: true, reasons: [] });
  assert.deepEqual(parseVerdict('{"verdict":"reject","reasons":["the cap claim is unsupported"]}'), { approved: false, reasons: ['the cap claim is unsupported'] });
  assert.deepEqual(parseVerdict('{"verdict":"reject"}'), { approved: false, reasons: ['rejected with no reasons given'] });
  // One surrounding fence is stripped (Gemini habitually wraps its JSON):
  assert.deepEqual(parseVerdict('```json\n{"verdict":"approve"}\n```'), { approved: true, reasons: [] });
  // Anything unparseable is a rejection, never an approval:
  const reject = (text: string, why: RegExp) => {
    const v = parseVerdict(text);
    assert.equal(v.approved, false);
    assert.equal(v.reasons.length, 1);
    assert.match(v.reasons[0], why);
  };
  reject('', /no text/);
  reject('```\n{"verdict":"approve"}\n```\nnope', /fenced/);
  reject('Here is the verdict: {"verdict":"approve"}', /not JSON/);
  reject('["approve"]', /not a JSON object/);
  reject('{"verdict":"maybe"}', /not a valid verdict/);
  reject('{"verdict":"reject","reasons":[1]}', /not a valid verdict/);
});

test('uncheckedSaveAllowed fails open except for a placeholder', () => {
  // A real-looking replacement (at least half the previous document): an
  // unreachable check fails open so memory keeps updating.
  assert.equal(uncheckedSaveAllowed(3_000, 6_000), true);
  assert.equal(uncheckedSaveAllowed(6_000, 5_000), true);
  // A fresh lane has no previous document to protect.
  assert.equal(uncheckedSaveAllowed(3, 0), true);
  // A placeholder under half the old one: the old document is kept.
  assert.equal(uncheckedSaveAllowed(2_999, 6_000), false);
  assert.equal(uncheckedSaveAllowed(12, 6_000), false);
});
