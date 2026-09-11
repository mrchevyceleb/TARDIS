import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationGuidanceForTurn } from './conversation-guidance.ts';

test('adds quiet-transcript guidance only to visible human agent turns', () => {
  const direct = conversationGuidanceForTurn({ chatId: 'bot-kip' });
  assert.match(direct, /Visible chat is the reply, not the scratchpad/);
  assert.match(direct, /Do not write thinking, unsolicited plans, or tool-by-tool status/);
  assert.match(direct, /or a plan they asked for/);
  const voiceTurn = conversationGuidanceForTurn({ chatId: 'bot-kip', peerFrom: 'Voice', peerFromRole: 'voice' });
  assert.match(voiceTurn, /Visible chat is the reply, not the scratchpad/);
  assert.match(voiceTurn, /Do not write a second, different answer in Hall/);
  assert.notEqual(voiceTurn, direct);
  assert.equal(conversationGuidanceForTurn({ chatId: 'main' }), '');
  assert.equal(conversationGuidanceForTurn({ chatId: 'bot-kip', peerFrom: 'Max' }), '');
  assert.equal(conversationGuidanceForTurn({ chatId: 'bot-kip', peerFromRole: 'automation' }), '');
  assert.equal(conversationGuidanceForTurn({ chatId: 'bot-kip', hidden: true }), '');
});
