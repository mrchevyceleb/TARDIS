// Exercise roster persistence, the API, prompt scoping and native toolbox
// payloads against disposable state, never the operator's installed roster.
import assert from 'node:assert/strict';
import test, { after, mock } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
const { AgySession } = await import('./agy-runner.ts');
const { bananaToolboxTools } = await import('./banana-runner.ts');
const { personaPromptFor } = await import('./personaPrompts.ts');
const { DESK_ROOM_ENABLED } = await import('../config.ts');
const { instructionsStamp, instructionLayers, saveInstructionFile } = await import('./instructionLayers.ts');
const { sharedRuleFile, sharedRuleText, SHARED_RULES, RETIRED_STOCK_SEEDS } = await import('./sharedRules.ts');
const { agentsRouter } = await import('../routes/agents.ts');

// Keep rule-cache invalidation deterministic even on coarse-mtime filesystems.
let ruleWriteTime = Date.now();
function writeRule(file: string, text: string): void {
  writeFileSync(file, text);
  const modified = new Date(ruleWriteTime += 2_000);
  utimesSync(file, modified, modified);
}

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

test('a lean lane switches to Antigravity (Gemini 4 Carbon) and keeps lean', () => {
  // Matt's flow: the picker saves an engine switch with brain fields only —
  // no toolbox field — so the server must not re-check the lane's stored lean
  // choice against the new engine (the old "Antigravity does not support
  // lean toolboxes" refusal).
  const dev = createAgent({ name: 'Dev lane', engine: 'claude', toolbox: 'lean' });
  const saved = updateAgent(dev.id, { engine: 'agy', model: 'gemini-4-carbon', effort: 'medium' }, 1);
  assert.equal(saved?.engine, 'agy');
  assert.equal(saved?.model, 'gemini-4-carbon');
  assert.equal(saved?.toolbox, 'lean', 'lean survives the engine switch');
  const agy = createAgent({ name: 'Carbon builder', engine: 'agy', toolbox: 'lean' });
  assert.equal(agy.toolbox, 'lean');
});

test('Antigravity lanes carry no office-tool guidance at any toolbox setting', () => {
  // The Antigravity CLI reads one machine-global MCP config TARDIS never
  // writes: no agy lane mounts assistant-mcp, so none of them get the router
  // rule — lean or full. The team-status/background-jobs/sidebar/Desk rules
  // coach tools those mounts carry (team_status, job_start,
  // sidebar_checklist, board_*), so they stay off agy in the prompt AND in
  // the Instructions room, which never lists a rule the lane never receives.
  const agyFull = createAgent({ name: 'Agy full', engine: 'agy' });
  const agyLean = createAgent({ name: 'Agy lean', engine: 'agy', toolbox: 'lean' });
  const gatedRules = ['rule:ops-toolbox', 'rule:team-workflow', 'rule:team-status', 'rule:background-jobs', 'rule:sidebar', 'rule:desk'];
  const gatedTags = /<rivendell-ops-toolbox>|<rivendell-team-workflow>|<rivendell-team-status>|<rivendell-background-jobs>|<rivendell-sidebar>|<rivendell-desk>/;
  for (const agent of [agyFull, agyLean]) {
    for (const suffix of ['', '__bg', '__acct__fixture', '__bg__acct__fixture']) {
      const prompt = personaPromptFor(agent.home + suffix);
      assert.doesNotMatch(prompt, gatedTags);
      assert.doesNotMatch(prompt, /sidebar_checklist|team_message|job_start|board_/);
      assert.match(prompt, /<rivendell-task-control>/, 'the review and fast-task policy still applies');
      assert.match(prompt, /Only Kip merges Rally PRs to main/);
      assert.match(prompt, /one PR per job/);
      assert.match(prompt, /A job never changes hands partway through/);
    }
    for (const key of gatedRules) {
      assert.ok(!instructionLayers(agent.id)?.layers.some(layer => layer.key === key), `${key} must not reach an agy lane`);
    }
  }
  // Other engines keep the full-toolbox rule and the team-tool rules, in the
  // prompt and in the room (a lean lane keeps the team tools, losing only
  // the office integrations).
  for (const lane of [{ agent: createAgent({ name: 'OpenRouter full', engine: 'openrouter' }), office: true }, { agent: createAgent({ name: 'OpenRouter lean', engine: 'openrouter', toolbox: 'lean' }), office: false }]) {
    const prompt = personaPromptFor(lane.agent.home);
    assert.match(prompt, /<rivendell-team-status>/);
    assert.match(prompt, /<rivendell-team-workflow>/, 'team-enabled engines keep the editable Rally workflow');
    assert.match(prompt, /sidebar_checklist/);
    assert.match(prompt, /<rivendell-background-jobs>/);
    assert.match(prompt, /<rivendell-sidebar>/);
    if (DESK_ROOM_ENABLED) assert.match(prompt, /<rivendell-desk>/);
    assert.equal(prompt.includes('<rivendell-ops-toolbox>'), lane.office);
    const layers = instructionLayers(lane.agent.id)?.layers ?? [];
    for (const key of ['rule:team-workflow', 'rule:team-status', 'rule:background-jobs', 'rule:sidebar']) assert.ok(layers.some(layer => layer.key === key), `${key} reaches a lane that mounts the team tools`);
    assert.equal(layers.some(layer => layer.key === 'rule:ops-toolbox'), lane.office);
  }
  // The engine basics seed describes the CLI's real tool surface.
  assert.doesNotMatch(SHARED_RULES['engine-agy'].seed(), /assistant_\* tools/);
  assert.doesNotMatch(SHARED_RULES['engine-agy'].seed(), /team_message/);
});

test('Antigravity workspace chats receive engine guidance without the unavailable office toolbox', () => {
  // Exercise the actual runner composition without spawning a subscription
  // process or sending a prompt to a real provider.
  const prompt = Reflect.get(AgySession.prototype, 'systemPromptBlock').call({
    chatId: 'workspace-without-agent', cli: 'agy',
  }) as string;
  assert.match(prompt, /running on Antigravity/);
  assert.doesNotMatch(prompt, /<rivendell-ops-toolbox>|assistant-mcp MCP tools/);
  assert.match(personaPromptFor('workspace-without-agent'), /<rivendell-ops-toolbox>/,
    'workspace chats on other engines still receive office guidance');
});

test('Antigravity instruction stamps ignore rules for tools it never mounts', () => {
  const agy = createAgent({ name: 'Agy stamp', engine: 'agy' });
  const full = createAgent({ name: 'Full stamp' });
  const unchanged = instructionsStamp(agy.home);
  updateAgent(agy.id, { toolbox: 'lean' });
  assert.equal(instructionsStamp(agy.home), unchanged, 'a saved preference cannot change agy tools or instructions');
  updateAgent(agy.id, { toolbox: 'full' });
  assert.equal(instructionsStamp(agy.home), unchanged);
  for (const id of ['ops-toolbox', 'team-workflow', 'team-status', 'background-jobs', 'sidebar', 'desk'] as const) {
    if (id === 'desk' && !DESK_ROOM_ENABLED) continue;
    const file = sharedRuleFile(id);
    const original = sharedRuleText(id);
    const agyStamp = instructionsStamp(agy.home);
    const fullStamp = instructionsStamp(full.home);
    try {
      writeRule(file, `${original}\nChanged tool guidance.\n`);
      assert.equal(instructionsStamp(agy.home), agyStamp, `${id} never reaches Antigravity`);
      assert.notEqual(instructionsStamp(full.home), fullStamp, `${id} still reaches other engines`);
    } finally {
      writeRule(file, `${original}\n`);
    }
  }
});

test('stock upgrades seed the missing workflow, including when the task-control rewrite is blocked', () => {
  const file = sharedRuleFile('task-control');
  const workflowFile = sharedRuleFile('team-workflow');
  const originalTask = sharedRuleText('task-control');
  const originalWorkflow = sharedRuleText('team-workflow');
  const retired = `${RETIRED_STOCK_SEEDS['task-control']![0]}\n`;
  const agy = createAgent({ name: 'Agy workflow', engine: 'agy' });
  const other = createAgent({ name: 'Team workflow' });
  try {
    for (const blockedWrite of [false, true]) {
      writeRule(file, retired);
      rmSync(workflowFile);
      const blocked = `${file}.${process.pid}.tmp`;
      if (blockedWrite) mkdirSync(blocked);
      const warning = mock.method(console, 'warn', () => {});
      try {
        assert.equal(sharedRuleText('team-workflow'), SHARED_RULES['team-workflow'].seed());
        assert.equal(readFileSync(workflowFile, 'utf8'), `${SHARED_RULES['team-workflow'].seed()}\n`);
        assert.equal(readFileSync(file, 'utf8'), blockedWrite ? retired : `${SHARED_RULES['task-control'].seed()}\n`);
        const prompt = personaPromptFor(agy.home);
        assert.match(prompt, /no-crap-allowed/);
        assert.match(prompt, /fast-task/);
        assert.doesNotMatch(prompt, /sidebar_checklist|send Kip/);
        assert.match(prompt, /Only Kip merges Rally PRs to main/);
        assert.match(personaPromptFor(other.home), /<rivendell-team-workflow>/);
        assert.equal(warning.mock.callCount(), blockedWrite ? 1 : 0);
      } finally {
        warning.mock.restore();
        rmSync(blocked, { recursive: true, force: true });
      }
    }
    writeRule(file, `${SHARED_RULES['task-control'].seed()}\n`);
    writeRule(workflowFile, 'Owner-edited team workflow.\n');
    assert.match(personaPromptFor(other.home), /Owner-edited team workflow/);
    assert.ok(instructionLayers(other.id)?.layers.some(layer => layer.key === 'rule:team-workflow' && layer.text.includes('Owner-edited team workflow')));
    assert.doesNotMatch(personaPromptFor(agy.home), /Owner-edited team workflow/);
    const ownerEdit = `${retired}Owner workflow note.\n`;
    const warning = mock.method(console, 'warn', () => {});
    try {
      writeRule(file, ownerEdit);
      assert.equal(sharedRuleText('task-control'), ownerEdit.trim());
      assert.equal(sharedRuleText('task-control'), ownerEdit.trim());
      assert.equal(readFileSync(file, 'utf8'), ownerEdit);
      assert.equal(warning.mock.callCount(), 1, 'retained stale tool guidance warns once, never overwrites');
    } finally {
      warning.mock.restore();
    }
  } finally {
    writeRule(file, `${originalTask}\n`);
    writeRule(workflowFile, `${originalWorkflow}\n`);
  }
});

test('owner-disabled split workflows stay disabled but remain editable in the Instructions room', () => {
  const taskFile = sharedRuleFile('task-control');
  const workflowFile = sharedRuleFile('team-workflow');
  const originalTask = sharedRuleText('task-control');
  const originalWorkflow = sharedRuleText('team-workflow');
  const other = createAgent({ name: 'Editable disabled workflow' });
  try {
    for (const text of ['Owner review policy only.\n', '\n']) {
      writeRule(taskFile, text);
      rmSync(workflowFile);
      assert.equal(sharedRuleText('team-workflow'), '');
      assert.equal(readFileSync(taskFile, 'utf8'), text);
      const layer = instructionLayers(other.id)?.layers.find(layer => layer.key === 'rule:team-workflow');
      assert.ok(layer);
      assert.match(layer.note, /Disabled/);
      assert.doesNotMatch(personaPromptFor(other.home), /<rivendell-team-workflow>/);
      saveInstructionFile(layer.path, 'Owner-enabled workflow.', layer.mtime);
      assert.equal(readFileSync(workflowFile, 'utf8'), 'Owner-enabled workflow.\n');
      writeRule(workflowFile, readFileSync(workflowFile, 'utf8'));
      assert.match(personaPromptFor(other.home), /Owner-enabled workflow/);
    }
  } finally {
    writeRule(taskFile, `${originalTask}\n`);
    writeRule(workflowFile, `${originalWorkflow}\n`);
  }
});

test('a rule file still carrying a retired stock seed refreshes; an owner edit never does', () => {
  // engine-agy shipped a seed that described office and team tools the CLI
  // never mounts. A file still holding that text word-for-word was never
  // owner-edited, so the corrected seed replaces it on first read.
  const file = sharedRuleFile('engine-agy');
  mkdirSync(join(dir, 'state', 'rules'), { recursive: true });
  writeRule(file, `${RETIRED_STOCK_SEEDS['engine-agy']![0]}\n`);
  assert.equal(sharedRuleText('engine-agy'), SHARED_RULES['engine-agy'].seed());
  assert.equal(readFileSync(file, 'utf8'), `${SHARED_RULES['engine-agy'].seed()}\n`);
  // An owner-edited variant keeps the owner's words and warns once if it
  // still carries stale tool claims; the owner remains in control.
  const warning = mock.method(console, 'warn', () => {});
  try {
    writeRule(file, `${RETIRED_STOCK_SEEDS['engine-agy']![0]}\n\nOwner note.\n`);
    const edited = sharedRuleText('engine-agy');
    assert.match(edited, /Owner note\./);
    assert.match(edited, /team_message/);
    assert.equal(sharedRuleText('engine-agy'), edited);
    assert.equal(readFileSync(file, 'utf8').trim(), edited);
    assert.equal(warning.mock.callCount(), 1);
  } finally {
    warning.mock.restore();
  }
  // Emptying the file deliberately switches the rule off; never re-seed it.
  writeRule(file, '\n');
  assert.equal(sharedRuleText('engine-agy'), '');
  assert.equal(readFileSync(file, 'utf8'), '\n');
});

test('a readable retired rule still loads when its refresh cannot be written', () => {
  const file = sharedRuleFile('engine-agy');
  const retired = `${RETIRED_STOCK_SEEDS['engine-agy']![0]}\n`;
  writeRule(file, retired);
  // A directory at the temporary-file path deterministically refuses the
  // write, without depending on uid or filesystem permission semantics.
  const blocked = `${file}.${process.pid}.tmp`;
  mkdirSync(blocked);
  const warning = mock.method(console, 'warn', () => {});
  try {
    assert.equal(sharedRuleText('engine-agy'), SHARED_RULES['engine-agy'].seed());
    assert.equal(readFileSync(file, 'utf8'), retired);
    assert.equal(sharedRuleText('engine-agy'), SHARED_RULES['engine-agy'].seed(), 'fallback is cached');
    assert.equal(warning.mock.callCount(), 1);
  } finally {
    warning.mock.restore();
    rmSync(blocked, { recursive: true });
    writeRule(file, `${SHARED_RULES['engine-agy'].seed()}\n`);
  }
});

test('switching a toolbox changes the warm-process stamp even with an empty ops rule', () => {
  const agent = createAgent({ name: 'Warm lane' });
  const file = sharedRuleFile('ops-toolbox');
  mkdirSync(join(dir, 'state', 'rules'), { recursive: true });
  writeRule(file, '');
  try {
    const full = instructionsStamp(agent.home);
    assert.ok(full);
    updateAgent(agent.id, { toolbox: 'lean' });
    assert.notEqual(instructionsStamp(agent.home), full);
    updateAgent(agent.id, { toolbox: 'full' });
    assert.equal(instructionsStamp(agent.home), full);
  } finally {
    writeRule(file, `${SHARED_RULES['ops-toolbox'].seed()}\n`);
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
  // The chat picker's engine-switch payload (brain fields only, no toolbox)
  // must save on a lean lane — the failure Matt hit switching to Antigravity.
  const switched = await request('PATCH', `/${agent.id}`, { engine: 'agy', model: 'gemini-4-carbon', effort: 'medium', brainRevision: 1 });
  assert.equal(switched.status, 200);
  const switchedAgent = (await switched.json() as { agent: Agent }).agent;
  assert.equal(switchedAgent.engine, 'agy');
  assert.equal(switchedAgent.toolbox, 'lean');
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
