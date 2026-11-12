import assert from 'node:assert/strict';
import test from 'node:test';
import { latestAgyContextUsage } from './agy-context.ts';
import type { PersistedEvent } from './event-log-store.ts';

const call = (seq: number, input: number, cached = 0): PersistedEvent => ({
  seq, eng: 'agy', mdl: 'gemini-4-hydrogen',
  ev: { type: 'event', event: { type: 'stream_event', event: { type: 'message_delta', usage: { input_tokens: input, cache_read_input_tokens: cached } } } },
});

test('reattaching restores the latest Antigravity call including cached input, not cumulative totals', () => {
  const events: PersistedEvent[] = [
    call(1, 16_998), call(2, 3_374, 14_949),
    { seq: 3, eng: 'agy', ev: { type: 'event', event: { type: 'result', usage: { input_tokens: 47_419 } } } },
    call(4, 0), { ...call(5, 900_000), lane: 'bg' },
  ];
  assert.deepEqual(latestAgyContextUsage(events), {
    model: 'gemini-4-hydrogen', usage: { input_tokens: 3_374, cache_read_input_tokens: 14_949 },
  });
});

test('a fresh thread or another engine never borrows an old Antigravity context', () => {
  assert.equal(latestAgyContextUsage([]), null);
  assert.equal(latestAgyContextUsage([call(1, 500), { ...call(2, 700), eng: 'claude' }]), null);
});
