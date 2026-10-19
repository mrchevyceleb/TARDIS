import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
 *    instance token), stamped only once the token is registered in the
 *    shared runtime registry below. The marker's TOKEN is the ownership
 *    proof the sweep trusts, not just its presence: the marker is
 *    inherited by a worker's every descendant, so a live lane's disowned
 *    background child (nohup, &, xvfb-run — Wren's slack daemon, the
 *    shared Codex broker) carries it too, and only a live token separates
 *    that from a dead server's leftover. A manually launched
 *    claude/codex that merely inherits other RIVENDELL_* keys is never
 *    selected, and nothing is inferred from argv shape (script CLIs
 *    appear as node/bun/env, MCP children as anything).
 *
 *  - Reaping: at boot, before this boot spawns anything, every
 *    marker-carrying process with no living parent whose token no live
 *    server holds is a leftover from a dead server. SIGTERM it — its process group when it leads one
 *    (detached workers do), its enumerated descendants when it does not
 *    (the headless worker keeps the dead server's group) — then SIGKILL the
 *    survivors after a 3s grace, the same shutdown idiom the session
 *    runners use, revalidating each pid's start time first so a pid the
 *    kernel has reused is never signalled.
 */

const LANE_WORKER_ENV_KEY = 'RIVENDELL_LANE_WORKER';
/** This server boot's token, registered in the shared runtime registry at
 *  boot (and lazily at the first spawn). A previous boot's token is
 *  sweepable exactly once no live server holds it. */
const LANE_WORKER_INSTANCE = randomUUID();

/** Shared live-server registry (this user's runtime dir): every copy of
 *  this user — production, a precheck, any side-copy boot — registers its
 *  instance token here with its pid and kernel start time, so any sweep
 *  can tell a dead server's leftovers from a live lane's disowned
 *  background children (Sam's Oct 19 FAIL: Wren's xvfb-run slack daemon
 *  and the shared Codex app-server broker are marker-carrying, disowned,
 *  re-parented under the user manager and inside an allowed unit, so the
 *  marker alone made them look like dead-server orphans and every
 *  side-copy boot would have reaped live lanes' work mid-flight). */
export function defaultLaneInstanceDir(): string {
  const runtime = process.env.XDG_RUNTIME_DIR
    || `/run/user/${typeof process.getuid === 'function' ? process.getuid() : 0}`;
  return `${runtime}/rivendell-lane-instances`;
}

const registeredDirs = new Set<string>();
let registrationWarned = false;

/** Write this boot's token (pid + start time) into the shared registry,
 *  idempotently per dir. On a host that cannot host the registry this
 *  fails (warned once) — and laneWorkerEnv then stamps nothing, so this
 *  boot's children carry no marker and can never be selected by anyone. */
export function registerLaneInstance(dir: string = defaultLaneInstanceDir()): boolean {
  if (registeredDirs.has(dir)) return true;
  if (!existsSync('/proc')) return false; // nothing to register where nothing can be swept
  try {
    const stat = readProcStat(process.pid);
    if (!stat) return false;
    mkdirSync(dir, { recursive: true });
    // Temp + rename: no concurrent sweep ever reads a partial identity.
    const tmp = `${dir}/.tmp-${LANE_WORKER_INSTANCE}`;
    writeFileSync(tmp, `${JSON.stringify({ pid: process.pid, starttime: stat.starttime })}\n`);
    renameSync(tmp, `${dir}/${LANE_WORKER_INSTANCE}`);
    registeredDirs.add(dir);
    return true;
  } catch (err) {
    if (!registrationWarned) {
      registrationWarned = true;
      console.warn(`[worker-reap] could not register this boot's lane instance token in ${dir}: ${(err as Error).message}`);
    }
    return false;
  }
}

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
  /** Raw /proc/<pid>/cgroup text — every hierarchy line, because a hybrid
   *  box has one line per hierarchy and the systemd one is not always last. */
  cgroup: string;
}

/** The dedicated lane-worker marker stamped on every worker spawn. */
export function hasLaneWorkerMarker(environ: string): boolean {
  return environ.split('\0').some((entry) => entry.startsWith(`${LANE_WORKER_ENV_KEY}=`));
}

/** The lane-worker token a process's environment carries, or null when it
 *  carries none (or an empty one). */
export function laneWorkerTokenOf(environ: string): string | null {
  const entry = environ.split('\0').find((e) => e.startsWith(`${LANE_WORKER_ENV_KEY}=`));
  const value = entry ? entry.slice(LANE_WORKER_ENV_KEY.length + 1) : '';
  return value || null;
}

/** Tokens of every LIVE server boot in the shared registry: a file is
 *  named by its boot's token and holds that server's pid + start time; the
 *  token is live exactly while that pid still has that start time. Dead
 *  files (a crashed server, an exited precheck, a pid the kernel reused)
 *  are pruned, so the registry holds one file per live boot. An identity
 *  we cannot parse or verify FAILS SAFE: its token counts as live and its
 *  file stays, because an uncertain identity must never license a kill.
 *  Returns null when the registry itself is unreadable — then no token can
 *  be proven dead, and the caller must reap nothing. */
export function liveLaneInstanceTokens(dir: string = defaultLaneInstanceDir()): Set<string> | null {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null; // registry unreadable: nothing can be proven dead
  }
  const live = new Set<string>();
  for (const name of names) {
    if (!name || name.startsWith('.')) continue; // our temp writes, dotfiles
    try {
      const { pid, starttime } = JSON.parse(readFileSync(`${dir}/${name}`, 'utf8')) as { pid?: unknown, starttime?: unknown };
      if (typeof pid !== 'number' || typeof starttime !== 'number' || pid <= 1 || starttime <= 0) {
        live.add(name); // impossible identity: unverifiable, fail safe
        continue;
      }
      const stat = readProcStat(pid);
      if (stat && stat.starttime === starttime) live.add(name);
      else try { unlinkSync(`${dir}/${name}`); } catch { /* raced another sweep */ }
    } catch {
      live.add(name); // unreadable file: fail safe, keep it
    }
  }
  return live;
}

/** Env stamp for a lane-worker spawn (identity + nothing else). Stamped only
 *  once this boot's token is registered in the shared registry: an
 *  unregistered token is indistinguishable from a dead server's, so a
 *  host that cannot register stamps nothing and its children are never
 *  swept. */
export function laneWorkerEnv(dir: string = defaultLaneInstanceDir()): Record<string, string> {
  return registerLaneInstance(dir) ? { [LANE_WORKER_ENV_KEY]: LANE_WORKER_INSTANCE } : {};
}

/** The named .service unit one cgroup hierarchy line sits in, or null for
 *  scope/plain cgroups (jobs, session scopes, the bare user-manager
 *  cgroup). Scans from the tail so a unit's own sub-cgroups
 *  (unit/children/foo) still resolve to that unit. The user manager's root
 *  cgroup (user@1000.service) is not an app unit: a leftover migrated
 *  there is still sweepable. */
export function serviceUnitOf(cgroupLine: string): string | null {
  for (const seg of cgroupLine.trim().split('/').reverse()) {
    if (/^user@\d+\.service$/.test(seg)) continue;
    if (/\.service$/.test(seg)) return seg;
  }
  return null;
}

/** Every unit name our own cgroup text places THIS server in, across all
 *  hierarchy lines. */
function ownUnitsOf(cgroupText: string): Set<string> {
  const units = new Set<string>();
  for (const line of cgroupText.split('\n')) {
    const unit = serviceUnitOf(line);
    if (unit) units.add(unit);
  }
  return units;
}

/** True when ANY hierarchy line places the process inside a .service unit
 *  that is neither ours nor a deployed TARDIS unit. Multi-line matters:
 *  on a cgroup v1/hybrid box the systemd hierarchy can be a line other than
 *  the last, and reading only one line would classify a foreign service's
 *  process as unitless. */
function inForeignServiceUnit(cgroupText: string, ownUnits: Set<string>): boolean {
  for (const line of cgroupText.split('\n')) {
    const unit = serviceUnitOf(line);
    if (unit && !ownUnits.has(unit) && !TARDIS_UNIT_NAMES.has(unit)) return true;
  }
  return false;
}

export function isOrphanedLaneWorker(
  proc: ProcSnapshot,
  userManagerPid: number,
  ownUnits: Set<string>,
  liveTokens: ReadonlySet<string>,
): boolean {
  if (proc.pid === process.pid || proc.pid <= 1) return false;
  // Parentless: a re-parented child lands under init or the user manager.
  // A worker still ATTACHED to any live server keeps a live parent; a live
  // lane's DISOWNED background children (nohup, xvfb-run) do not — they
  // have the marker-carrying parentless shape too, and only the token's
  // liveness tells them from a dead server's leftovers.
  if (proc.ppid !== 1 && proc.ppid !== userManagerPid) return false;
  // The dedicated marker AND a token no live server holds: the marker is
  // set by spawnLaneWorker alone, but every worker's descendants inherit
  // it, so presence alone is not ownership. A live token — this boot's or
  // any other running copy's — is never selected; no token at all (an
  // unregistrable host, a manual launch) is never selected either.
  const token = laneWorkerTokenOf(proc.environ);
  if (!token || liveTokens.has(token)) return false;
  // A named .service cgroup — on ANY hierarchy line — that is neither our
  // own unit nor a deployed TARDIS unit is another unit's process. Belt and
  // suspenders on top of the marker: the Oct 19 dry run caught the Grok
  // Tell-Max relay — a running user service whose environment and
  // "mcp"-bearing argv overlap ours — and a stamp must never license
  // touching another unit. Scope cgroups (jobs, finished session scopes)
  // stay sweepable, which is where real orphans sit.
  if (inForeignServiceUnit(proc.cgroup, ownUnits)) return false;
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
    const cgroup = readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim();
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
 *  Every signal is revalidated against the start time recorded in the
 *  snapshot, so a pid the kernel reused across the real windows — the
 *  listing pass, the 3s grace — is never signalled. The residual window is
 *  the microseconds between the revalidation read and the adjacent signal,
 *  which is inherent to signal-based reaping: an absolute identity
 *  guarantee needs pidfds, which Node has no binding for (native code,
 *  card-16bc3e). Idempotent across concurrent boots: a second sweep of a
 *  dying group hits ESRCH and moves on. */
export function sweepOrphanedLaneWorkers(
  list: () => ProcSnapshot[] = listProcSnapshots,
  instanceDir: string = defaultLaneInstanceDir(),
): { killed: ReapedWorker[] } {
  if (!existsSync('/proc')) return { killed: [] }; // non-Linux host: nothing to sweep
  // This boot's own family is live before anyone is judged.
  registerLaneInstance(instanceDir);
  const liveTokens = liveLaneInstanceTokens(instanceDir);
  if (!liveTokens) {
    // Registry unreadable: no token can be proven dead, so nothing can be
    // proven sweepable. Failing safe here costs one skipped cleanup; the
    // other direction would kill live lanes' background work.
    console.warn(`[worker-reap] lane instance registry unreadable at ${instanceDir}: skipping the boot sweep`);
    return { killed: [] };
  }
  const um = userManagerPid();
  const ownUnits = ownUnitsOf(readSelfCgroup());
  const procs = list();
  const byPid = new Map(procs.map((p) => [p.pid, p] as const));
  const victims = procs.filter((p) => isOrphanedLaneWorker(p, um, ownUnits, liveTokens));
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
 *  POSIX sh, run by /bin/sh: guaranteed where /proc is, unlike bash on
 *  bash-less distributions. Linux-only: the score file lives in /proc,
 *  which the sweep already treats as optional on other hosts. */
const LANE_WORKER_WRAPPER = 'echo 200 > /proc/self/oom_score_adj 2>/dev/null; exec "$@"';

const IS_LINUX = process.platform === 'linux';

/** Would a direct spawn of this command find an executable, modeled on
 *  the child's actual environment: the caller-supplied env's PATH (empty
 *  components mean the cwd, POSIX-style; a child with no PATH cannot
 *  resolve a bare name, exactly like the legacy direct spawn), relative
 *  slash-commands resolved against the caller-supplied cwd. An unresolvable
 *  command skips the wrapper so the direct spawn keeps its legacy failure
 *  semantics (the ENOENT/EACCES 'error' event) instead of a wrapper exit
 *  126/127. */
function commandResolves(command: string, options: SpawnOptions, env: NodeJS.ProcessEnv): boolean {
  const cwd = typeof options.cwd === 'string' ? options.cwd : options.cwd ? fileURLToPath(options.cwd) : process.cwd();
  if (command.includes('/')) {
    try { accessSync(resolve(cwd, command), constants.X_OK); return true; } catch { return false; }
  }
  const path = env.PATH ?? '';
  if (!path) return false; // the child could not resolve a bare name either
  for (const dir of path.split(':')) {
    const base = dir === '' ? cwd : dir; // POSIX: an empty PATH component means the cwd
    if (!base) continue;
    try { accessSync(resolve(base, command), constants.X_OK); return true; } catch { /* keep scanning */ }
  }
  return false;
}

/**
 * Spawn a lane worker. On Linux, with a resolvable command and no
 * options.shell, the child runs through an /bin/sh wrapper that raises its
 * own OOM score before exec'ing the real CLI (argv, cwd, detached, stdio
 * and the caller's env are all preserved; exec keeps the pid, so session
 * runners and watchers keep working unchanged). Every path — wrapped or
 * direct — stamps the child's env with this boot's registered lane-worker
 * token so the boot sweep can prove ownership (and a live boot's family
 * is never swept). Non-Linux hosts, unresolvable
 * commands and shell spawns go direct, keeping their exact prior behavior
 * and error semantics. Callers pass exactly the spawn options they passed
 * before.
 */
export function spawnLaneWorker(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  const env = options.env
    ? { ...options.env, ...laneWorkerEnv() }
    : { ...process.env, ...laneWorkerEnv() };
  // options.shell keeps its caller contract: the wrapper only wraps plain
  // spawns, so a caller's own shell parsing is never nested inside ours.
  // /bin/sh (not bash): the wrapper is POSIX sh and /bin/sh is guaranteed
  // where /proc is.
  const child = IS_LINUX && !options.shell && commandResolves(command, options, env)
    ? spawn('/bin/sh', ['-c', LANE_WORKER_WRAPPER, 'lane-worker', command, ...args], { ...options, env })
    : spawn(command, args, { ...options, env });
  markLaneWorkerKillable(child.pid);
  return child;
}
