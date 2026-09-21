import assert from 'node:assert/strict';
import test from 'node:test';
import { brainForAgent, cliForAgentEngine, defaultAgentBrain, type Agent } from './agents.ts';
import { beginThreadReset, isThreadResetting } from './runner.ts';

const baseAgent = (patch: Partial<Agent>): Agent => ({
  id: 'agent',
  name: 'Agent',
  role: 'Test',
  engine: 'xai',
  home: 'bot-agent',
  createdAt: 1,
  ...patch,
});

test('legacy agents receive one canonical server brain', () => {
  assert.deepEqual(brainForAgent(baseAgent({})), {
    engine: 'xai',
    model: 'grok-4.7',
    effort: 'xhigh',
    revision: 1,
    updatedAt: undefined,
  });
  // `max` was offered for Grok before the tiers were verified against xAI;
  // a brain saved with it resolves to the real top tier instead of resetting.
  assert.equal(brainForAgent(baseAgent({ engine: 'xai', effort: 'max' })).effort, 'xhigh');
  assert.equal(brainForAgent(baseAgent({ engine: 'xai', effort: 'minimal' })).effort, 'minimal');
  assert.deepEqual(defaultAgentBrain('claude'), {
    engine: 'claude',
    model: 'claude-opus-5',
    effort: 'xhigh',
  });
});

test('agent brain rejects a model from a different engine and ignores stale cli', () => {
  const brain = brainForAgent(baseAgent({
    engine: 'xai',
    model: 'gpt-5.6-sol',
    effort: 'low',
    cli: 'codex',
    brainRevision: 4,
  }));
  assert.equal(cliForAgentEngine(brain.engine), 'xai');
  assert.equal(brain.model, 'grok-4.7');
  assert.equal(brain.effort, 'low');
  assert.equal(brain.revision, 4);

  const codex = brainForAgent(baseAgent({
    engine: 'codex',
    model: 'gpt-5.5',
    effort: 'ultra',
  }));
  assert.equal(codex.model, 'gpt-5.5');
  assert.equal(codex.effort, 'medium');
  const astra = brainForAgent(baseAgent({ engine: 'codex', model: 'gpt-6-astra', effort: 'ultra' }));
  assert.equal(astra.model, 'gpt-6-astra');
  assert.equal(astra.effort, 'ultra');
  assert.equal(brainForAgent(baseAgent({ engine: 'codex', model: 'gpt-unknown' })).model, 'gpt-5.6-sol');
});

test('named teammate Fresh barrier covers every engine for the shared thread', () => {
  const xai = { cli: 'xai' as const, repoPath: '/workspace', chatId: 'bot-agent' };
  const claude = { cli: 'claude' as const, repoPath: '/workspace', chatId: 'bot-agent' };
  const release = beginThreadReset(xai);
  assert.ok(release);
  assert.equal(isThreadResetting(claude), true);
  assert.equal(beginThreadReset(claude), null);
  release();
  assert.equal(isThreadResetting(xai), false);
});
