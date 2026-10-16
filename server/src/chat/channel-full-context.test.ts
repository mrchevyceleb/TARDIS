// Full-context proof for channel replies (card-1327b9): a member woken by a
// channel post runs in its own lane, and that lane shares the home thread's
// durable identity — same agent record (persona), same durable log and
// rolling compact (history + memory), same recall eligibility as a one-on-one
// teammate handoff. These tests pin the identity chain so a future lane
// change cannot silently strip an agent's context in channels.

import assert from 'node:assert/strict';
import test from 'node:test';
import { backgroundChatId, bareChatId, isAgentThread, logKeyFor } from './threadKey.ts';
import { recallEligibleTurn } from './autoRecall.ts';
import { compactMemoryIdentity } from './compaction.ts';

const HOME = 'bot-example';
const BG = backgroundChatId(HOME);

test('a member lane resolves to the home thread identity, not a separate chat', () => {
  assert.equal(BG, 'bot-example__bg');
  // bareChatId is what agentForChatId (persona), recall lanes and durable
  // memory key on — the background lane must fold to the same bare id.
  assert.equal(bareChatId(BG), HOME);
  assert.equal(isAgentThread(BG), true);
  assert.equal(isAgentThread(`${HOME}__acct__tardis`), true);
});

test('the member lane shares the home thread durable log, so one compact serves both', () => {
  const cwd = '/srv/rivendell';
  const homeKey = logKeyFor('claude', cwd, HOME);
  const bgKey = logKeyFor('claude', cwd, BG);
  // Same durable key → same event log, same rolling compact, same memory rows.
  assert.equal(bgKey, homeKey);
  assert.ok(homeKey.startsWith('thread|'));
  // The compact identity (threadTag) is keyed on that durable log, so a
  // channel turn in the lane reads and writes the agent's one compact.
  assert.equal(
    compactMemoryIdentity(bgKey, BG).threadTag,
    compactMemoryIdentity(homeKey, HOME).threadTag,
  );
});

test('a channel wake in a member lane is recall-eligible, unlike automation', () => {
  // Channel posts deliver with fromRole 'channel' (person or agent poster
  // alike): a full-context turn, so recall must fire exactly as it does for
  // a one-on-one teammate message.
  assert.equal(recallEligibleTurn(BG, { peerFromRole: 'channel' }), true);
  assert.equal(recallEligibleTurn(HOME, { peerFromRole: 'channel' }), true);
  // The classes that genuinely strip context stay excluded.
  assert.equal(recallEligibleTurn(BG, { peerFromRole: 'automation' }), false);
  assert.equal(recallEligibleTurn(BG, { peerFromRole: 'voice' }), false);
  assert.equal(recallEligibleTurn(BG, { automation: true }), false);
  // Non-agent lanes (studio/probe threads) never pull team memory.
  assert.equal(recallEligibleTurn('studio-thing', { peerFromRole: 'channel' }), false);
});
