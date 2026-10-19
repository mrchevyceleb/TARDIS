import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasLaneWorkerMarker,
  isOrphanedLaneWorker,
  laneWorkerEnv,
  serviceUnitOf,
  type ProcSnapshot,
} from './workerReap.ts';

const UM = 1000;
const OWN_UNIT = 'rivendell.service';
/** A worker from a previous server boot: the dedicated marker, any token. */
const MARKED = 'RIVENDELL_LANE_WORKER=previous-boot\0PATH=/usr/bin\0HOME=/home/x\0';
/** A manual claude that merely inherited the usual TARDIS env keys: no marker. */
const UNMARKED_TARDIS_ENV = 'RIVENDELL_SIDE_COPY=0\0ELROND_WORKSPACE_PATH=/x\0PATH=/usr/bin\0';
const SCOPE_CGROUP = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/session-7.scope';
const UNIT_CGROUP = (unit: string) =>
  `0::/user.slice/user-1000.slice/user@1000.service/app.slice/${unit}`;

function snap(partial: Partial<ProcSnapshot>): ProcSnapshot {
  return {
    pid: 123,
    ppid: 1,
    starttime: 999888,
    environ: MARKED,
    argv: 'claude --dangerously-skip-permissions',
    cgroup: SCOPE_CGROUP,
    ...partial,
  };
}

test('laneWorkerEnv stamps the dedicated marker; hasLaneWorkerMarker matches it', () => {
  const env = laneWorkerEnv();
  const entries = Object.entries(env);
  assert.equal(entries.length, 1);
  const [key, value] = entries[0]!;
  assert.equal(key, 'RIVENDELL_LANE_WORKER');
  assert.ok(value.length > 8, 'instance token is non-trivial');
  assert.ok(hasLaneWorkerMarker(`SOMETHING=1\0${key}=${value}\0PATH=/bin`));
  assert.ok(!hasLaneWorkerMarker(UNMARKED_TARDIS_ENV));
});

test('marker + no living parent + no foreign unit = selected', () => {
  assert.ok(isOrphanedLaneWorker(snap({}), UM, OWN_UNIT));
  assert.ok(isOrphanedLaneWorker(snap({ ppid: UM }), UM, OWN_UNIT));
});

test('a live parent is never selected (any live server keeps its workers)', () => {
  assert.ok(!isOrphanedLaneWorker(snap({ ppid: 4242 }), UM, OWN_UNIT));
});

test('the dedicated marker is the only ownership proof: a manual claude with ordinary TARDIS env is never selected', () => {
  assert.ok(
    !isOrphanedLaneWorker(
      snap({ environ: UNMARKED_TARDIS_ENV, argv: 'claude --dangerously-skip-permissions' }),
      UM,
      OWN_UNIT,
    ),
  );
  // Even the shapes the old argv heuristic keyed on are nothing without the
  // marker (the Grok Tell-Max relay class: parentless-shaped user service
  // with an mcp-bearing argv).
  assert.ok(!isOrphanedLaneWorker(snap({ environ: UNMARKED_TARDIS_ENV, argv: 'node mcp-server-x' }), UM, OWN_UNIT));
});

test('argv shape never gates selection: script-shaped CLIs carry the marker too', () => {
  for (const argv of [
    'node /home/x/.local/bin/codex-turn.mjs',
    'bun /home/x/.bun/bin/pi -e ext',
    'env CLAUDE=1 claude --p',
    'bash -c echo',
  ]) {
    assert.ok(isOrphanedLaneWorker(snap({ argv }), UM, OWN_UNIT), argv);
  }
});

test('a foreign .service cgroup is untouchable even with the marker', () => {
  assert.ok(!isOrphanedLaneWorker(snap({ cgroup: UNIT_CGROUP('tellmax-relay.service') }), UM, OWN_UNIT));
  // A unit's own sub-cgroups (systemd sub-directories) still resolve to
  // that unit — the tail segment alone must not decide.
  assert.ok(!isOrphanedLaneWorker(snap({ cgroup: `${UNIT_CGROUP('tellmax-relay.service')}/workers/foo` }), UM, OWN_UNIT));
  // A side copy (own unit null) must not touch a foreign unit either.
  assert.ok(!isOrphanedLaneWorker(snap({ cgroup: UNIT_CGROUP('tellmax-relay.service') }), UM, null));
});

test('own unit and every deployed TARDIS unit are sweepable, from any TARDIS boot', () => {
  assert.ok(isOrphanedLaneWorker(snap({ cgroup: UNIT_CGROUP('rivendell.service') }), UM, OWN_UNIT));
  // Kim's box deploys tardis.service (scripts/setup-kim.sh): its leftovers
  // must not be categorically excluded.
  assert.ok(isOrphanedLaneWorker(snap({ cgroup: UNIT_CGROUP('tardis.service') }), UM, OWN_UNIT));
  assert.ok(isOrphanedLaneWorker(snap({ cgroup: UNIT_CGROUP('tardis.service') }), UM, 'tardis.service'));
  // A side copy (scope, own unit null) may reap leftovers inside any TARDIS unit.
  assert.ok(isOrphanedLaneWorker(snap({ cgroup: UNIT_CGROUP('rivendell.service') }), UM, null));
  // Scope cgroups (jobs, finished session scopes) are where real orphans sit.
  assert.ok(isOrphanedLaneWorker(snap({ cgroup: SCOPE_CGROUP }), UM, null));
});

test('self and init are never selected', () => {
  assert.ok(!isOrphanedLaneWorker(snap({ pid: process.pid }), UM, OWN_UNIT));
  assert.ok(!isOrphanedLaneWorker(snap({ pid: 1 }), UM, OWN_UNIT));
});

test('serviceUnitOf parses the trailing named unit only', () => {
  assert.equal(serviceUnitOf(UNIT_CGROUP('rivendell.service')), 'rivendell.service');
  assert.equal(serviceUnitOf(UNIT_CGROUP('tardis.service')), 'tardis.service');
  assert.equal(serviceUnitOf(`${UNIT_CGROUP('tellmax-relay.service')}/workers/foo`), 'tellmax-relay.service');
  assert.equal(serviceUnitOf(`${UNIT_CGROUP('rivendell.service')}/children/bar`), 'rivendell.service');
  assert.equal(serviceUnitOf(SCOPE_CGROUP), null);
  assert.equal(serviceUnitOf('0::/user.slice/user-1000.slice/user@1000.service'), null);
  assert.equal(serviceUnitOf(''), null);
});
