import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { CODEX_APP_TURN_SCRIPT } from '../config.ts';

/**
 * TARDIS spawns every lane worker (claude, codex, agy, pi, banana, and the
 * MCP tool children they start) with `detached: true` so a worker's own
 * crash can never tear down the server, and with the server's environment so
 * subscription routing survives inside the child. The cost: when a server
 * exits (a planned restart, an OOM kill, a finished precheck or side-copy
 * boot) every worker it had spawned keeps running, re-parented under the
 * user manager with nothing left to ever kill it. On Oct 19 2026 that had
 * stacked 25 finished-turn worker trees (435 processes, 7 GB plus their
 * swap) on a box that then OOM-killed TARDIS nine times in one night
 * (card-16bc3e).
 *
 * The root fix is the boot sweep: a process that carries the TARDIS
 * environment marker, has no living parent, and matches a lane-worker
 * command line is a worker tree from a previous server. Kill its whole
 * process group (workers spawn detached, so the group is exactly that tree).
 */

const WORKER_ARGV0 = new Set(['claude', 'codex', 'agy', 'pi', 'banana']);

export interface ProcSnapshot {
  pid: number;
  ppid: number;
  /** NUL-joined environ, used only for marker matching, never logged. */
  environ: string;
  argv: string;
  /** Cgroup path (cgroup v2 line, e.g. "0::/user.slice/.../rivendell.service"). */
  cgroup: string;
}

/** The TARDIS family marker: every spawn inherits the server environment,
 * and detached machine services (AutoSam, the LM Studio proxies, agent-one)
 * carry none of it. */
export function hasTardisEnvMarker(environ: string): boolean {
  return environ.split('\0').some(
    (entry) => entry.startsWith('ELROND_WORKSPACE_PATH=') || entry.startsWith('RIVENDELL_'),
  );
}

export function isOrphanedLaneWorker(
  proc: ProcSnapshot,
  userManagerPid: number,
  codexTurnScript: string,
): boolean {
  if (proc.pid === process.pid || proc.pid <= 1) return false;
  // Parentless: the spawning server is gone (a re-parented child lands under
  // init or the user manager). A worker of any LIVE server — production, a
  // precheck copy, another side-copy boot — keeps a live parent and is never
  // selected.
  if (proc.ppid !== 1 && proc.ppid !== userManagerPid) return false;
  if (!hasTardisEnvMarker(proc.environ)) return false;
  // A named service cgroup that is not TARDIS's own is another unit's process
  // (its main or a child). The Oct 19 dry run caught the Grok Tell-Max relay
  // here: a running user service whose environment and "mcp"-bearing argv
  // overlap ours, parentless-shaped only because a unit main's parent is the
  // user manager. Never touch another unit's processes; scope cgroups (jobs,
  // finished session scopes) stay sweepable, which is where real orphans sit.
  if (/\.service$/.test(proc.cgroup) && !proc.cgroup.endsWith('/rivendell.service')) return false;
  const argv0 = basename(proc.argv.split(' ')[0] ?? '');
  if (WORKER_ARGV0.has(argv0)) return true;
  if (proc.argv.includes(codexTurnScript)) return true;
  if (proc.argv.includes('--dangerously-skip-permissions')) return true;
  // MCP tool children whose worker already died re-parent here too; every
  // one of our MCP server command lines carries "mcp".
  return proc.argv.includes('mcp');
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
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const ppid = Number(/^PPid:\s+(\d+)/m.exec(status)?.[1] ?? 0);
    if (!ppid) return null;
    const environ = readFileSync(`/proc/${pid}/environ`, 'utf8');
    const cgroup = readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim().split('\n').pop() ?? '';
    return { pid, ppid, environ, argv, cgroup };
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

export interface ReapedWorker { pid: number; argv: string }

/** Kill every orphaned lane worker from a previous server. SIGTERM the
 * process group, then SIGKILL it after a 3s grace — the same shutdown idiom
 * the session runners use. Idempotent across concurrent boots: a second
 * sweep of a dying group hits ESRCH and moves on. */
export function sweepOrphanedLaneWorkers(
  list: () => ProcSnapshot[] = listProcSnapshots,
): { killed: ReapedWorker[] } {
  const um = userManagerPid();
  const victims = list().filter((p) => isOrphanedLaneWorker(p, um, CODEX_APP_TURN_SCRIPT));
  const killed: ReapedWorker[] = [];
  for (const victim of victims) {
    try { process.kill(-victim.pid, 'SIGTERM'); } catch { /* group gone */ }
    try { process.kill(victim.pid, 'SIGTERM'); } catch { /* gone */ }
    setTimeout(() => {
      try { process.kill(-victim.pid, 'SIGKILL'); } catch { /* gone */ }
      try { process.kill(victim.pid, 'SIGKILL'); } catch { /* gone */ }
    }, 3_000).unref();
    killed.push({ pid: victim.pid, argv: victim.argv.slice(0, 120) });
  }
  return { killed };
}

/**
 * Turn workers must stay the box's preferred OOM victims: the server unit is
 * protected (OOMScoreAdjust=-500, Max's call Oct 19 2026) so TARDIS survives
 * memory pressure, and every worker it spawns is explicitly raised back to
 * the inherited user-service score 200 so a runaway turn dies before the
 * desktop or the server does. Raising a child's score above the spawner's
 * own needs no privileges; an already-exited pid is ignored.
 */
export function markLaneWorkerKillable(pid: number | undefined): void {
  if (!pid || pid <= 1) return;
  try { writeFileSync(`/proc/${pid}/oom_score_adj`, '200'); } catch { /* exited */ }
}
