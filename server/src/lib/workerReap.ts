import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * TARDIS spawns every lane worker (claude, codex, agy, pi, banana, the
 * headless worker, and the MCP tool children they start) with the server's
 * environment so subscription routing survives inside the child, and the
 * chat workers detached so a worker's own crash can never tear down the
 * server. The cost: when a server exits (a planned restart, an OOM kill, a
 * finished precheck or side-copy boot) every worker it had spawned keeps
 * running, re-parented under the user manager with nothing left to ever
 * kill it. On Oct 19 2026 that had stacked 25 finished-turn worker trees
 * (435 processes, 7 GB plus their swap) on a box that then OOM-killed
 * TARDIS nine times in one night (card-16bc3e).
 *
 * Root fix, two halves:
 *
 *  - Identity: every worker spawn goes through spawnLaneWorker, which stamps
 *    the child with a dedicated RIVENDELL_LANE_WORKER marker (this boot's
 *    instance token). The marker is the ONLY ownership proof the sweep
 *    trusts. A manually launched claude/codex that merely inherits other
 *    RIVENDELL_* keys is never selected, and nothing is inferred from argv
 *    shape (script CLIs appear as node/bun/env, MCP children as anything).
 *
 *  - Reaping: at boot, before this boot spawns anything, every
 *    marker-carrying process with no living parent is a leftover from a
 *    previous server. SIGTERM it — its process group when it leads one
 *    (detached workers do), its enumerated descendants when it does not
 *    (the headless worker keeps the dead server's group) — then SIGKILL the
 *    survivors after a 3s grace, the same shutdown idiom the session
 *    runners use, revalidating each pid's start time first so a pid the
 *    kernel has reused is never signalled.
 */

const LANE_WORKER_ENV_KEY = 'RIVENDELL_LANE_WORKER';
/** This server boot's token. Any previous boot's token is equally sweepable. */
const LANE_WORKER_INSTANCE = randomUUID();

/** Deployed TARDIS unit names (Moria: rivendell.service, per
 *  docs/DEPLOYMENT.md; Kim's box: tardis.service, per scripts/setup-kim.sh).
 *  A leftover sitting in any of these cgroups is ours on some host; any
 *  OTHER named .service cgroup is another unit's process and untouchable. */
const TARDIS_UNIT_NAMES = new Set(['rivendell.service', 'tardis.service']);

export interface ProcSnapshot {
  pid: number;
  ppid: number;
  /** Kernel start time (stat field 22): the pid's identity for revalidation
   *  before every signal, so a pid the kernel has reused is never killed. */
  starttime: number;
  /** NUL-joined environ, used only for marker matching, never logged. */
  environ: string;
  argv: string;
  /** Cgroup path (cgroup v2 line, e.g. "0::/user.slice/.../rivendell.service"). */
  cgroup: string;
}

/** The dedicated lane-worker marker stamped on every worker spawn. */
export function hasLaneWorkerMarker(environ: string): boolean {
  return environ.split('\0').some((entry) => entry.startsWith(`${LANE_WORKER_ENV_KEY}=`));
}

/** Env stamp for a lane-worker spawn (identity + nothing else). */
export function laneWorkerEnv(): Record<string, string> {
  return { [LANE_WORKER_ENV_KEY]: LANE_WORKER_INSTANCE };
}

/** The named .service unit a cgroup path sits in, or null for scope/plain
 *  cgroups (jobs, session scopes, the bare user-manager cgroup). Scans from
 *  the tail so a unit's own sub-cgroups (unit/children/foo) still resolve
 *  to that unit. The user manager's root cgroup (user@1000.service) is not
 *  an app unit: a leftover migrated there is still sweepable. */
export function serviceUnitOf(cgroup: string): string | null {
  const line = cgroup.trim().split('\n').pop() ?? '';
  for (const seg of line.split('/').reverse()) {
    if (/^user@\d+\.service$/.test(seg)) continue;
    if (/\.service$/.test(seg)) return seg;
  }
  return null;
}

export function isOrphanedLaneWorker(
  proc: ProcSnapshot,
  userManagerPid: number,
  ownUnit: string | null,
): boolean {
  if (proc.pid === process.pid || proc.pid <= 1) return false;
  // Parentless: the spawning server is gone (a re-parented child lands under
  // init or the user manager). A worker of any LIVE server — production, a
  // precheck copy, another side-copy boot — keeps a live parent and is never
  // selected.
  if (proc.ppid !== 1 && proc.ppid !== userManagerPid) return false;
  // The dedicated marker is the only ownership proof: this key is set by
  // spawnLaneWorker alone, and every worker's MCP children inherit it.
  if (!hasLaneWorkerMarker(proc.environ)) return false;
  // A named .service cgroup that is neither our own unit nor a deployed
  // TARDIS unit is another unit's process. Belt and suspenders on top of the
  // marker: the Oct 19 dry run caught the Grok Tell-Max relay — a running
  // user service whose environment and "mcp"-bearing argv overlap ours —
  // and a stamp must never license touching another unit. Scope cgroups
  // (jobs, finished session scopes) stay sweepable, which is where real
  // orphans sit.
  const unit = serviceUnitOf(proc.cgroup);
  if (unit && unit !== ownUnit && !TARDIS_UNIT_NAMES.has(unit)) return false;
  return true;
}

/** The user manager is the ancestor of this process whose own parent is
 * PID 1 (systemd --user for a user unit; PID 1 itself as the safe floor). */
export function userManagerPid(): number {
  const seen = new Set<number>();
  let pid = process.pid;
  while (!seen.has(pid)) {
    seen.add(pid);
    let ppid = 1;
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      ppid = Number(/^PPid:\s+(\d+)/m.exec(status)?.[1] ?? 1);
    } catch {
      return 1;
    }
    if (!ppid || ppid === 1) return pid === process.pid ? 1 : pid;
    pid = ppid;
  }
  return 1;
}

function snapshotProc(pid: number): ProcSnapshot | null {
  try {
    const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
    if (!argv) return null; // kernel threads have no cmdline
    const stat = readProcStat(pid);
    if (!stat) return null; // no identity to revalidate: never selectable
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const ppid = Number(/^PPid:\s+(\d+)/m.exec(status)?.[1] ?? 0);
    if (!ppid) return null;
    // An unreadable environ (another user's process) fails closed: the
    // snapshot is skipped, so it can never be selected.
    const environ = readFileSync(`/proc/${pid}/environ`, 'utf8');
    const cgroup = readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim().split('\n').pop() ?? '';
    return { pid, ppid, starttime: stat.starttime, environ, argv, cgroup };
  } catch {
    return null; // exited between readdir and read
  }
}

export function listProcSnapshots(): ProcSnapshot[] {
  const out: ProcSnapshot[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const snap = snapshotProc(Number(entry));
    if (snap) out.push(snap);
  }
  return out;
}

interface ProcStat { pgrp: number; starttime: number }

/** pgrp (stat field 5) and starttime (field 22) from /proc/<pid>/stat. The
 *  comm field can contain spaces and parens, so parse after the last ')'. */
function readProcStat(pid: number): ProcStat | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const pgrp = Number(after[2]);
    const starttime = Number(after[19]);
    if (!pgrp || !starttime) return null;
    return { pgrp, starttime };
  } catch {
    return null; // exited
  }
}

/** Every pid descending from rootPid in the given listing. */
function descendantsOf(rootPid: number, procs: ProcSnapshot[]): number[] {
  const children = new Map<number, number[]>();
  for (const p of procs) {
    const list = children.get(p.ppid);
    if (list) list.push(p.pid);
    else children.set(p.ppid, [p.pid]);
  }
  const out: number[] = [];
  const queue = [rootPid];
  const seen = new Set<number>([rootPid]);
  while (queue.length) {
    const pid = queue.shift()!;
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

export interface ReapedWorker { pid: number; argv: string }

interface KillTarget { pid: number; starttime: number; groupLeader: boolean }

/** Kill every orphaned lane worker from a previous server. SIGTERM (the
 *  process group when the victim leads one, the victim plus its enumerated
 *  descendants when it does not), then SIGKILL the still-living targets
 *  after a 3s grace — the same shutdown idiom the session runners use.
 *  Every delayed kill is revalidated against the start time recorded when
 *  the target was first signalled, so a pid the kernel has reused in the
 *  grace window is never signalled. A descendant forked inside the grace
 *  window and not enumerated at TERM time survives to the next boot's
 *  sweep (it still carries the marker). Idempotent across concurrent boots:
 *  a second sweep of a dying group hits ESRCH and moves on. */
export function sweepOrphanedLaneWorkers(
  list: () => ProcSnapshot[] = listProcSnapshots,
): { killed: ReapedWorker[] } {
  if (!existsSync('/proc')) return { killed: [] }; // non-Linux host: nothing to sweep
  const um = userManagerPid();
  const ownUnit = serviceUnitOf(readSelfCgroup());
  const procs = list();
  const byPid = new Map(procs.map((p) => [p.pid, p] as const));
  const victims = procs.filter((p) => isOrphanedLaneWorker(p, um, ownUnit));
  const killed: ReapedWorker[] = [];
  const targets: KillTarget[] = [];
  for (const victim of victims) {
    const stat = readProcStat(victim.pid);
    // Revalidate before every signal: the pid must still be the process the
    // snapshot selected. A victim that exited and had its pid reused in the
    // snapshot-to-kill window is never signalled — nor, if it led a group,
    // is its (unrelated) new group.
    if (!stat || stat.starttime !== victim.starttime) continue;
    const groupLeader = stat.pgrp === victim.pid;
    targets.push({ pid: victim.pid, starttime: stat.starttime, groupLeader });
    try {
      // A detached worker leads its own process group (its MCP children
      // stay in it); a non-detached one (the headless worker) keeps the dead
      // server's group, where killing -pid would signal strangers.
      if (groupLeader) process.kill(-victim.pid, 'SIGTERM');
      process.kill(victim.pid, 'SIGTERM');
    } catch { /* gone */ }
    // Descendants outside the group (a child that setpgid'd or daemonized
    // into its own) are TERMed directly; in-group ones just get a second,
    // harmless TERM. Each is revalidated against the snapshot the same way.
    for (const pid of descendantsOf(victim.pid, procs)) {
      const desc = byPid.get(pid);
      const childStat = readProcStat(pid);
      if (!desc || !childStat || childStat.starttime !== desc.starttime) continue;
      targets.push({ pid, starttime: childStat.starttime, groupLeader: false });
      try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
    }
    killed.push({ pid: victim.pid, argv: victim.argv.slice(0, 120) });
  }
  if (!targets.length) return { killed };
  setTimeout(() => {
    for (const target of targets) {
      const stat = readProcStat(target.pid);
      if (!stat || stat.starttime !== target.starttime) continue; // gone, or pid reused
      try {
        if (target.groupLeader) process.kill(-target.pid, 'SIGKILL');
        process.kill(target.pid, 'SIGKILL');
      } catch { /* gone */ }
    }
  }, 3_000).unref();
  return { killed };
}

function readSelfCgroup(): string {
  try {
    return readFileSync('/proc/self/cgroup', 'utf8');
  } catch {
    return '';
  }
}

/**
 * Turn workers must stay the box's preferred OOM victims: the server unit is
 * protected (OOMScoreAdjust=-500, Max's call Oct 19 2026) so TARDIS survives
 * memory pressure, and every worker it spawns is raised back to the
 * inherited user-service score 200 so a runaway turn dies before the
 * desktop or the server does. Raising a child's score above the spawner's
 * own needs no privileges; an already-exited pid is ignored; any other
 * failure is logged so a protection gap is never silent.
 */
export function markLaneWorkerKillable(pid: number | undefined): void {
  if (!pid || pid <= 1) return;
  try {
    writeFileSync(`/proc/${pid}/oom_score_adj`, '200');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ESRCH') {
      console.warn(`[worker-reap] could not raise oom_score_adj for worker pid ${pid}: ${(err as Error).message}`);
    }
  }
}

/** Raise the child's own oom_score_adj BEFORE exec'ing the CLI, so no
 *  descendant (an MCP server the CLI forks during startup) can race ahead
 *  of the write and inherit the protected server's -500. Quiet on failure:
 *  the post-spawn fallback in markLaneWorkerKillable observes and logs.
 *  Linux-only: the score file lives in /proc, which the sweep already
 *  treats as optional on other hosts. */
const LANE_WORKER_WRAPPER = 'echo 200 > /proc/self/oom_score_adj 2>/dev/null; exec "$@"';

const IS_LINUX = process.platform === 'linux';

/** Would a direct spawn of this command find an executable (the same
 *  resolution a shell or the OS would do)? An unresolvable command skips
 *  the wrapper so the direct spawn keeps its legacy failure semantics
 *  (the ENOENT/EACCES 'error' event) instead of a wrapper exit 126/127. */
function commandResolves(command: string): boolean {
  if (command.includes('/')) {
    try { accessSync(command, constants.X_OK); return true; } catch { return false; }
  }
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) continue;
    try { accessSync(join(dir, command), constants.X_OK); return true; } catch { /* keep scanning */ }
  }
  return false;
}

/**
 * Spawn a lane worker. On Linux, with a resolvable command, the child runs
 * through a bash wrapper that raises its own OOM score before exec'ing the
 * real CLI (argv, cwd, detached, stdio and the caller's env are all
 * preserved; exec keeps the pid, so session runners and watchers keep
 * working unchanged). Every path — wrapped or direct — stamps the child's
 * env with this boot's lane-worker marker so the boot sweep can prove
 * ownership. Non-Linux hosts and unresolvable commands spawn directly.
 * Callers pass exactly the spawn options they passed before.
 */
export function spawnLaneWorker(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  const env = options.env
    ? { ...options.env, ...laneWorkerEnv() }
    : { ...process.env, ...laneWorkerEnv() };
  const child = IS_LINUX && commandResolves(command)
    ? spawn('/bin/bash', ['-c', LANE_WORKER_WRAPPER, 'lane-worker', command, ...args], { ...options, env })
    : spawn(command, args, { ...options, env });
  markLaneWorkerKillable(child.pid);
  return child;
}
