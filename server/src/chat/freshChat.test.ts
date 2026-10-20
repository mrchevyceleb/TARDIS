import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canFreshChat, resolveFreshTarget, sessionsForFreshThread, type FreshCaller } from './freshChat.ts';
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
