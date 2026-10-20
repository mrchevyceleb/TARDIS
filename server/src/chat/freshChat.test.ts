import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentFreshChatPerTask, canFreshChat, resolveFreshTarget, sessionsForFreshThread, shouldFreshForTask, type FreshCaller } from './freshChat.ts';
import { threadLogKey } from './threadKey.ts';
import type { Agent } from './agents.ts';

const matt: FreshCaller = { id: 'matt', name: 'Matt' };
const max: FreshCaller = { id: 'chief-of-staff', name: 'Max' };
const coder: FreshCaller = { id: 'christina', name: 'Christina' };

function agent(id: string, name: string): Agent {
  return {
    id,
    name,
    role: 'Developer',
    engine: 'openrouter',
    home: `bot-${id}`,
    createdAt: 1,
  };
}

test('canFreshChat: only Matt, Kip, Max and Riley', () => {
  assert.equal(canFreshChat(matt), true);
  assert.equal(canFreshChat(max), true);
  assert.equal(canFreshChat({ id: 'kip', name: 'Kip' }), true);
  assert.equal(canFreshChat({ id: 'riley', name: 'Riley' }), true);
  assert.equal(canFreshChat(coder), false);
  assert.equal(canFreshChat(null), false);
});

test('resolveFreshTarget: duplicate display names never resolve silently', () => {
  const agents = [agent('sam-a', 'Sam'), agent('sam-b', 'Sam'), agent('naomi', 'Naomi')];
  const dup = resolveFreshTarget(agents, 'sam');
  assert.ok('error' in dup);
  assert.ok(dup.error.includes('sam-a'));
  const byId = resolveFreshTarget(agents, 'sam-b');
  assert.ok('agent' in byId);
  assert.equal(byId.agent.id, 'sam-b');
  const byName = resolveFreshTarget(agents, 'naomi');
  assert.ok('agent' in byName);
  assert.equal(byName.agent.id, 'naomi');
});

test('sessionsForFreshThread matches the durable thread key, cwd included', () => {
  const sessions = [
    { chatId: 'bot-naomi', cwd: '/home/mrchevyceleb/ASSISTANT-HUB', cli: 'claude', busy: false },
    { chatId: 'bot-naomi', cwd: '/tmp/other-workspace', cli: 'claude', busy: true },
    { chatId: 'bot-naomi__acct__kim', cwd: '/home/mrchevyceleb/ASSISTANT-HUB', cli: 'claude', busy: false },
    { chatId: 'bot-kip', cwd: '/home/mrchevyceleb/ASSISTANT-HUB', cli: 'claude', busy: false },
  ];
  const picked = sessionsForFreshThread(
    sessions,
    threadLogKey('/home/mrchevyceleb/ASSISTANT-HUB', 'bot-naomi'),
    (cwd, id) => threadLogKey(cwd, id),
  );
  assert.deepEqual(picked.map((s) => `${s.chatId}@${s.cwd}`), [
    'bot-naomi@/home/mrchevyceleb/ASSISTANT-HUB',
    'bot-naomi__acct__kim@/home/mrchevyceleb/ASSISTANT-HUB',
  ]);
});

test('agentFreshChatPerTask: on for the coder roster, never leadership', () => {
  for (const id of ['christina', 'maria', 'adam', 'leo', 'nora']) {
    assert.equal(agentFreshChatPerTask(agent(id, id)), true, `${id} defaults on`);
  }
  for (const id of ['jessica', 'quinn', 'wren', 'kate', 'naomi']) {
    assert.equal(agentFreshChatPerTask(agent(id, id)), false, `${id} defaults off`);
  }
  // Leadership always reads off, even with the field stored true.
  for (const id of ['chief-of-staff', 'kip', 'riley', 'samwise']) {
    assert.equal(agentFreshChatPerTask({ ...agent(id, id), freshChatPerTask: true }), false, `${id} is fenced`);
  }
  // A stored choice wins for everyone else, in both directions.
  assert.equal(agentFreshChatPerTask({ ...agent('jessica', 'Jessica'), freshChatPerTask: true }), true);
  assert.equal(agentFreshChatPerTask({ ...agent('christina', 'Christina'), freshChatPerTask: false }), false);
});

test('shouldFreshForTask: a new-task brief on an idle switched-on coder lane only', () => {
  const lead = 'chief-of-staff';
  const coderAgent = agent('christina', 'Christina');
  // The happy path: a lead's brief to a switched-on idle coder.
  assert.equal(shouldFreshForTask({ senderId: lead, recipientId: 'christina', recipientBusy: false, agent: coderAgent }), true);
  // Never mid-task: a busy lane steers instead, so no reset.
  assert.equal(shouldFreshForTask({ senderId: lead, recipientId: 'christina', recipientBusy: true, agent: coderAgent }), false);
  // The switch decides: off means no reset even for a coder brief.
  assert.equal(shouldFreshForTask({ senderId: lead, recipientId: 'christina', recipientBusy: false, agent: { ...coderAgent, freshChatPerTask: false } }), false);
  // Not a coder brief: a teammate-to-teammate note or a coder's own reply never resets.
  assert.equal(shouldFreshForTask({ senderId: 'jessica', recipientId: 'christina', recipientBusy: false, agent: coderAgent }), false);
  assert.equal(shouldFreshForTask({ senderId: 'christina', recipientId: 'maria', recipientBusy: false, agent: agent('maria', 'Maria') }), false);
  // Leadership is fenced at the decision too.
  assert.equal(shouldFreshForTask({ senderId: lead, recipientId: 'kip', recipientBusy: false, agent: agent('kip', 'Kip') }), false);
});
