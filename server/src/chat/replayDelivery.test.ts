import test from 'node:test';
import assert from 'node:assert/strict';
import { historicalDelivery, subscriptionReplayCursor } from './replayDelivery.ts';

test('a no-replay rebind never subscribes from sequence zero', () => {
  assert.equal(subscriptionReplayCursor(-1, 0), -1);
  assert.equal(subscriptionReplayCursor(-1, 900), -1);
  assert.equal(subscriptionReplayCursor(0, 40), 40);
  assert.equal(subscriptionReplayCursor(100, 40), 100);
});

test('old close/502/turn controls cannot tear down the current session during replay', () => {
  const notice = { seq: 3, ev: { type: 'event', event: { type: '_terminal_error', code: '502', message: 'Previous request failed.' } } };
  const frames = [
    { seq: 1, ev: { type: 'turnStart' } },
    { seq: 2, ev: { type: 'error', code: '502', message: 'Old transport failure' } },
    notice,
    { seq: 4, ev: { type: 'turnEnd' } },
    { seq: 5, ev: { type: 'closed', code: 0 } },
  ];
  assert.deepEqual(frames.map(historicalDelivery).filter(Boolean), [notice]);
  // A current live close is not run through historicalDelivery by the binder.
  const latest = 5;
  const live = { seq: 6, ev: { type: 'closed', code: 1 } };
  assert.equal(live.seq <= latest ? historicalDelivery(live) : live, live);
});

test('legacy Banana failures remain transcript notices, not current send failures', () => {
  const frame = { seq: 10, ev: { type: 'error', code: 'BANANA_TURN_FAILED', message: 'Past failure', retryable: true } };
  assert.deepEqual(historicalDelivery(frame), { seq: 10, ev: { type: 'event', event: {
    type: '_terminal_error', code: 'BANANA_TURN_FAILED', message: 'Past failure', retryable: true,
  } } });
});
