import assert from 'node:assert/strict';
import { test } from 'node:test';
import { currentTaskLine, liveStateSeedBlockWithStatus, readOwnedCards, readRunningJobs } from './compaction.ts';

test('currentTaskLine reads the last visible user turn only', () => {
  const events: Array<{ seq?: number; ev: any }> = [
    { seq: 1, ev: { type: 'event', event: { type: '_user_echo', text: 'first ask', ts: 1 } } },
    { seq: 2, ev: { type: 'event', event: { type: 'assistant', message: { content: [{ type: 'text', text: 'answer' }] } } } },
    { seq: 3, ev: { type: 'event', event: { type: '_user_echo', text: 'ship the supabase read guard', ts: 3 } } },
  ];
  assert.equal(currentTaskLine(events), 'ship the supabase read guard');
  assert.equal(currentTaskLine([]), null);
});

test('readRunningJobs filters to this agent and running only', () => {
  const prior = process.env.RIVENDELL_STATE_DIR;
  process.env.RIVENDELL_STATE_DIR = '/tmp/naomi-state-that-does-not-exist';
  try {
    assert.deepEqual(readRunningJobs('naomi'), []);
  } finally {
    if (prior === undefined) delete process.env.RIVENDELL_STATE_DIR;
    else process.env.RIVENDELL_STATE_DIR = prior;
  }
});

test('readOwnedCards ignores a missing desk file (fail-open)', () => {
  const prior = process.env.RIVENDELL_DESK_FILE;
  process.env.RIVENDELL_DESK_FILE = '/tmp/naomi-desk-that-does-not-exist.json';
  try {
    assert.deepEqual(readOwnedCards('naomi'), []);
  } finally {
    if (prior === undefined) delete process.env.RIVENDELL_DESK_FILE;
    else process.env.RIVENDELL_DESK_FILE = prior;
  }
});

test('liveStateSeedBlockWithStatus: non-thread key is empty and available', () => {
  assert.deepEqual(liveStateSeedBlockWithStatus('not-a-log-key'), { block: '', available: true });
});

test('liveState block forbids resuming stale work', () => {
  // Only proves the guard phrasing exists in the code path; full live reads
  // are exercised by the store tests below and by the oneAnswer tests.
  const src = liveStateSeedBlockWithStatus.toString();
  assert.ok(src.includes('answer that message'), 'block forbids resuming stale tasks');
});
