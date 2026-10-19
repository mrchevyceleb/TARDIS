// The second OpenRouter account is the same engine family with a separate
// credential, profile dir and picker lane. Its model and effort resolution
// must stay identical to the existing OpenRouter account.
import assert from 'node:assert/strict';
import test from 'node:test';
import { brainForAgent, cliForAgentEngine, defaultAgentBrain, type Agent } from './agents.ts';
import { resolveOpenRouter2Effort, resolveOpenRouter2Model } from './openrouter-models.ts';
import { providerLabel } from './providerErrors.ts';
import { assertSubscriptionEngine } from './subscription-policy.ts';
import { claudeConfigDir } from './threadWindow.ts';

const baseAgent = (patch: Partial<Agent>): Agent => ({
  id: 'agent',
  name: 'Agent',
  role: 'Test',
  engine: 'openrouter2',
  home: 'bot-agent',
  createdAt: 1,
  ...patch,
});

test('Personal is a selectable engine with the same model defaults', () => {
  assert.doesNotThrow(() => assertSubscriptionEngine('openrouter2'));
  assert.equal(cliForAgentEngine('openrouter2'), 'openrouter2');
  assert.deepEqual(defaultAgentBrain('openrouter2'), {
    engine: 'openrouter2',
    model: resolveOpenRouter2Model(undefined),
    effort: resolveOpenRouter2Effort(undefined),
  });
  assert.deepEqual(brainForAgent(baseAgent({ model: 'deepseek/deepseek-v4.1-flash', effort: 'xhigh' })), {
    engine: 'openrouter2',
    model: 'deepseek/deepseek-v4.1-flash',
    effort: 'high',
    revision: 1,
    updatedAt: undefined,
  });
});

test('Personal uses the account-specific Claude config dir and label', () => {
  assert.match(claudeConfigDir('openrouter2'), /\.claude-openrouter-personal$/);
  assert.equal(providerLabel('openrouter2'), 'OpenRouter Personal');
});
