import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  hasLaneWorkerMarker,
  isOrphanedLaneWorker,
  laneWorkerEnv,
  laneWorkerTokenOf,
  liveLaneInstanceTokens,
  serviceUnitOf,
  sweepOrphanedLaneWorkers,
  type ProcSnapshot,
} from './workerReap.ts';

const UM = 1000;
const OWN_UNITS = new Set(['rivendell.service']);
/** No live server holds this token: the sweepable case. */
const DEAD = new Set<string>();
/** A live server holds this token: never sweepable. */
const LIVE = new Set(['previous-boot']);
/** A worker from a previous server boot: the dedicated marker, any token. */
const MARKED = 'RIVENDELL_LANE_WORKER=previous-boot\0PATH=/usr/bin\0HOME=/home/x\0';
/** A manual claude that merely inherited the usual TARDIS env keys: no marker. */
const UNMARKED_TARDIS_ENV = 'RIVENDELL_SIDE_COPY=0\0ELROND_WORKSPACE_PATH=/x\0PATH=/usr/bin\0';
const SCOPE_CGROUP = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/session-7.scope';
const UNIT_CGROUP = (unit: string) =>
  `0::/user.slice/user-1000.slice/user@1000.service/app.slice/${unit}`;
/** A hybrid v1/v2 cgroup text where the systemd hierarchy is NOT the last line. */
const HYBRID = (unit: string, tail = 'scope') =>
  `1:name=systemd:/user.slice/user-1000.slice/user@1000.service/app.slice/${unit}\n`
  + `0::/user.slice/user-1000.slice/user@1000.service/app.slice/session-9.${tail}`;

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

function tmpInstanceDir(): string {
  return mkdtempSync(`${tmpdir()}/lane-inst-`);
}

test('laneWorkerEnv registers this boot and stamps its token; the registration reads back live', () => {
  const dir = tmpInstanceDir();
  try {
    const env = laneWorkerEnv(dir);
    const entries = Object.entries(env);
    assert.equal(entries.length, 1);
    const [key, value] = entries[0]!;
    assert.equal(key, 'RIVENDELL_LANE_WORKER');
    assert.ok(value.length > 8, 'instance token is non-trivial');
    assert.ok(hasLaneWorkerMarker(`SOMETHING=1\0${key}=${value}\0PATH=/bin`));
    assert.ok(!hasLaneWorkerMarker(UNMARKED_TARDIS_ENV));
    assert.equal(laneWorkerTokenOf(MARKED), 'previous-boot');
    assert.equal(laneWorkerTokenOf(UNMARKED_TARDIS_ENV), null);
    assert.equal(laneWorkerTokenOf('RIVENDELL_LANE_WORKER=\0PATH=/bin\0'), null, 'an empty token is no token');
    // The registration is live while THIS process runs with its recorded
    // start time — the real registry round trip, not a mock.
    const live = liveLaneInstanceTokens(dir);
    assert.ok(live, 'registry readable');
    assert.ok(live!.has(value), 'this boot is live while it runs');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a token no live server holds is the sweepable one', () => {
  assert.ok(isOrphanedLaneWorker(snap({}), UM, OWN_UNITS, DEAD));
  assert.ok(isOrphanedLaneWorker(snap({ ppid: UM }), UM, OWN_UNITS, DEAD));
});

test("a live server's token is never selected — its disowned background children are safe (Oct 19 FAIL)", () => {
  // Wren's xvfb slack-daemon shape: marker inherited from its lane's
  // worker, disowned, re-parented under the user manager, allowed unit.
  const daemon = snap({
    ppid: UM,
    argv: 'Xvfb :99 node slack-daemon.cjs',
    cgroup: UNIT_CGROUP('rivendell.service'),
  });
  assert.ok(!isOrphanedLaneWorker(daemon, UM, OWN_UNITS, LIVE));
  // The same daemon once its server is gone: swept.
  assert.ok(isOrphanedLaneWorker(daemon, UM, OWN_UNITS, DEAD));
  // The shared Codex app-server broker is the same shape.
  assert.ok(!isOrphanedLaneWorker(snap({ ppid: UM, argv: 'node codex app-server' }), UM, OWN_UNITS, LIVE));
  // No token at all (an unregistrable host, a manual launch): never selected.
  assert.ok(!isOrphanedLaneWorker(snap({ environ: 'RIVENDELL_LANE_WORKER=\0PATH=/bin\0' }), UM, OWN_UNITS, DEAD));
});

test('a live parent is never selected (any live server keeps its workers)', () => {
  assert.ok(!isOrphanedLaneWorker(snap({ ppid: 4242 }), UM, OWN_UNITS, DEAD));
});

test('the dedicated marker is the only ownership proof: a manual claude with ordinary TARDIS env is never selected', () => {
  assert.ok(
    !isOrphanedLaneWorker(
      snap({ environ: UNMARKED_TARDIS_ENV, argv: 'claude --dangerously-skip-permissions' }),
      UM,
      OWN_UNITS,
      DEAD,
    ),
  );
  // Even the shapes the old argv heuristic keyed on are nothing without the
  // marker (the Grok Tell-Max relay class: parentless-shaped user service
  // with an mcp-bearing argv).
  assert.ok(!isOrphanedLaneWorker(snap({ environ: UNMARKED_TARDIS_ENV, argv: 'node mcp-server-x' }), UM, OWN_UNITS, DEAD));
});

test('argv shape never gates selection: script-shaped CLIs carry the marker too', () => {
  for (const argv of [
    'node /home/x/.local/bin/codex-turn.mjs',
    'bun /home/x/.bun/bin/pi -e ext',
    'env CLAUDE=1 claude --p',
    'bash -c echo',
  ]) {
    assert.ok(isOrphanedLaneWorker(snap({ argv }), UM, OWN_UNITS, DEAD), argv);
  }
});

test('a foreign .service cgroup is untouchable even with the marker, on any hierarchy line', () => {
  assert.ok(!isOrphanedLaneWorker(snap({ cgroup: UNIT_CGROUP('tellmax-relay.service') }), UM, OWN_UNITS, DEAD));
  // A unit's own sub-cgroups (systemd sub-directories) still resolve to
  // that unit — the tail segment alone must not decide.
  assert.ok(!isOrphanedLaneWorker(snap({ cgroup: `${UNIT_CGROUP('tellmax-relay.service')}/workers/foo` }), UM, OWN_UNITS, DEAD));
  // Hybrid v1/v2 text where the systemd hierarchy is NOT the last line.
  assert.ok(!isOrphanedLaneWorker(snap({ cgroup: HYBRID('tellmax-relay.service') }), UM, OWN_UNITS, DEAD));
  // A side copy (no units of its own) must not touch a foreign unit either.
  assert.ok(!isOrphanedLaneWorker(snap({ cgroup: UNIT_CGROUP('tellmax-relay.service') }), UM, new Set(), DEAD));
});

test('own units and every deployed TARDIS unit are sweepable, from any TARDIS boot', () => {
  assert.ok(isOrphanedLaneWorker(snap({ cgroup: UNIT_CGROUP('rivendell.service') }), UM, OWN_UNITS, DEAD));
  // Kim's box deploys tardis.service (scripts/setup-kim.sh): its leftovers
  // must not be categorically excluded.
  assert.ok(isOrphanedLaneWorker(snap({ cgroup: UNIT_CGROUP('tardis.service') }), UM, OWN_UNITS, DEAD));
  assert.ok(isOrphanedLaneWorker(snap({ cgroup: UNIT_CGROUP('tardis.service') }), UM, new Set(['tardis.service']), DEAD));
  // A side copy (scope, no units of its own) may reap leftovers inside any TARDIS unit.
  assert.ok(isOrphanedLaneWorker(snap({ cgroup: UNIT_CGROUP('rivendell.service') }), UM, new Set(), DEAD));
  // Our own unit on a non-last hierarchy line is still ours.
  assert.ok(isOrphanedLaneWorker(snap({ cgroup: HYBRID('rivendell.service') }), UM, OWN_UNITS, DEAD));
  // Scope cgroups (jobs, finished session scopes) are where real orphans sit.
  assert.ok(isOrphanedLaneWorker(snap({ cgroup: SCOPE_CGROUP }), UM, new Set(), DEAD));
});

test('self and init are never selected', () => {
  assert.ok(!isOrphanedLaneWorker(snap({ pid: process.pid }), UM, OWN_UNITS, DEAD));
  assert.ok(!isOrphanedLaneWorker(snap({ pid: 1 }), UM, OWN_UNITS, DEAD));
});

test('liveLaneInstanceTokens: live while pid+starttime match, dead and pruned otherwise, unverifiable fails safe', () => {
  const dir = tmpInstanceDir();
  try {
    // A dead server: pid gone → not live, file pruned.
    writeFileSync(`${dir}/dead-gone`, JSON.stringify({ pid: 999_999_999, starttime: 1 }));
    // A pid the kernel reused: alive pid, wrong start time → dead, pruned.
    writeFileSync(`${dir}/dead-reused`, JSON.stringify({ pid: process.pid, starttime: 1 }));
    // Unverifiable identities fail safe: counted live, never pruned.
    writeFileSync(`${dir}/init-claim`, JSON.stringify({ pid: 1, starttime: 1 }));
    writeFileSync(`${dir}/garbage`, '{not json');
    writeFileSync(`${dir}/string-pid`, JSON.stringify({ pid: '5', starttime: 1 }));
    // This process, registered through laneWorkerEnv: the live case.
    const token = laneWorkerEnv(dir)['RIVENDELL_LANE_WORKER']!;
    const live = liveLaneInstanceTokens(dir);
    assert.ok(live, 'registry readable');
    assert.ok(live!.has(token), 'a live registered boot is live');
    for (const safe of ['init-claim', 'garbage', 'string-pid']) {
      assert.ok(live!.has(safe), `${safe} fails safe (counted live)`);
      assert.ok(existsSync(`${dir}/${safe}`), `${safe} is kept`);
    }
    for (const dead of ['dead-gone', 'dead-reused']) {
      assert.ok(!live!.has(dead), `${dead} is dead`);
      assert.ok(!existsSync(`${dir}/${dead}`), `${dead} is pruned`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable registry fails safe: the sweep reaps nothing it cannot prove dead', () => {
  const notADir = `${tmpdir()}/lane-inst-not-a-dir-${process.pid}`;
  writeFileSync(notADir, 'x'); // a file where the registry dir should be: registering and reading both fail
  try {
    const list = () => [snap({}), snap({ argv: 'node /home/x/.local/bin/codex-turn.mjs' })];
    const reaped = sweepOrphanedLaneWorkers(list, notADir);
    assert.deepEqual(reaped.killed, []);
  } finally {
    rmSync(notADir, { force: true });
  }
});

test('serviceUnitOf parses one hierarchy line, tail-first', () => {
  assert.equal(serviceUnitOf(UNIT_CGROUP('rivendell.service')), 'rivendell.service');
  assert.equal(serviceUnitOf(UNIT_CGROUP('tardis.service')), 'tardis.service');
  assert.equal(serviceUnitOf(`${UNIT_CGROUP('tellmax-relay.service')}/workers/foo`), 'tellmax-relay.service');
  assert.equal(serviceUnitOf(`${UNIT_CGROUP('rivendell.service')}/children/bar`), 'rivendell.service');
  assert.equal(serviceUnitOf(SCOPE_CGROUP), null);
  assert.equal(serviceUnitOf('0::/user.slice/user-1000.slice/user@1000.service'), null);
  assert.equal(serviceUnitOf(''), null);
});
