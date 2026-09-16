import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClaudeSession } from './runner.ts';

// Exercise the real event handler without spawning a CLI or writing a transcript.
function harness() {
  const events: Array<{ type: string }> = [];
  const session = Object.assign(Object.create(ClaudeSession.prototype), {
    cli: 'xai', disposed: false, turnStartedAt: null,
    activeToolIds: new Set(), streamTextBlocks: new Map(),
    emit: (event: { type: string }) => events.push(event),
    trackStreamText: () => {}, persistAppliedSelection: () => {},
    maybeCompact: async () => {},
  });
  return { session, events };
}

test('native monitor query becomes busy, admits tool-window steering, and ends normally', () => {
  const { session, events } = harness();
  session.handleEvent({ type: 'system', subtype: 'task_started', task_id: 'monitor' });
  session.handleEvent({ type: 'system', subtype: 'task_notification', task_id: 'monitor' });
  assert.equal(session.isBusy(), false);
  session.handleEvent({ type: 'system', subtype: 'status', status: 'requesting' });
  assert.equal(session.isBusy(), true);
  assert.equal(session.turnPromptSubmitted, true);
  assert.equal(session.canAcceptNativeHumanSteer(), false);
  session.handleEvent({ type: 'stream_event', event: { type: 'message_start' } });
  session.handleEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1' }] } });
  assert.equal(session.canAcceptNativeHumanSteer(), true);
  assert.equal(events.filter(e => e.type === 'turnStart').length, 1);
  session.handleEvent({ type: 'result', subtype: 'success' });
  assert.equal(session.isBusy(), false);
  assert.equal(events.at(-1)?.type, 'turnEnd');
  session.handleEvent({ type: 'system', subtype: 'status', status: 'requesting' });
  assert.equal(session.isBusy(), true);
  assert.equal(events.filter(e => e.type === 'turnStart').length, 2);
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
