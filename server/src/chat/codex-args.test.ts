import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCodexAppServerArgs, shouldRetryEmptyCodexTurn } from './codex-args.ts';

test('isolates the steerable Codex app-server from the competing native agent bus', () => {
  assert.deepEqual(
    buildCodexAppServerArgs(['-c', 'mcp_servers.rivendell-team.command="node"']),
    [
      'app-server', '--listen', 'stdio://',
      '--disable', 'multi_agent',
      '-c', 'model_auto_compact_token_limit=200000',
      '-c', 'model_auto_compact_token_limit_scope="total"',
      '-c', 'mcp_servers.rivendell-team.command="node"',
    ],
  );
});


test('retries only a first empty Codex crash with no side-effect activity', () => {
  const emptyFailure = {
    code: 1,
    signal: null,
    producedAgentMessage: false,
    sawActionableItem: false,
    sawTurnCompleted: false,
    stderr: '',
    transientProjectConfigError: false,
    retryDepth: 0,
  } as const;
  assert.equal(shouldRetryEmptyCodexTurn(emptyFailure), true);
  assert.equal(shouldRetryEmptyCodexTurn({ ...emptyFailure, code: 0 }), true);
  assert.equal(shouldRetryEmptyCodexTurn({ ...emptyFailure, retryDepth: 1 }), false);
  assert.equal(shouldRetryEmptyCodexTurn({ ...emptyFailure, sawActionableItem: true }), false);
  assert.equal(shouldRetryEmptyCodexTurn({ ...emptyFailure, signal: 'SIGKILL', code: 137 }), false);
  assert.equal(shouldRetryEmptyCodexTurn({ ...emptyFailure, stderr: 'authentication failed' }), false);
});
