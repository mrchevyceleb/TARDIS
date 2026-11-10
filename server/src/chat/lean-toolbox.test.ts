// Exercise roster persistence, the API, prompt scoping and native toolbox
// payloads against disposable state, never the operator's installed roster.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import type { Agent } from './agents.ts';

const dir = mkdtempSync(join(tmpdir(), 'lean-toolbox-'));
const before = { ...process.env };
after(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const key of ['RIVENDELL_STATE_DIR', 'RIVENDELL_ASSISTANT_MCP_PROXY', 'ASSISTANT_MCP_URL', 'RIVENDELL_BROWSER_MCP', 'RIVENDELL_SIDE_COPY']) {
    if (before[key] === undefined) delete process.env[key];
    else process.env[key] = before[key];
  }
});
const proxy = join(dir, 'mcp-proxy.js');
const browser = join(dir, 'browser-mcp.js');
writeFileSync(proxy, '');
writeFileSync(browser, '');
process.env.RIVENDELL_STATE_DIR = join(dir, 'state');
process.env.RIVENDELL_ASSISTANT_MCP_PROXY = proxy;
process.env.ASSISTANT_MCP_URL = 'https://example.invalid/mcp';
process.env.RIVENDELL_BROWSER_MCP = browser;
delete process.env.RIVENDELL_SIDE_COPY;
const { wantsFullToolbox, createAgent, updateAgent, agentForChatId } = await import('./agents.ts');
const { laneMcpServers, optionalMcpServersFor } = await import('./runner.ts');
const { bananaToolboxTools } = await import('./banana-runner.ts');
const { personaPromptFor } = await import('./personaPrompts.ts');
const { instructionsStamp, instructionLayers } = await import('./instructionLayers.ts');
const { sharedRuleFile, SHARED_RULES } = await import('./sharedRules.ts');
const { agentsRouter } = await import('../routes/agents.ts');

const baseAgent = (patch: Partial<Agent>): Agent => ({
  id: 'agent', name: 'Agent', role: 'Test', engine: 'claude', home: 'bot-agent', createdAt: 1, ...patch,
});
const lean = baseAgent({ toolbox: 'lean' });

test('absent or unknown toolbox means full; only an explicit lean opts out', () => {
  for (const agent of [undefined, baseAgent({}), baseAgent({ toolbox: 'full' }), baseAgent({ toolbox: 'typo' as 'full' })]) {
    assert.equal(wantsFullToolbox(agent), true);
  }
  assert.equal(wantsFullToolbox(lean), false);
});

test('a lean lane mounts every optional server except assistant-mcp', () => {
  const full = optionalMcpServersFor(baseAgent({}));
  assert.ok('assistant-mcp' in full, 'fixture must configure assistant-mcp');
  assert.ok('rivendell-browser' in full);
  const leanSet = optionalMcpServersFor(lean);
  assert.deepEqual(Object.keys(leanSet).sort(), Object.keys(full).filter(name => name !== 'assistant-mcp').sort());
  assert.ok('assistant-mcp' in optionalMcpServersFor(), 'filtering must not mutate the full set');
});

test('laneMcpServers keeps the built-ins and owner identity for lean lanes', () => {
  const full = laneMcpServers(baseAgent({}), false, 'fixture-owner');
  const leanSet = laneMcpServers(lean, false, 'fixture-owner');
  const { 'assistant-mcp': _assistant, ...retained } = full;
  assert.deepEqual(leanSet, retained);
});

test('toolbox persists across aliases and restores the absent full default', () => {
  const agent = createAgent({ name: 'Builder', toolbox: 'lean' });
  for (const suffix of ['', '__bg', '__acct__fixture', '__bg__acct__fixture']) {
    assert.equal(agentForChatId(agent.home + suffix)?.toolbox, 'lean');
  }
  updateAgent(agent.id, { name: 'Builder renamed' });
  assert.equal(agentForChatId(agent.home)?.toolbox, 'lean');
  for (const toolbox of ['full', null] as const) {
    updateAgent(agent.id, { toolbox: 'lean' });
    updateAgent(agent.id, { toolbox });
    assert.equal(agentForChatId(agent.home)?.toolbox, undefined);
  }
});

test('router guidance and instruction layers follow the toolbox, including non-roster lanes', () => {
  const full = createAgent({ name: 'Operator' });
  const builder = createAgent({ name: 'Scoped builder', toolbox: 'lean' });
  assert.match(personaPromptFor(full.home), /<rivendell-ops-toolbox>/);
  assert.doesNotMatch(personaPromptFor(builder.home), /<rivendell-ops-toolbox>/);
  assert.match(personaPromptFor('main'), /<rivendell-ops-toolbox>/);
  assert.ok(instructionLayers(full.id)?.layers.some(layer => layer.key === 'rule:ops-toolbox'));
  assert.ok(!instructionLayers(builder.id)?.layers.some(layer => layer.key === 'rule:ops-toolbox'));
  // The public seed must not route a fresh installation into private projects.
  assert.match(SHARED_RULES['ops-toolbox'].seed(), /operator's configured routing/);
  assert.doesNotMatch(SHARED_RULES['ops-toolbox'].seed(), /https?:\/\/|~\/bin\//);
});

test('switching a toolbox changes the warm-process stamp even with an empty ops rule', () => {
  const agent = createAgent({ name: 'Warm lane' });
  const file = sharedRuleFile('ops-toolbox');
  mkdirSync(join(dir, 'state', 'rules'), { recursive: true });
  writeFileSync(file, '');
  try {
    const full = instructionsStamp(agent.home);
    assert.ok(full);
    updateAgent(agent.id, { toolbox: 'lean' });
    assert.notEqual(instructionsStamp(agent.home), full);
    updateAgent(agent.id, { toolbox: 'full' });
    assert.equal(instructionsStamp(agent.home), full);
  } finally {
    writeFileSync(file, `${SHARED_RULES['ops-toolbox'].seed()}\n`);
  }
});

test('API validates toolbox values and supports lean creation, unrelated edits and full/null resets', async t => {
  const app = express();
  app.use('/api/agents', express.json(), agentsRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  const address = server.address() as { port: number };
  const request = (method: string, path: string, body: unknown) => fetch(`http://127.0.0.1:${address.port}/api/agents${path}`, {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const created = await request('POST', '', { name: 'API builder', toolbox: 'lean' });
  assert.equal(created.status, 201);
  const { agent } = await created.json() as { agent: Agent };
  assert.equal(agent.toolbox, 'lean');
  for (const toolbox of ['typo', false, 7, {}]) {
    for (const [method, path] of [['POST', ''], ['PATCH', `/${agent.id}`]]) {
      assert.equal((await request(method, path, { name: 'Invalid', toolbox })).status, 400);
    }
  }
  const renamed = await request('PATCH', `/${agent.id}`, { name: 'Still lean' });
  assert.equal((await renamed.json() as { agent: Agent }).agent.toolbox, 'lean');
  for (const toolbox of ['full', 'lean', null]) {
    const response = await request('PATCH', `/${agent.id}`, { toolbox });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { agent: Agent }).agent.toolbox, toolbox === 'lean' ? 'lean' : undefined);
  }
});

test('Banana sends session-local tool filtering through the real SDK without losing plan denials', async () => {
  const bodies: Array<{ tools: Record<string, boolean> }> = [];
  const client = createOpencodeClient({
    baseUrl: 'http://example.invalid',
    fetch: async (request, init) => {
      bodies.push(await new Request(request, init).json() as { tools: Record<string, boolean> });
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    },
  });
  await Promise.all([lean, baseAgent({})].map((agent, index) => client.session.prompt({
    sessionID: `fixture-${index}`, tools: bananaToolboxTools(agent), parts: [{ type: 'text', text: 'Fixture' }],
  })));
  assert.equal(bodies[0].tools['assistant-mcp_*'], false);
  assert.equal(bodies[1].tools['assistant-mcp_*'], undefined);
  for (const body of bodies) {
    assert.equal(body.tools.question, false);
    assert.equal(body.tools.plan_enter, false);
    assert.equal(body.tools.plan_exit, false);
    assert.equal(body.tools['rivendell-team_*'], undefined);
    assert.equal(body.tools['game-assets-mcp_*'], undefined);
  }
  assert.deepEqual(bananaToolboxTools(), bodies[1].tools, 'a restored full lane must not inherit the lean denial');
});
