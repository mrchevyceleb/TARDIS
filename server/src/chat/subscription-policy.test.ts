import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSubscriptionLane, subscriptionEnvironment } from './subscription-policy.ts';
import { brainForAgent } from './agents.ts';
import { validateCompletionMessage, validateCompletionRequest } from './content-completion.ts';
import { subscriptionCronPayload, isTardisOwnedCron, isSubscriptionCronEngine } from '../routes/cron.ts';

test('retired engines migrate with a new revision while preserving identity and supported brains', () => {
  const agent = { id: 'writer', name: 'Writer', role: 'Content', engine: 'banana-fireworks', model: 'fireworks/old', home: 'bot-writer', createdAt: 1, brainRevision: 7 };
  const brain = brainForAgent(agent);
  assert.equal(brain.engine, 'claude');
  assert.equal(brain.revision, 8);
  assert.ok(brain.updatedAt);
  assert.equal(agent.home, 'bot-writer');
  assert.throws(() => assertSubscriptionLane('banana-fireworks'));
  assert.throws(() => assertSubscriptionLane('zai'));
  assert.doesNotThrow(() => assertSubscriptionLane('assistant'));
  const stable = brainForAgent({ ...agent, ...brain, brainRevision: brain.revision, brainUpdatedAt: brain.updatedAt });
  assert.equal(stable.revision, 8);
  for (const engine of ['codex-kim', 'codex-personal']) {
    const aliased = brainForAgent({ ...agent, engine, model: 'gpt-5.5', effort: 'high' });
    assert.equal(aliased.engine, 'codex');
    assert.equal(aliased.model, 'gpt-5.5');
    assert.equal(aliased.effort, 'high');
  }
});

test('subscription child environments cannot inherit metered credentials or provider redirects', () => {
  const env = subscriptionEnvironment({ PATH: 'safe', ANTHROPIC_API_KEY: 'key', ANTHROPIC_AUTH_TOKEN: 'key', ANTHROPIC_BASE_URL: 'https://other.example', OPENAI_API_KEY: 'key', OPENAI_BASE_URL: 'https://other.example', OPENROUTER_API_KEY: 'key', FIREWORKS_API_KEY: 'key', GROK_PERSONAL_API_KEY: 'key', CLAUDE_CODE_USE_BEDROCK: '1' });
  assert.deepEqual(env, { PATH: 'safe' });
  assert.deepEqual(subscriptionEnvironment({ Path: 'safe', OpenAI_API_Key: 'key', Anthropic_Auth_Token: 'key', Fireworks_Api_Key: 'key' }), { Path: 'safe' });
});

test('cron defaults pin subscriptions and fleet migration requires explicit TARDIS ownership', () => {
  assert.equal(subscriptionCronPayload({ name: 'Draft' }).engine, 'assistant');
  const saved = { id: 'job', lastRun: 'never', name: 'TARDIS draft', target: 'content', schedule: '* * * * *', engine: 'banana-fireworks', modelId: 'fireworks/old', prompt: 'Preserve this brief', status: 'active' as const, runtime: 'local' as const, source: 'assistant-mcp' as const };
  const migrated = subscriptionCronPayload({ status: 'paused' }, saved);
  assert.equal(migrated.engine, 'assistant');
  assert.equal(migrated.prompt, saved.prompt);
  assert.match(migrated.modelId ?? '', /^claude-/);
  assert.equal(isTardisOwnedCron(saved), true);
  assert.equal(isTardisOwnedCron({ ...saved, name: 'Unrelated fleet task' }), false);
  assert.equal(isTardisOwnedCron({ ...saved, readOnly: true }), false);
  for (const engine of ['claude', 'codex-personal']) {
    assert.equal(isSubscriptionCronEngine(engine), false);
    assert.equal(isSubscriptionCronEngine(subscriptionCronPayload({ engine }, saved).engine), true);
  }
  for (const engine of ['assistant', 'codex', 'xai']) assert.equal(isSubscriptionCronEngine(engine), true);
});

test('content gateway validates model lanes and returns only declared tool decisions', () => {
  const request = validateCompletionRequest({ model: 'codex', messages: [{ role: 'user', content: 'Find a topic' }], tools: [{ type: 'function', function: { name: 'scan', parameters: { type: 'object' } } }], tool_choice: 'required' });
  const message = validateCompletionMessage({ content: null, tool_calls: [{ name: 'scan', arguments: '{"query":"topic"}' }] }, request);
  assert.equal(message.tool_calls?.[0].function.name, 'scan');
  assert.throws(() => validateCompletionMessage({ content: null, tool_calls: [{ name: 'shell', arguments: '{}' }] }, request));
  assert.throws(() => validateCompletionMessage({ content: 'skipped', tool_calls: [] }, request));
  assert.throws(() => validateCompletionRequest({ ...request, model: 'banana-fireworks/paid' }));
  assert.throws(() => validateCompletionRequest({ ...request, stream: true }));
});
