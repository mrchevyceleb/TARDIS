import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClaudeSession } from './runner.ts';

/** Oct 21 (card-b8ebac): on one-piece-tool-call lanes (OpenRouter family) a
 *  tool boundary is mid-generation, so a queued peer message must stand down
 *  instead of discarding the in-flight response. A person's message still
 *  interrupts, and other lanes keep the boundary interrupt. */

function boundaryHarness(cli: string, human = false) {
  const interrupts: string[] = [];
  const session = Object.assign(Object.create(ClaudeSession.prototype), {
    cli,
    disposed: false,
    turnStartedAt: Date.now() - 120_000,
    activeToolIds: new Set(),
    streamTextBlocks: new Map(),
    pendingPeerAccepts: new Set(),
    pendingPeerSteerAccepts: new Set(),
    statusAcks: [],
    boundaryInterruptWanted: true,
    boundaryWaiters: 1,
    boundaryHumanWaiters: human ? 1 : 0,
    lastBoundaryInterruptAt: 0,
    automationTurn: false,
    boundaryGeneration: 0,
    emit: (event: { type: string }) => {},
    trackStreamText: () => {},
    persistAppliedSelection: () => {},
    maybeCompact: async () => {},
    interrupt: (reason: string) => { interrupts.push(reason); return Promise.resolve(true); },
  });
  return { session, interrupts };
}

const toolResultEvent = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1' }] } };

test('a queued peer message stands down at a tool boundary on an OpenRouter lane', async () => {
  const { session, interrupts } = boundaryHarness('openrouter');
  session.handleEvent(toolResultEvent);
  assert.equal(session.boundaryInterruptWanted, false);
  assert.ok(session.peerBoundaryStanddownSince !== null, 'the ceiling clock armed');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(interrupts, []);
});

test('the peer stand-down is bounded: past its ceiling the boundary interrupt fires', async () => {
  const { session, interrupts } = boundaryHarness('openrouter');
  session.peerBoundaryStanddownSince = Date.now() - 11 * 60_000;
  session.handleEvent(toolResultEvent);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(interrupts, ['message-boundary']);
  assert.equal(session.peerBoundaryStanddownSince, null, 'the ceiling re-armed');
});

test('the stand-down also catches a human waiter that released before the deferred fire', async () => {
  const { session, interrupts } = boundaryHarness('openrouter', true);
  session.handleEvent(toolResultEvent);
  // The human released between the boundary check and the deferred fire; only
  // the peer waiter remains, so the in-flight generation is not discarded.
  session.boundaryHumanWaiters = 0;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(interrupts, []);
  assert.equal(session.boundaryInterruptWanted, false);
});

test('a human waiter still interrupts on an OpenRouter lane, and other lanes keep the boundary interrupt', async () => {
  const human = boundaryHarness('openrouter', true);
  human.session.handleEvent(toolResultEvent);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(human.interrupts, ['message-boundary']);

  const fast = boundaryHarness('claude');
  fast.session.handleEvent(toolResultEvent);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fast.interrupts, ['message-boundary']);
});
