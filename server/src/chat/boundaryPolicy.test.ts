import test from 'node:test';
import assert from 'node:assert/strict';
import { boundaryInterruptEligible } from './boundaryPolicy.ts';

const now = 10 * 60_000;
const base = { humanWaiters: 0, personTurn: false, automationTurn: false, turnStartedAt: 0, lastInterruptAt: 0 };

test('only a waiting person may end the person\'s own turn at a tool boundary', () => {
  assert.equal(boundaryInterruptEligible({ ...base, personTurn: true }, now), false);
  assert.equal(boundaryInterruptEligible({ ...base, personTurn: true, humanWaiters: 1 }, now), true);
});

test('teammates may still end teammate and automation turns, after the gap and grace', () => {
  assert.equal(boundaryInterruptEligible(base, now), true);
  assert.equal(boundaryInterruptEligible({ ...base, lastInterruptAt: now - 1_000 }, now), false);
  assert.equal(boundaryInterruptEligible({ ...base, automationTurn: true, turnStartedAt: now - 1_000 }, now), false);
  assert.equal(boundaryInterruptEligible({ ...base, automationTurn: true }, now), true);
});
