import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { codexToolboxArgs } from './codex-toolbox.ts';

const disabled = ['-c', 'mcp_servers.assistant-mcp.enabled=false'];

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'codex-toolbox-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const repo = join(root, 'repo');
  mkdirSync(home);
  mkdirSync(join(repo, '.git'), { recursive: true });
  const config = (path: string, text: string) => {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'config.toml'), text);
  };
  const system = join(root, 'etc', 'codex');
  const args = (fullToolbox: boolean, cwd = repo) => codexToolboxArgs(fullToolbox, home, cwd, join(system, 'config.toml'));
  return { root, home, repo, system, config, args };
}

test('Codex full lanes and homes without assistant-mcp need no override', t => {
  const { home, config, args } = fixture(t);
  assert.deepEqual(args(false), []);
  config(home, '[mcp_servers.assistant-mcp]\ncommand = "node"\n');
  assert.deepEqual(args(true), []);
});

test('Codex recognizes real TOML instead of only a literal table header', t => {
  const { home, config, args } = fixture(t);
  for (const text of [
    '[mcp_servers.assistant-mcp] # operator comment\ncommand = "node"\n',
    '["mcp_servers" . \'assistant-mcp\']\nurl = "https://example.invalid/mcp"\n',
    'mcp_servers = { assistant-mcp = { command = "node" } }\n',
    'mcp_servers.assistant-mcp.command = "node"\n',
  ]) {
    config(home, text);
    assert.deepEqual(args(false), disabled, text);
  }
});

test('comments and multiline strings are not Codex MCP server definitions', t => {
  const { home, config, args } = fixture(t);
  config(home, '# [mcp_servers.assistant-mcp]\nnotes = """\n[mcp_servers.assistant-mcp]\n"""\n');
  assert.deepEqual(args(false), []);
});

test('Codex project-only overrides retain a transport even if the project is untrusted', t => {
  const { repo, config, args } = fixture(t);
  for (const [key, value, inert] of [
    ['command', 'node', 'node'],
    ['url', 'https://fixture:password@example.invalid/mcp?token=secret', 'http://127.0.0.1:9/disabled'],
  ]) {
    config(join(repo, '.codex'), `[mcp_servers.assistant-mcp]\n${key} = ${JSON.stringify(value)}\n`);
    assert.deepEqual(args(false), [
      ...disabled, '-c', `mcp_servers.assistant-mcp.${key}=${JSON.stringify(inert)}`,
    ]);
  }
});

test('Codex finds ancestor project servers from a nested cwd and stops at the repository', t => {
  const { root, repo, config, args } = fixture(t);
  const cwd = join(repo, 'packages', 'client');
  mkdirSync(cwd, { recursive: true });
  config(join(repo, '.codex'), 'mcp_servers.assistant-mcp.command = "node"\n');
  assert.deepEqual(args(false, cwd), [...disabled, '-c', 'mcp_servers.assistant-mcp.command="node"']);
  rmSync(join(repo, '.codex'), { recursive: true });
  config(join(root, '.codex'), 'mcp_servers.assistant-mcp.command = "outside-repo"\n');
  assert.deepEqual(args(false, cwd), []);
});

test('Codex disables system-only assistant-mcp without replacing its transport', t => {
  const { system, home, config, args } = fixture(t);
  for (const transport of [
    'command = "node"',
    'url = "https://fixture:password@example.invalid/mcp?token=secret"',
  ]) {
    config(system, `[mcp_servers.assistant-mcp]\n${transport}\n`);
    // User-level settings need not repeat the inherited system transport.
    config(home, 'mcp_servers.assistant-mcp.enabled = true\n');
    assert.deepEqual(args(false), disabled);
    assert.deepEqual(args(true), []);
  }
});

test('Codex disables cwd-only assistant-mcp with an inert transport for untrusted projects', t => {
  const { repo, config, args } = fixture(t);
  const cwd = join(repo, 'nested');
  for (const [key, value, inert] of [
    ['command', 'project-command', 'node'],
    ['url', 'https://fixture:password@example.invalid/mcp?token=secret', 'http://127.0.0.1:9/disabled'],
  ]) {
    config(cwd, `[mcp_servers.assistant-mcp]\n${key} = ${JSON.stringify(value)}\n`);
    assert.deepEqual(args(false, cwd), [
      ...disabled, '-c', `mcp_servers.assistant-mcp.${key}=${JSON.stringify(inert)}`,
    ]);
    assert.deepEqual(args(true, cwd), []);
    assert.deepEqual(args(false), []);
  }
});

test('Codex fails closed for malformed system and cwd configs, without probing full lanes', t => {
  const { system, repo, config, args } = fixture(t);
  for (const dir of [system, repo]) {
    config(dir, '[mcp_servers.assistant-mcp\n');
    assert.throws(() => args(false));
    assert.deepEqual(args(true), []);
    rmSync(join(dir, 'config.toml'));
  }
});
