import assert from 'node:assert/strict';
import test from 'node:test';
import { extractVisibleTurns } from './threadWindow.ts';

test('recovered turns preserve an explicit warning when image pixels are unavailable', () => {
  const [turn] = extractVisibleTurns([{
    seq: 1,
    ev: {
      type: 'event',
      event: { type: '_user_echo', text: 'Log this receipt', imageCount: 1 },
    },
  }]);

  assert.equal(turn.role, 'user');
  assert.match(turn.text, /^Log this receipt/);
  assert.match(turn.text, /1 image was attached/);
  assert.match(turn.text, /do not infer them from earlier conversation/);
});

test('image-only turns remain visible during text-only context recovery', () => {
  const [turn] = extractVisibleTurns([{
    seq: 1,
    ev: {
      type: 'event',
      event: { type: '_user_echo', text: '', imageCount: 2 },
    },
  }]);

  assert.match(turn.text, /2 images were attached/);
});

function stream(seq: number, event: Record<string, unknown>) {
  return { seq, ev: { type: 'event', event: { type: 'stream_event', event } } };
}
function echo(seq: number, text: string) {
  return { seq, ev: { type: 'event', event: { type: '_user_echo', text } } };
}
function assistantText(seq: number, text: string) {
  return {
    seq,
    ev: { type: 'event', event: { type: 'assistant', message: { content: [{ type: 'text', text }] } } },
  };
}

test('tool-round message_start does not mint extra visible assistant turns', () => {
  const turns = extractVisibleTurns([
    echo(1, 'fix the scheduler'),
    stream(2, { type: 'message_start' }),
    assistantText(3, 'Catch-up is the hole.'),
    stream(4, { type: 'message_start' }),
    assistantText(5, 'Patching the skip.'),
    stream(6, { type: 'message_start' }),
    assistantText(7, 'Tests passed.'),
    echo(8, 'ship it'),
    stream(9, { type: 'message_start' }),
    assistantText(10, 'Pushed.'),
  ]);
  assert.deepEqual(turns.map((t) => [t.role, t.text]), [
    ['user', 'fix the scheduler'],
    ['assistant', 'Catch-up is the hole.\nPatching the skip.\nTests passed.'],
    ['user', 'ship it'],
    ['assistant', 'Pushed.'],
  ]);
});

test('streamed tool-round text stays one assistant turn when indexes reset', () => {
  const turns = extractVisibleTurns([
    echo(1, 'look'),
    stream(2, { type: 'message_start' }),
    stream(3, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    stream(4, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'First look.' } }),
    stream(5, { type: 'content_block_stop', index: 0 }),
    stream(6, { type: 'message_start' }),
    stream(7, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    stream(8, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Found it.' } }),
    stream(9, { type: 'content_block_stop', index: 0 }),
  ]);
  assert.deepEqual(turns.map((t) => [t.role, t.text]), [
    ['user', 'look'],
    ['assistant', 'First look.\nFound it.'],
  ]);
});

test('canonical assistant replaces that round\'s stream without dropping earlier rounds', () => {
  const turns = extractVisibleTurns([
    echo(1, 'look'),
    stream(2, { type: 'message_start' }),
    stream(3, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    stream(4, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Draft one.' } }),
    stream(5, { type: 'content_block_stop', index: 0 }),
    stream(6, { type: 'message_start' }),
    stream(7, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    stream(8, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Draft two.' } }),
    stream(9, { type: 'content_block_stop', index: 0 }),
    assistantText(10, 'Final two.'),
  ]);
  assert.deepEqual(turns.map((t) => [t.role, t.text]), [
    ['user', 'look'],
    ['assistant', 'Draft one.\nFinal two.'],
  ]);
});

test('later streamed round is kept after a canonical assistant round', () => {
  const turns = extractVisibleTurns([
    echo(1, 'look'),
    stream(2, { type: 'message_start' }),
    assistantText(3, 'First look.'),
    stream(4, { type: 'message_start' }),
    stream(5, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    stream(6, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Found it.' } }),
    stream(7, { type: 'content_block_stop', index: 0 }),
  ]);
  assert.deepEqual(turns.map((t) => [t.role, t.text]), [
    ['user', 'look'],
    ['assistant', 'First look.\nFound it.'],
  ]);
});
