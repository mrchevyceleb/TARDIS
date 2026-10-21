import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClaudeSession } from './runner.ts';

// Exercise the real event handler without spawning a CLI or writing a transcript.
function harness() {
  const events: Array<{ type: string }> = [];
  const session = Object.assign(Object.create(ClaudeSession.prototype), {
    cli: 'xai', disposed: false, turnStartedAt: null,
    activeToolIds: new Set(), streamTextBlocks: new Map(), pendingPeerAccepts: new Set(), pendingPeerSteerAccepts: new Set(), statusAcks: [],
    emit: (event: { type: string }) => events.push(event),
    trackStreamText: () => {}, persistAppliedSelection: () => {},
    maybeCompact: async () => {},
  });
  return { session, events };
}

test('native monitor query becomes busy, tracks the tool window, and ends normally', () => {
  const { session, events } = harness();
  session.handleEvent({ type: 'system', subtype: 'task_started', task_id: 'monitor' });
  session.handleEvent({ type: 'system', subtype: 'task_notification', task_id: 'monitor' });
  assert.equal(session.isBusy(), false);
  session.handleEvent({ type: 'system', subtype: 'status', status: 'requesting' });
  assert.equal(session.isBusy(), true);
  assert.equal(session.turnPromptSubmitted, true);
  assert.equal(session.activeToolIds.size, 0);
  session.handleEvent({ type: 'stream_event', event: { type: 'message_start' } });
  session.handleEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1' }] } });
  assert.equal(session.activeToolIds.size, 1);
  assert.equal(session.canAcceptNativeHumanSteer(), false); // never native: see canAcceptNativeHumanSteer
  assert.equal(events.filter(e => e.type === 'turnStart').length, 1);
  session.handleEvent({ type: 'result', subtype: 'success' });
  assert.equal(session.isBusy(), false);
  assert.equal(events.at(-1)?.type, 'turnEnd');
  session.handleEvent({ type: 'system', subtype: 'status', status: 'requesting' });
  assert.equal(session.isBusy(), true);
  assert.equal(events.filter(e => e.type === 'turnStart').length, 2);
});

test('stream tool_use opens the tool window without a completed assistant message', () => {
  const { session } = harness();
  session.handleEvent({ type: 'stream_event', event: { type: 'message_start' } });
  assert.equal(session.isBusy(), true);
  assert.equal(session.activeToolIds.size, 0);
  session.handleEvent({
    type: 'stream_event',
    event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tool-stream-1' } },
  });
  assert.equal(session.activeToolIds.size, 1);
  assert.equal(session.canAcceptNativeHumanSteer(), false); // never native: see canAcceptNativeHumanSteer
  session.handleEvent({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tool-stream-1' }] },
  });
  assert.equal(session.activeToolIds.size, 0);
});

test('content starts native turns on older CLIs without resetting an admitted human turn', () => {
  for (const event of [
    { type: 'stream_event', event: { type: 'message_start' } },
    { type: 'assistant', message: { content: [] } },
  ]) {
    const { session, events } = harness();
    session.handleEvent(event);
    assert.equal(session.isBusy(), true);
    assert.equal(events[0]?.type, 'turnStart');
    session.turnStartedAt = 42;
    session.automationTurn = true;
    session.handleEvent(event);
    assert.equal(session.turnStartedAt, 42);
    assert.equal(session.automationTurn, true);
    assert.equal(events.filter(e => e.type === 'turnStart').length, 1);
  }
});

// A provider's own recovery prompt must never look like a completed tool.
// Teammate delivery also cannot take a human's turn before its visible reply.
function boundaryHarness(human = false) {
  const { session, events } = harness();
  Object.assign(session, {
    child: { exitCode: null }, turnStartedAt: Date.now(),
    boundaryInterruptWanted: true, boundaryWaiters: 1,
    boundaryHumanWaiters: human ? 1 : 0, lastBoundaryInterruptAt: 0,
    automationTurn: false, pausedForMessage: false,
    nudgeForReply: () => {},
  });
  let interrupts = 0;
  session.interrupt = async () => { interrupts++; return true; };
  return { session, events, interrupted: () => interrupts };
}
const nextBoundary = () => new Promise<void>((resolve) => setImmediate(resolve));

test('native recovery nudges and unrelated tool results cannot trigger queued interruption', async () => {
  const { session, interrupted } = boundaryHarness();
  session.handleEvent({ type: 'user', message: { content: [{ type: 'text', text: 'No visible output, continue the same task.' }] } });
  session.handleEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'unknown' }] } });
  await nextBoundary();
  assert.equal(interrupted(), 0);
  assert.equal(session.boundaryInterruptWanted, true);
});

test('queued teammate waits until the admitted human has a visible answer', async () => {
  const { session, interrupted } = boundaryHarness();
  session.watchReply().arm();
  session.activeToolIds.add('before-answer');
  session.handleEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'before-answer' }] } });
  await nextBoundary();
  assert.equal(interrupted(), 0);
  session.handleEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'Your answer stays here.' }] } });
  session.activeToolIds.add('after-answer');
  session.handleEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'after-answer' }] } });
  await nextBoundary();
  assert.equal(interrupted(), 1);
});

test('a newer human still steers safely at the actual completed-tool boundary', async () => {
  const { session, interrupted } = boundaryHarness(true);
  session.watchReply().arm();
  session.activeToolIds.add('first'); session.activeToolIds.add('second');
  session.handleEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'first' }] } });
  await nextBoundary();
  assert.equal(interrupted(), 0);
  session.handleEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'second' }] } });
  await nextBoundary();
  assert.equal(interrupted(), 1);
});

test('a queued teammate cannot suppress the still-owed human reply nudge', async () => {
  const { session, interrupted } = boundaryHarness();
  delete session.nudgeForReply;
  const watch = session.watchReply(); watch.arm();
  for (let n = 0; n < 5; n++) watch.noteTool('tool-'+n);
  let nudges = 0; session.deliverReplyNudge = async () => { nudges++; };
  session.nudgeForReply();
  await nextBoundary();
  assert.equal(interrupted(), 1);
  assert.equal(nudges, 1);
});
