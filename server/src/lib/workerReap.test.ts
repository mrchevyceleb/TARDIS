import assert from 'node:assert/strict';
import test from 'node:test';
import { hasTardisEnvMarker, isOrphanedLaneWorker, markLaneWorkerKillable, type ProcSnapshot } from './workerReap.ts';

const UM = 2631;
const SCRIPT = '/srv/Rivendell/server/scripts/codex-app-turn.mjs';

function snap(partial: Partial<ProcSnapshot> & { pid: number }): ProcSnapshot {
  return {
    ppid: 3908087,
    environ: 'ELROND_WORKSPACE_PATH=/home/x/ASSISTANT-HUB\0RIVENDELL_PREWARM_AGENTS=true\0PATH=/usr/bin\0',
    argv: 'claude -p --append-system-prompt X',
    cgroup: '0::/user.slice/user-1000.slice/user@1000.service/app.slice/tardis-job-abc123.scope',
    ...partial,
  };
}

test('env marker matches the family keys exactly, not values or paths', () => {
  assert.equal(hasTardisEnvMarker('ELROND_WORKSPACE_PATH=/x\0PATH=/usr/bin\0'), true);
  assert.equal(hasTardisEnvMarker('RIVENDELL_PREWARM_AGENTS=true\0'), true);
  assert.equal(hasTardisEnvMarker('PATH=/usr/bin\0HOME=/home/x\0'), false);
  assert.equal(hasTardisEnvMarker('/home/x/RIVENDELL_notes=/x\0'), false);
});

test('selects a parentless TARDIS claude worker', () => {
  assert.equal(isOrphanedLaneWorker(snap({ pid: 101, ppid: UM }), UM, SCRIPT), true);
});

test('never selects a worker with a living parent (any live server)', () => {
  assert.equal(isOrphanedLaneWorker(snap({ pid: 102, ppid: 555 }), UM, SCRIPT), false);
});

test('never selects a detached machine service without the family marker', () => {
  assert.equal(
    isOrphanedLaneWorker(
      snap({ pid: 103, ppid: UM, environ: 'PATH=/usr/bin\0', argv: 'node /home/x/autosam-llm-failover/failover.mjs' }),
      UM, SCRIPT,
    ),
    false,
  );
});

test('never selects a parentless non-worker process (an overnight run stays untouched)', () => {
  assert.equal(
    isOrphanedLaneWorker(snap({ pid: 104, ppid: UM, argv: 'python train.py --epochs 4' }), UM, SCRIPT),
    false,
  );
});

test('selects the codex turn adapter and the codex app-server', () => {
  assert.equal(isOrphanedLaneWorker(snap({ pid: 105, ppid: 1, argv: `node ${SCRIPT}` }), UM, SCRIPT), true);
  assert.equal(
    isOrphanedLaneWorker(snap({ pid: 106, ppid: 1, argv: '/home/x/.local/bin/codex app-server --listen stdio://' }), UM, SCRIPT),
    true,
  );
});

test('selects re-parented MCP tool children', () => {
  assert.equal(
    isOrphanedLaneWorker(
      snap({ pid: 107, ppid: UM, argv: 'node /home/x/samwise/Personal-Apps/rivendell-browser-bridge/bridge/mcp-server.mjs' }),
      UM, SCRIPT,
    ),
    true,
  );
});

test('never selects this process itself', () => {
  assert.equal(isOrphanedLaneWorker(snap({ pid: process.pid, ppid: UM }), UM, SCRIPT), false);
});

test('never selects another unit\'s service main (the Grok Tell-Max relay)', () => {
  assert.equal(
    isOrphanedLaneWorker(
      snap({
        pid: 108,
        ppid: UM,
        argv: 'node /home/x/ASSISTANT-HUB/projects/assistant-mcp/relay/grok-max-relay.mjs',
        cgroup: '0::/user.slice/user-1000.slice/user@1000.service/app.slice/grok-max-relay.service',
      }),
      UM, SCRIPT,
    ),
    false,
  );
});

test('still selects orphans in job scopes, dead session scopes, and TARDIS\'s own unit', () => {
  assert.equal(isOrphanedLaneWorker(snap({ pid: 109, ppid: 1 }), UM, SCRIPT), true);
  assert.equal(
    isOrphanedLaneWorker(
      snap({ pid: 110, ppid: UM, cgroup: '0::/user.slice/user-1000.slice/user@1000.service/app.slice/tmux-3.scope' }),
      UM, SCRIPT,
    ),
    true,
  );
  assert.equal(
    isOrphanedLaneWorker(
      snap({ pid: 111, ppid: UM, cgroup: '0::/user.slice/user-1000.slice/user@1000.service/app.slice/rivendell.service' }),
      UM, SCRIPT,
    ),
    true,
  );
});

test('markLaneWorkerKillable guards non-pids', () => {
  assert.equal(markLaneWorkerKillable(undefined), undefined);
  assert.equal(markLaneWorkerKillable(0), undefined);
  assert.equal(markLaneWorkerKillable(1), undefined);
});
