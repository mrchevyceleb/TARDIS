// The roster's single toolbox setting, respected by the MCP wiring: a lean
// lane drops assistant-mcp everywhere; nothing else changes for anyone.

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wantsFullToolbox, type Agent } from './agents.ts';

// runner.ts resolves the optional proxies at module load; point them at real
// temp files so the fixture has both assistant-mcp and rivendell-browser.
const dir = mkdtempSync(join(tmpdir(), 'lean-toolbox-'));
const proxy = join(dir, 'mcp-proxy.js');
const browser = join(dir, 'browser-mcp.js');
writeFileSync(proxy, '');
writeFileSync(browser, '');
process.env.RIVENDELL_ASSISTANT_MCP_PROXY = proxy;
process.env.ASSISTANT_MCP_URL = 'https://example.invalid/mcp';
process.env.RIVENDELL_BROWSER_MCP = browser;
delete process.env.RIVENDELL_SIDE_COPY;
const { laneMcpServers, optionalMcpServersFor } = await import('./runner.ts');

const baseAgent = (patch: Partial<Agent>): Agent => ({
  id: 'agent',
  name: 'Agent',
  role: 'Test',
  engine: 'claude',
  home: 'bot-agent',
  createdAt: 1,
  ...patch,
});
const lean = baseAgent({ toolbox: 'lean' });

test('absent toolbox means full; only an explicit lean opts out', () => {
  assert.equal(wantsFullToolbox(undefined), true);
  assert.equal(wantsFullToolbox(baseAgent({})), true);
  assert.equal(wantsFullToolbox(baseAgent({ toolbox: 'full' })), true);
  assert.equal(wantsFullToolbox(lean), false);
});

test('a lean lane mounts every optional server except assistant-mcp', () => {
  const full = optionalMcpServersFor(baseAgent({}));
  assert.ok('assistant-mcp' in full, 'fixture must configure assistant-mcp');
  assert.ok('rivendell-browser' in full);
  const leanSet = optionalMcpServersFor(lean);
  assert.ok(!('assistant-mcp' in leanSet));
  assert.ok('rivendell-browser' in leanSet);
  assert.equal(wantsFullToolbox(undefined) && Object.keys(leanSet).length, Object.keys(full).length - 1);
});

test('laneMcpServers keeps the built-ins for lean lanes', () => {
  const full = laneMcpServers(baseAgent({}), false, undefined);
  const leanSet = laneMcpServers(lean, false, undefined);
  assert.ok(!('assistant-mcp' in leanSet));
  // Whatever built-ins a full lane gets (team bridge etc.), a lean lane keeps.
  for (const name of Object.keys(full)) {
    if (name === 'assistant-mcp') continue;
    assert.ok(name in leanSet, `${name} must survive a lean toolbox`);
  }
});
