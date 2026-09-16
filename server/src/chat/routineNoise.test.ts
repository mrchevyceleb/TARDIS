import assert from 'node:assert/strict';
import test from 'node:test';
import { isQuietRoutineReply, isRoutineNoiseEvent, isToolResultUserEvent } from './routineNoise.ts';

function wrap(event: Record<string, unknown>) {
  return { type: 'event', event };
}

test('tool_result user events are not human messages', () => {
  const raw = wrap({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }],
    },
  });
  assert.equal(isToolResultUserEvent(raw), true);
});

test('real user text is not a tool result', () => {
  const raw = wrap({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'hey' }] },
  });
  assert.equal(isToolResultUserEvent(raw), false);
});

test('exact NO_UPDATE stays a quiet routine reply', () => {
  assert.equal(isQuietRoutineReply('NO_UPDATE'), true);
  assert.equal(isQuietRoutineReply('no_update.'), true);
});

test('protocol NO_UPDATE assistant events are routine noise even without an automation peer', () => {
  const raw = {
    type: 'event',
    event: { type: 'assistant', message: { content: [{ type: 'text', text: 'NO_UPDATE' }] } },
  };
  assert.equal(isRoutineNoiseEvent(raw, false), true);
});
