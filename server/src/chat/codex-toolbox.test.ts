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
  return { root, home, repo, config };
}

test('Codex full lanes and homes without assistant-mcp need no override', t => {
  const { home, repo, config } = fixture(t);
  assert.deepEqual(codexToolboxArgs(false, home, repo), []);
  config(home, '[mcp_servers.assistant-mcp]\ncommand = "node"\n');
  assert.deepEqual(codexToolboxArgs(true, home, repo), []);
});

test('Codex recognizes real TOML instead of only a literal table header', t => {
  const { home, repo, config } = fixture(t);
  for (const text of [
    '[mcp_servers.assistant-mcp] # operator comment\ncommand = "node"\n',
    '["mcp_servers" . \'assistant-mcp\']\nurl = "https://example.invalid/mcp"\n',
    'mcp_servers = { assistant-mcp = { command = "node" } }\n',
    'mcp_servers.assistant-mcp.command = "node"\n',
  ]) {
    config(home, text);
    assert.deepEqual(codexToolboxArgs(false, home, repo), disabled, text);
  }
});

test('comments and multiline strings are not Codex MCP server definitions', t => {
  const { home, repo, config } = fixture(t);
  config(home, '# [mcp_servers.assistant-mcp]\nnotes = """\n[mcp_servers.assistant-mcp]\n"""\n');
  assert.deepEqual(codexToolboxArgs(false, home, repo), []);
});

test('Codex project-only overrides retain a transport even if the project is untrusted', t => {
  const { home, repo, config } = fixture(t);
  for (const [key, value, inert] of [
    ['command', 'node', 'node'],
    ['url', 'https://fixture:password@example.invalid/mcp?token=secret', 'http://127.0.0.1:9/disabled'],
  ]) {
    config(join(repo, '.codex'), `[mcp_servers.assistant-mcp]\n${key} = ${JSON.stringify(value)}\n`);
    assert.deepEqual(codexToolboxArgs(false, home, repo), [
      ...disabled, '-c', `mcp_servers.assistant-mcp.${key}=${JSON.stringify(inert)}`,
    ]);
  }
});

test('Codex finds ancestor project servers from a nested cwd and stops at the repository', t => {
  const { root, home, repo, config } = fixture(t);
  const cwd = join(repo, 'packages', 'client');
  mkdirSync(cwd, { recursive: true });
  config(join(repo, '.codex'), 'mcp_servers.assistant-mcp.command = "node"\n');
  assert.deepEqual(codexToolboxArgs(false, home, cwd), [...disabled, '-c', 'mcp_servers.assistant-mcp.command="node"']);
  rmSync(join(repo, '.codex'), { recursive: true });
  config(join(root, '.codex'), 'mcp_servers.assistant-mcp.command = "outside-repo"\n');
  assert.deepEqual(codexToolboxArgs(false, home, cwd), []);
});
