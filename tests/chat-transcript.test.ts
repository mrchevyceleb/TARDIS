import assert from 'node:assert/strict';
import test from 'node:test';
import { reduce } from '../src/chat/hooks/useChat.ts';
import type { ChatBlock } from '../src/chat/data/types.ts';

function transcript() {
  const cursor = { current: '' };
  let blocks: ChatBlock[] = [];
  for (const [text, stop_reason] of [
    ['I found a blocker. Can you confirm the destination?', 'tool_use'],
    ['Here are the two verified options.', 'end_turn'],
  ]) {
    blocks = reduce(blocks, { type: 'message_start' }, cursor);
    blocks = reduce(blocks, { type: 'assistant', message: { stop_reason, content: [{ type: 'thinking', thinking: 'Private scratchpad' }, { type: 'text', text }] } }, cursor);
  }
  return blocks;
}

test('provider updates stay visible; hidden thinking never becomes a text block', () => {
  const blocks = transcript();
  assert.deepEqual(blocks.map(b => b.kind === 'text' ? [b.text, b.presentation] : []), [
    ['I found a blocker. Can you confirm the destination?', 'update'],
    ['Here are the two verified options.', 'answer'],
  ]);
});

test('voice handoff control stays out of chat and its reply is not nested as a teammate exchange', () => {
  const cursor = { current: '', peerId: 'old-peer' as string | undefined };
  let blocks = reduce([], { type: 'peer_message', from: 'Voice', fromRole: 'voice', text: 'Internal handoff envelope' }, cursor);
  assert.deepEqual(blocks, []);
  assert.equal(cursor.peerId, undefined);
  blocks = reduce(blocks, { type: 'message_start' }, cursor);
  blocks = reduce(blocks, { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Two options found.' }] } }, cursor);
  assert.equal(blocks[0].kind === 'text' && blocks[0].peerId, undefined);
});

test('streamed updates acquire the same metadata as canonical-only replay', () => {
  const cursor = { current: '' };
  let blocks = reduce([], { type: 'message_start' }, cursor);
  blocks = reduce(blocks, { type: 'content_block_start', index: 0, content_block: { type: 'text' } }, cursor);
  blocks = reduce(blocks, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The test failed. I am fixing it.' } }, cursor);
  blocks = reduce(blocks, { type: 'message_delta', delta: { stop_reason: 'tool_use' } }, cursor);
  assert.equal(blocks[0].kind === 'text' && blocks[0].presentation, 'update');
  assert.equal(blocks[0].kind === 'text' && blocks[0].text, 'The test failed. I am fixing it.');
});
