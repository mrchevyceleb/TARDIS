import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, readFileSync, readlinkSync, readdirSync, statfsSync, statSync } from 'node:fs';
import { mkdir, open, rm } from 'node:fs/promises';
import { homedir, totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { assertMemoryAvailableForSpawn } from '../chat/memory.ts';
import { JsonStore } from './jsonStore.ts';
import { STATE_DIR } from '../config.ts';

const GiB = 1024 ** 3;
export const WORKER_LIMITS = { memoryHigh: 6 * GiB, memoryMax: 8 * GiB, swapMax: 256 * 1024 ** 2, tasks: 512, cpuPercent: 200, scratch: 4 * GiB };
/** The same limits, scaled down on a small host so a per-worker cap can
 *  actually bite: an 8 GiB MemoryMax proves nothing on a 16 GiB box. */
const HOST_LIMITS = {
  memoryHigh: Math.min(WORKER_LIMITS.memoryHigh, Math.floor(totalmem() * 0.25)),
  memoryMax: Math.min(WORKER_LIMITS.memoryMax, Math.floor(totalmem() * 0.33)),
};
const SLICE = 'tardis-workers.slice';
const OWNED_UNIT = /^tardis-(?:worker|job|watch)-[a-f0-9-]+(?:\.(?:scope|service))?$/;
/** New launches store their full service name; bare persisted names are legacy scopes. */
export function containedUnitName(unit: string): string {
  if (!OWNED_UNIT.test(unit)) throw new Error('Invalid worker unit identity.');
  return /\.(?:scope|service)$/.test(unit) ? unit : `${unit}.scope`;
}
export type ResourceIncident = { id: string; at: number; owner: string; message: string; unit?: string; kind?: 'hold' };
export class ResourceHoldError extends Error {
  readonly code = 'RESOURCE_PRESSURE';
  constructor(reason: string) { super(`TARDIS safety hold: ${reason}`); this.name = 'ResourceHoldError'; }
}
export const MEMORY_FAILURE_NOTICE = 'This worker was stopped by an out-of-memory event. Its private scratch and child processes were released. Other work has its own limits. Work saved in the workspace remains available.';
const incidents = new JsonStore<ResourceIncident>('resource-incidents.json', []);
type OwnedConfig = { id: string; pid: number; start: string; namespace: string; bootId: string };
const ownedConfigs = new JsonStore<OwnedConfig>('worker-configs.json', []);
const CONFIG_DIR = join(STATE_DIR, 'worker-configs');
let recent: ResourceIncident[] = [];
let ready = false;
let readiness = 'Host containment has not been checked.';
const watchedScopes = new Map<string, { owner: string; cwd: string; written: number | null; missingAt: number; alertedAt: number }>();
const containedChildren = new WeakMap<ChildProcess, { unit: string; expectedExit: boolean }>();
const scopeIdentities = new Map<string, { unit: string; expectedExit: boolean }>();
const accountingFaults = new Set<string>();
// Exit listeners can run before systemctl's callback. Readers must wait for
// the stop result instead of permanently saving an unexplained SIGKILL wake.
const pendingStorageStops = new Map<string, Promise<string | undefined>>();
const startingScopes = new Map<string, number>();
/** Names currently set in the user manager's own environment. A transient
 *  unit starts from THAT environment plus what the launch sets, so any
 *  manager-env name the caller did not pass must be unset explicitly, or a
 *  secret the runners deliberately removed comes straight back in. */
let managerEnvNames = new Set<string>();
/** Env names dropped for values systemd cannot carry (control characters,
 *  invalid UTF-8): one warning each, never a per-launch refusal. */
const warnedEnvNames = new Set<string>();
/** Slice memory no live worker accounts for (tmpfs pages reparent to the
 *  slice when a worker exits without freeing /dev/shm or /tmp files).
 *  Refreshed by the accounting audit; a hold reason once it grows. */
let orphanSliceMemory = 0;
let aggregateTaskLimit = 4096;
let monitor: ReturnType<typeof setInterval> | undefined;
let retryInitialization: ReturnType<typeof setTimeout> | undefined;
let monitoring = false;
let monitorTicks = 0;
let userCgroup = '';

/** Opt-in on hosts with systemd + bubblewrap. Required mode NEVER falls back
 * to an uncontained process. Off mode is explicitly reported as unprotected. */
export function resourceGuardRequired(): boolean {
  // A typo must not disable protection on a host that requested it.
  return !!process.env.RIVENDELL_RESOURCE_GUARD && process.env.RIVENDELL_RESOURCE_GUARD !== 'off';
}

function commandOutput(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 5000, maxBuffer: 32 * 1024, encoding: 'utf8' }, (err, stdout) => err ? reject(new Error(`${command} containment check failed`)) : resolve(stdout.trim()));
  });
}

function sandboxArgs(durable = false): string[] {
  // Host PID/IPC identities and /dev/shm are part of the teammate contract.
  // A PID namespace makes sd-bus reject clients even with the correct UID.
  // systemd now owns descendant cleanup; only TMPDIR is private/disposable.
  // The user's systemd config is the manager's to own: a worker can read it
  // but never install or edit units from inside a sandbox.
  const unitConfig = join(homedir(), '.config/systemd');
  return ['--unshare-user', ...(!durable ? ['--die-with-parent'] : []), '--cap-drop', 'ALL',
    '--bind', '/', '/', '--dev-bind', '/dev', '/dev', '--proc', '/proc', '--size', String(WORKER_LIMITS.scratch), '--tmpfs', '/tmp/tardis-private',
    '--ro-bind', '/sys/fs/cgroup', '/sys/fs/cgroup', '--ro-bind-try', unitConfig, unitConfig,
    '--setenv', 'TMPDIR', '/tmp/tardis-private', '--setenv', 'TMP', '/tmp/tardis-private', '--setenv', 'TEMP', '/tmp/tardis-private'];
}

export async function initializeResourceGuard(): Promise<void> {
  if (retryInitialization) clearTimeout(retryInitialization);
  retryInitialization = undefined;
  ready = false;
  accountingFaults.clear();
  if (!resourceGuardRequired()) { readiness = 'Containment is off. Set RIVENDELL_RESOURCE_GUARD=required after installing the host policy.'; return; }
  try {
    if (process.platform !== 'linux') throw new Error('Required containment needs Linux cgroup v2.');
    if (process.env.RIVENDELL_RESOURCE_GUARD !== 'required') throw new Error('RIVENDELL_RESOURCE_GUARD must be required or off.');
    if (!readFileSync('/sys/fs/cgroup/cgroup.controllers', 'utf8').includes('memory')) throw new Error('Required containment needs the cgroup v2 memory controller.');
    const membership = readFileSync('/proc/self/cgroup', 'utf8').match(/^0::(.*\/user@\d+\.service)(?:\/|$)/m)?.[1];
    if (!membership) throw new Error('The user-manager cgroup could not be located; containment cannot be verified.');
    userCgroup = `/sys/fs/cgroup${membership}`;
    const delegated = readFileSync(`${userCgroup}/cgroup.controllers`, 'utf8').split(/\s+/);
    if (!['cpu', 'memory', 'pids', 'io'].every((controller) => delegated.includes(controller))) {
      throw new Error('Delegate cpu, memory, pids and io to the user manager; see docs/RESOURCE-GUARD.md.');
    }
    const properties = await commandOutput('systemctl', ['--user', 'show', SLICE, '-p', 'LoadState', '-p', 'MemoryHigh', '-p', 'MemoryMax', '-p', 'MemorySwapMax', '-p', 'TasksMax', '-p', 'CPUQuotaPerSecUSec']);
    const values: Record<string, string> = Object.fromEntries(properties.split('\n').map((line) => line.split('=')));
    // Slice caps must be able to bite on THIS host: a 32 GiB MemoryMax on a
    // 16 GiB box is no cap at all, so the ceiling scales with real memory.
    const bounded = (key: string, ceiling: number) => Number(values[key]) > 0 && Number(values[key]) <= ceiling;
    const quota = values.CPUQuotaPerSecUSec?.match(/^([\d.]+)(us|ms|s)$/);
    const units: Record<string, number> = { us: 1, ms: 1000, s: 1_000_000 };
    const quotaMicros = quota ? Number(quota[1]) * (units[quota[2]] ?? Infinity) : Infinity;
    // A slice-level memory.oom.group can only ever read 0 (systemd never sets
    // it on slices); the check that matters is per-scope and runs below, on
    // the real launch path.
    if (values.LoadState !== 'loaded' || !bounded('MemoryHigh', Math.min(28 * GiB, Math.floor(totalmem() * 0.9)))
      || !bounded('MemoryMax', Math.min(32 * GiB, Math.floor(totalmem() * 1.25)))
      || !Number.isFinite(Number(values.MemorySwapMax)) || Number(values.MemorySwapMax) > GiB
      || !bounded('TasksMax', 4096) || !(quotaMicros > 0 && quotaMicros <= 12_000_000)) {
      throw new Error('Install the bounded tardis-workers.slice policy from docs/RESOURCE-GUARD.md.');
    }
    aggregateTaskLimit = Number(values.TasksMax);
    // Real capability check on the REAL launch path. A bare bwrap probe proves
    // nothing about what every worker actually runs, and a refused
    // `systemd-run` (unsupported property, manager trouble) used to leave
    // readiness green while every launch died silently. Run a transient scope
    // in both shapes (a lane turn and a job/watch) and have the probe read its
    // own kernel limits from inside the scope — including memory.oom.group=1,
    // which OOMPolicy=kill sets, so one worker's OOM kill takes its whole
    // cgroup and never sacrifices another lane.
    // Prove environment exactness on the real launch path: a name planted in
    // the MANAGER's environment (where imports and desktop sessions put
    // things) must not reach a worker that did not pass it. The probe's own
    // env also carries one value systemd cannot carry, which must be dropped
    // without refusing the launch.
    // Plant the canary BEFORE snapshotting the manager env: the snapshot is
    // what the unset list is computed from, so a canary planted after it
    // never gets unset and the probe fails its own exactness check.
    await commandOutput('systemctl', ['--user', 'set-environment', 'TARDIS_PROBE_MANAGER_CANARY=yes']).catch(() => '');
    await refreshManagerEnv();
    try {
      await probeContainedLaunch(false);
      await probeContainedLaunch(true);
    } finally {
      await commandOutput('systemctl', ['--user', 'unset-environment', 'TARDIS_PROBE_MANAGER_CANARY']).catch(() => '');
    }
    recent = (await incidents.list()).slice(0, 50);
    await reapOwnedConfigs();
    ready = true;
    if (!monitor) {
      let ticks = 0;
      monitor = setInterval(() => {
        void monitorWrites();
        // The manager-env snapshot drives every launch's unset list. Without
        // a refresh, a name the manager gains later (an import, a new login
        // session) would reach workers whose caller never passed it, forever.
        // Refresh on a slow tick: bounded drift, no per-launch spawn cost.
        if (++ticks % 15 === 0) void refreshManagerEnv();
      }, 2000);
      monitor.unref();
    }
    readiness = 'Each worker has kernel memory, swap, CPU and process limits, private scratch that disappears on exit, and a read-only systemd unit directory. Host PIDs, the user bus and /dev/shm stay shared by design; a buggy same-UID process can still signal peers, which the guard bounds but cannot prevent.';
  } catch (err) {
    readiness = (err as Error).message;
    console.warn(`[resource-guard] Work is held: ${readiness}`);
    retryInitialization = setTimeout(() => { void initializeResourceGuard(); }, 30_000);
    retryInitialization.unref();
  }
}

function configOwnerStart(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const start = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
    return /^\d+$/.test(start ?? '') ? start : null;
  } catch (err) { return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'gone' : null; }
}

/** Manifest first, contents second: a crash at any point leaves an owned
 * receipt. Boot cleanup checks PID + kernel start time, never names or age. */
export async function createOwnedWorkerConfig(contents: string): Promise<{ id: string; path: string }> {
  const start = configOwnerStart(process.pid);
  if (!start || start === 'gone') throw new Error('Cannot establish ownership of a worker config.');
  const id = randomUUID();
  const path = join(CONFIG_DIR, `${id}.json`);
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await ownedConfigs.create({ id, pid: process.pid, start, namespace: readlinkSync('/proc/self/ns/pid'), bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() });
  let handle;
  try { handle = await open(path, 'wx', 0o600); }
  catch (err) { await ownedConfigs.delete(id); throw err; }
  try { await handle.writeFile(contents, 'utf8'); await handle.sync(); }
  catch (err) {
    await handle.close();
    await releaseOwnedWorkerConfig(id);
    throw err;
  }
  await handle.close();
  return { id, path };
}

export async function releaseOwnedWorkerConfig(id: string): Promise<void> {
  if (!/^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(id)) throw new Error('Invalid worker config identity.');
  if (!(await ownedConfigs.list()).some((record) => record.id === id)) return;
  await rm(join(CONFIG_DIR, `${id}.json`), { force: true });
  await ownedConfigs.delete(id);
}

async function reapOwnedConfigs(): Promise<void> {
  const namespace = readlinkSync('/proc/self/ns/pid');
  const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  for (const record of await ownedConfigs.list()) {
    if (!Number.isSafeInteger(record.pid) || record.pid < 1 || typeof record.start !== 'string' || !/^\d+$/.test(record.start)) continue;
    if (typeof record.namespace !== 'string' || !record.namespace || typeof record.bootId !== 'string' || !record.bootId) continue;
    if (record.bootId !== bootId) { await releaseOwnedWorkerConfig(record.id); continue; }
    if (record.namespace !== namespace) continue; // another live server may have a different PID namespace
    const current = configOwnerStart(record.pid);
    if (current !== null && current !== record.start) await releaseOwnedWorkerConfig(record.id);
  }
}

/** Re-adopt durable job scopes after a server restart. Only UUID scopes from
 * our own job records qualify; never enumerate another application's units. */
export function watchContainedScope(unit: string, owner: string, cwd: string): void {
  if (!ready || !OWNED_UNIT.test(unit) || watchedScopes.has(unit)) return;
  watchedScopes.set(unit, { owner, cwd, written: null, missingAt: Date.now(), alertedAt: 0 });
}

export function unwatchContainedScope(unit: string): void { watchedScopes.delete(unit); accountingFaults.delete(unit); }
export function expectContainedScopeExit(unit: string): void {
  const identity = scopeIdentities.get(unit);
  if (identity) identity.expectedExit = true;
}

async function monitorWrites(): Promise<void> {
  if (monitoring) return;
  monitoring = true;
  monitorTicks += 1;
  if (monitorTicks % 15 === 0) {
    await refreshManagerEnv().catch(() => { /* keep the last known names */ });
    await auditSliceOrphans().catch(() => { /* accounting is best-effort */ });
  }
  try {
    // Bounded probes, no recursive filesystem walks or /proc-wide scans.
    for (const [unit, entry] of [...watchedScopes].slice(0, 256)) {
      let io: string;
      try { io = readFileSync(`${userCgroup}/tardis.slice/${SLICE}/${containedUnitName(unit)}/io.stat`, 'utf8'); }
      catch {
        // A completed scope can disappear before the coarse jobs tick records
        // its result. That is normal cleanup, not loss of controller support.
        if (!existsSync(`${userCgroup}/tardis.slice/${SLICE}/${containedUnitName(unit)}`)) {
          // A unit that is still activating or active owns this entry even
          // though its cgroup directory has not (re)appeared: keep watching
          // instead of dropping a slow-starting lane's disk monitoring.
          const state = await unitActiveState(unit);
          if (state === 'active' || state === 'activating' || state === 'reloading') { entry.missingAt = Date.now(); continue; }
          if (Date.now() - entry.missingAt > 10_000) unwatchContainedScope(unit);
          continue;
        }
        if (Date.now() - entry.missingAt > 10_000 && Date.now() - entry.alertedAt > 60_000) {
          entry.alertedAt = Date.now();
          // This is a hold reason (new work is refused while readings are
          // unavailable), so it carries the hold kind: the Desk keeps it, and
          // the toast path stays quiet instead of re-announcing it every minute.
          recordResourceIncident(entry.owner, 'Worker disk accounting is unavailable. TARDIS is holding new work until the host policy is checked.', { kind: 'hold' });
          accountingFaults.add(unit);
        }
        continue;
      }
      accountingFaults.delete(unit); // a transient accounting outage can heal
      entry.missingAt = Date.now();
      // The unit is registered: its real pids.current now counts inside the
      // slice, so the 60s start reservation stops double-holding the budget.
      startingScopes.delete(unit);
      const written = [...io.matchAll(/\bwbytes=(\d+)/g)].reduce((sum, match) => sum + Number(match[1]), 0);
      let lowDisk = false;
      let criticalDisk = false;
      try {
        for (const path of [process.cwd(), entry.cwd]) {
          lowDisk ||= storageLow(path);
          const fs = statfsSync(path);
          criticalDisk ||= fs.bavail * fs.bsize < (fs.type === 0x01021994 ? 128 * 1024 ** 2 : 8 * GiB);
        }
      } catch { /* admission already checks paths; an unavailable path proves no write */ }
      const durable = unit.startsWith('tardis-job-') || unit.startsWith('tardis-watch-');
      const delta = entry.written === null ? 0 : written - entry.written;
      const reason = durable && written > 16 * GiB ? 'exceeded its 16 GiB disk-write budget'
        : criticalDisk && delta > 0 ? 'was writing while storage was critically low'
        : lowDisk && delta > 0 && (durable || delta > 256 * 1024 ** 2) ? 'was still writing while storage reserve was low' : null;
      entry.written = written;
      if (!reason) continue;
      watchedScopes.delete(unit);
      // An emergency writer is stopped by its OWN cgroup, never by name or
      // another worker's PID. Private scratch vanishes with its namespace.
      const stopping = (async (): Promise<string | undefined> => {
        try {
          expectContainedScopeExit(unit);
          await commandOutput('systemctl', ['--user', 'kill', '--signal=SIGKILL', containedUnitName(unit)]);
          const message = `TARDIS stopped this worker because it ${reason}. Work saved in the workspace remains available; this job did not finish.`;
          recordResourceIncident(entry.owner, message, { unit });
          return message;
        } catch {
          const identity = scopeIdentities.get(unit);
          if (identity) identity.expectedExit = false;
          // A scope that is already gone finished between the accounting read
          // and the kill. That is a completed job, not a host that cannot stop
          // a worker; only a scope that is still there is an alarm.
          if (!existsSync(`${userCgroup}/tardis.slice/${SLICE}/${containedUnitName(unit)}`)) { unwatchContainedScope(unit); return undefined; }
          watchedScopes.set(unit, entry);
          if (Date.now() - entry.alertedAt > 60_000) {
            entry.alertedAt = Date.now();
            recordResourceIncident(entry.owner, 'TARDIS could not stop a worker that breached storage protection. The host needs attention.');
          }
          return undefined;
        }
      })();
      pendingStorageStops.set(unit, stopping);
      await stopping;
      pendingStorageStops.delete(unit);
    }
  } finally { monitoring = false; }
}

function storageLow(path: string): boolean {
  const fs = statfsSync(path);
  // A temporary working directory on a small tmpfs is bounded by memory,
  // not the workstation's 32 GiB disk reserve.
  const reserve = fs.type === 0x01021994 ? 256 * 1024 ** 2 : 32 * GiB;
  return fs.bavail * fs.bsize < reserve || (fs.files > 0 && fs.ffree / fs.files < 0.01);
}

/** Snapshot the user manager's environment NAMES. Workers are transient
 *  units: they start from this environment plus what the launch passes, so
 *  the launch must explicitly unset every manager name the caller removed.
 *  The monitor refreshes this every 30s, so a name the manager gains later
 *  can leak into at most ~30s of launches, never forever. */
async function refreshManagerEnv(): Promise<void> {
  const out = await commandOutput('systemctl', ['--user', 'show-environment']);
  managerEnvNames = new Set(out.split('\n').filter(Boolean).map((line) => line.split('=')[0])
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)));
}

/** A value systemd can carry over D-Bus into a unit environment: printable
 *  text (tab and newline included), no other control characters. */
function envValueCarriable(value: unknown): boolean {
  return typeof value === 'string' && !/[\x00-\x08\x0b-\x1f\x7f]/.test(value);
}

/** Slice memory no live worker accounts for: tmpfs pages (/dev/shm, a
 *  tmpfs /tmp) reparent to the slice when their writer exits without
 *  freeing them, and io.stat cannot see tmpfs writes at all. Name the
 *  biggest shared-memory entries so the leak is actionable, not mysterious. */
async function auditSliceOrphans(): Promise<void> {
  const sliceDir = `${userCgroup}/tardis.slice/${SLICE}`;
  const readMem = (p: string): number => { try { return Number(readFileSync(p, 'utf8')); } catch { return NaN; } };
  const total = readMem(`${sliceDir}/memory.current`);
  if (!Number.isFinite(total)) { orphanSliceMemory = 0; return; }
  let accounted = 0;
  for (const entry of readdirSync(sliceDir)) {
    if (!/^tardis-(?:worker|job|watch)-/.test(entry)) continue;
    const used = readMem(`${sliceDir}/${entry}/memory.current`);
    if (Number.isFinite(used)) accounted += used;
  }
  orphanSliceMemory = Math.max(0, total - accounted);
  if (orphanSliceMemory < 2 * GiB) return;
  const entries: [string, number][] = [];
  try {
    for (const name of readdirSync('/dev/shm')) {
      try { entries.push([name, statSync(join('/dev/shm', name)).size]); } catch { /* raced */ }
    }
  } catch { /* unreadable /dev/shm: the number still stands */ }
  const biggest = entries.sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([name, size]) => `${name} (${(size / 1024 / 1024).toFixed(0)} MB)`).join(', ');
  recordResourceIncident('TARDIS', `The shared worker budget holds ${(orphanSliceMemory / GiB).toFixed(1)} GiB that no live worker accounts for, probably files a finished worker left in /dev/shm or /tmp. New machine work is held until they are cleared.${biggest ? ` Largest /dev/shm entries: ${biggest}.` : ''}`, { kind: 'hold' });
}

/** The unit's real state per the manager, or 'unknown' when the manager
 *  cannot answer. Callers treat unknown as alive, never as evidence of
 *  death: a wedged manager must not get a running worker reaped. */
export async function unitActiveState(unit: string): Promise<'active' | 'activating' | 'reloading' | 'deactivating' | 'inactive' | 'failed' | 'unknown'> {
  if (!OWNED_UNIT.test(unit)) return 'unknown';
  const out = await commandOutput('systemctl', ['--user', 'show', containedUnitName(unit), '-p', 'ActiveState', '-p', 'LoadState']).catch(() => '');
  const values = Object.fromEntries(out.split('\n').map((line) => line.split('=')));
  if (!out || values.LoadState === 'not-found') return values.LoadState === 'not-found' ? 'inactive' : 'unknown';
  const state = values.ActiveState;
  if (state === 'active' || state === 'activating' || state === 'reloading' || state === 'deactivating' || state === 'inactive' || state === 'failed') return state;
  return 'unknown';
}

export function recordResourceIncident(owner: string, message: string, detail: Pick<ResourceIncident, 'unit' | 'kind'> = {}): void {
  if (recent.some((item) => item.owner === owner && item.message === message && item.unit === detail.unit && Date.now() - item.at < 60_000)) return;
  const incident = { id: randomUUID(), at: Date.now(), owner, message, ...detail };
  recent = [incident, ...recent].slice(0, 50);
  void incidents.modify((items) => [incident, ...items].slice(0, 100)).catch(() => console.warn('[resource-guard] Could not save an incident; see the service journal.'));
  console.warn(`[resource-guard] ${owner}: ${message}`);
}

export async function scopeStorageFailure(unit: string): Promise<string | undefined> {
  const stopping = pendingStorageStops.get(unit);
  if (stopping) return stopping;
  const current = recent.find((item) => item.unit === unit);
  return current?.message ?? (await incidents.list()).find((item) => item.unit === unit)?.message;
}

export function resourcePressure(): string | null {
  try {
    // Absolute reserve works on a nearly-full multi-TB disk without treating
    // 100 GB of remaining space as already unusable. Inodes matter too.
    if (storageLow(process.cwd())) return 'Workspace storage is low; TARDIS held new work to preserve space for the server and your files.';
    if (process.platform === 'linux') {
      const memory = readFileSync('/proc/meminfo', 'utf8');
      const available = Number(memory.match(/^MemAvailable:\s+(\d+)/m)?.[1]) * 1024;
      if (available < Math.max(2 * GiB, totalmem() * 0.10)) return 'Memory is tight; TARDIS held new work to keep the machine responsive.';
      for (const kind of ['memory', 'io']) {
        const psi = readFileSync(`/proc/pressure/${kind}`, 'utf8');
        if (Number(psi.match(/^full avg10=([\d.]+)/m)?.[1]) >= 10) return `The machine is waiting heavily on ${kind === 'memory' ? 'memory' : 'storage'}; TARDIS held new work until it settles.`;
      }
      const slice = `${userCgroup}/tardis.slice/${SLICE}`;
      let taskMax = aggregateTaskLimit;
      let tasks = 0;
      try {
        const max = Number(readFileSync(`${slice}/memory.max`, 'utf8').trim());
        const used = Number(readFileSync(`${slice}/memory.current`, 'utf8').trim());
        if (!Number.isFinite(max) || !Number.isFinite(used) || max - used < GiB) return 'The shared worker budget is full; TARDIS held new work until another job releases memory.';
        if (orphanSliceMemory >= 2 * GiB) return 'The shared worker budget holds leftover files from finished workers; TARDIS held new work until /dev/shm and /tmp are cleared.';
        taskMax = Number(readFileSync(`${slice}/pids.max`, 'utf8').trim());
        tasks = Number(readFileSync(`${slice}/pids.current`, 'utf8').trim());
      } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || existsSync(slice)) throw err; } // slice may not have started yet
      let reserved = 0;
      for (const [unit, until] of startingScopes) {
        if (until <= Date.now()) { startingScopes.delete(unit); continue; }
        let counted = 0;
        try { counted = Number(readFileSync(`${slice}/${containedUnitName(unit)}/pids.current`, 'utf8').trim()); } catch { /* registration in flight */ }
        reserved += Math.max(0, WORKER_LIMITS.tasks - (Number.isFinite(counted) ? counted : 0));
      }
      if (!Number.isFinite(taskMax) || !Number.isFinite(tasks) || taskMax - tasks - reserved < WORKER_LIMITS.tasks) return 'The shared worker process budget is full; TARDIS held new work until another job releases its threads.';
    }
  } catch { return 'Resource readings are unavailable; TARDIS held new work rather than guessing.'; }
  return null;
}

export function assertResourcesForSpawn(owner: string, cwd?: string, opts: { conversationTurn?: boolean } = {}): void {
  // A hold is a valve on new load, never a mute button on a person. A turn in
  // a conversation always runs while containment itself is verified: it is one
  // worker under its own kernel caps and the shared slice budget, and the
  // office freezing is worse than the load it adds. Pressure is logged here
  // instead of blocking the person; new machine work (jobs, command watches)
  // still holds. When containment is NOT verified the normal path below runs,
  // because required mode never launches anything uncontained.
  if (opts.conversationTurn && resourceGuardRequired() && ready) {
    const reason = accountingFaults.size ? 'Worker disk accounting is unavailable; TARDIS is holding new work until readings recover.' : resourcePressure();
    if (reason) console.warn(`[resource-guard] Admitted a conversation turn while holding new work: ${reason}`);
    return;
  }
  assertMemoryAvailableForSpawn(owner);
  if (!resourceGuardRequired()) return;
  let reason = accountingFaults.size ? 'Worker disk accounting is unavailable; TARDIS is holding new work until readings recover.' : ready ? resourcePressure() : readiness;
  if (!reason && cwd) {
    try {
      if (storageLow(cwd)) reason = 'This job’s working disk is low on space; TARDIS held the launch.';
    } catch { reason = 'The job’s working disk could not be checked; TARDIS held the launch.'; }
  }
  if (reason) {
    // Coalesce repeated scheduler retries, rather than filling the incident log.
    if (!recent.some((item) => item.owner === owner && item.message === reason && Date.now() - item.at < 60_000)) recordResourceIncident(owner, reason, { kind: 'hold' });
    throw new ResourceHoldError(reason);
  }
}

export function resourceGuardStatus() {
  return { mode: resourceGuardRequired() ? 'required' : 'off', ready: ready && accountingFaults.size === 0, message: accountingFaults.size ? 'Worker disk accounting is unavailable. New work resumes when readings recover.' : readiness,
    pressure: resourceGuardRequired() ? resourcePressure() : null, limits: WORKER_LIMITS, incidents: recent };
}

/** The manager owns the whole worker tree, including detached descendants.
 * A transient service can reap them when its main command exits without a
 * PID namespace, so host bus credentials and cross-lane handoffs keep working. */
function containedLaunchArgs(unit: string, command: string, args: readonly string[], durable: boolean, runtimeSeconds?: number, options: SpawnOptions = {}, memoryCeiling?: { high: number; max: number }): string[] {
  const environment = options.env ?? process.env;
  const envNames = Object.keys(environment).filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key));
  // A value systemd cannot carry (control characters) would make the manager
  // refuse the ENTIRE launch. Drop the name, warn once, never fail the worker.
  const carried = envNames.filter((key) => {
    const value = environment[key];
    if (value === undefined) return false; // effectively absent: unset below if the manager holds it
    if (envValueCarriable(value)) return true;
    if (!warnedEnvNames.has(key)) {
      warnedEnvNames.add(key);
      console.warn(`[resource-guard] Dropped environment name ${key}: its value cannot be passed to a contained worker.`);
    }
    return false;
  });
  const carriedSet = new Set(carried);
  // EXACT environment: a transient unit starts from the user manager's
  // environment plus what this launch sets, so every manager-env name the
  // caller did not pass (or had removed, like the runners' secret scrub) is
  // unset here. Without this, a secret deleted from a runner's env comes
  // straight back into the worker through the manager.
  const unsetNames = [...managerEnvNames].filter((name) => !carriedSet.has(name));
  const limits = memoryCeiling ?? { high: HOST_LIMITS.memoryHigh, max: HOST_LIMITS.memoryMax };
  const cwd = options.cwd instanceof URL ? fileURLToPath(options.cwd) : options.cwd ?? process.cwd();
  // A lane cannot outlive the service/job that owns its server. Durable jobs
  // deliberately omit this dependency and survive a TARDIS restart. A dev or
  // precheck server may itself run in a scope: bind to that scope the same way.
  const parentUnit = !durable ? readFileSync('/proc/self/cgroup', 'utf8').trim().split('/').reverse()
    .find((part) => /\.(?:service|scope)$/.test(part) && !/^user@\d+\.service$/.test(part)) : undefined;
  return ['--user', '--pipe', '--wait', '--quiet', '--collect', '--service-type=exec', '--expand-environment=no',
    `--slice=${SLICE}`, `--unit=${unit}`, `--working-directory=${cwd}`,
    // A clean description: without one, systemd-run uses the whole command
    // line (prompts and all) as the unit description, and the journal prints
    // it on every unit start.
    `--description=TARDIS contained ${durable ? 'job' : 'lane'} worker ${unit}`,
    // Names only: systemd-run reads values from its inherited environment and
    // passes them over D-Bus. Secrets never enter argv or unit descriptions.
    ...carried.map((key) => `--setenv=${key}`),
    ...unsetNames.flatMap((name) => ['-p', `UnsetEnvironment=${name}`]),
    '-p', `MemoryHigh=${limits.high}`, '-p', `MemoryMax=${limits.max}`,
    '-p', `MemorySwapMax=${WORKER_LIMITS.swapMax}`, '-p', `TasksMax=${WORKER_LIMITS.tasks}`,
    '-p', 'IOAccounting=yes', '-p', `CPUQuota=${WORKER_LIMITS.cpuPercent}%`, '-p', 'OOMPolicy=kill',
    '-p', 'KillMode=control-group', '-p', 'TimeoutStopSec=3s', '-p', 'TimeoutStartSec=60s', '-p', 'LimitFSIZE=infinity',
    ...(parentUnit ? ['-p', `BindsTo=${parentUnit}`] : []),
    ...(runtimeSeconds ? ['-p', `RuntimeMaxSec=${runtimeSeconds}`] : []),
    '/usr/bin/bwrap', ...sandboxArgs(durable), '--', '/usr/bin/prlimit', '--core=0:0', '--', command, ...args];
}

const PROBE_SCRIPT = `set -e
cg=$(sed -n 's/^0:://p' /proc/self/cgroup)
[ -n "$cg" ]
case "$cg" in *tardis-workers.slice*) ;; *) exit 1 ;; esac
[ "$(cat /sys/fs/cgroup$cg/memory.max)" = "${HOST_LIMITS.memoryMax}" ]
[ "$(cat /sys/fs/cgroup$cg/memory.high)" = "${HOST_LIMITS.memoryHigh}" ]
[ "$(cat /sys/fs/cgroup$cg/memory.swap.max)" = "${WORKER_LIMITS.swapMax}" ]
[ "$(cat /sys/fs/cgroup$cg/pids.max)" = "${WORKER_LIMITS.tasks}" ]
[ "$(cat /sys/fs/cgroup$cg/cpu.max)" = "200000 100000" ]
[ "$(cat /sys/fs/cgroup$cg/memory.oom.group)" = "1" ]
[ -e /sys/fs/cgroup$cg/io.stat ]
[ -d /tmp/tardis-private ]
touch "$TMPDIR/tardis-probe" && rm -f "$TMPDIR/tardis-probe"
[ -d /dev/shm ] && touch "/dev/shm/tardis-probe-$$" && rm -f "/dev/shm/tardis-probe-$$"
[ "$(ulimit -f)" = "unlimited" ]
systemctl --user show tardis-workers.slice -p LoadState --value >/dev/null
# Exact environment: the value the caller passed arrives; the uncarriable
# value and the manager-planted canary do not.
[ "\${TARDIS_PROBE_PASSED:-}" = "ok" ]
[ -z "\${TARDIS_PROBE_INVALID:-}" ]
[ -z "\${TARDIS_PROBE_MANAGER_CANARY:-}" ]
test -c /dev/null && : >/dev/null && dd if=/dev/urandom of=/dev/null bs=1 count=1 status=none`;

/** Run one real contained launch — the same argv every worker uses — and fail
 * with a readable reason when systemd refuses it or the kernel limits are not
 * in force. `durable` picks the job/watch shape. */
async function probeContainedLaunch(durable: boolean): Promise<void> {
  const unit = `tardis-${durable ? 'job' : 'worker'}-${randomUUID()}.service`;
  // The probe runs the real argv with a REPRESENTATIVE runner environment:
  // one carriable value, one value systemd cannot carry, and (planted by the
  // initializer) one manager-env canary the caller never passed.
  const probeEnv = { ...process.env, TARDIS_PROBE_PASSED: 'ok', TARDIS_PROBE_INVALID: 'not\x1bcarriable' } as NodeJS.ProcessEnv;
  await new Promise<void>((resolve, reject) => {
    execFile('systemd-run', containedLaunchArgs(unit, '/bin/sh', ['-c', PROBE_SCRIPT], durable, durable ? 60 : undefined, { env: probeEnv }), { timeout: 30_000, env: probeEnv }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`The real contained launch failed in its ${durable ? 'job' : 'lane'} shape: ${String(stderr || err.message).trim().slice(0, 300)}${'code' in err ? ` (exit ${err.code})` : ''}`));
      else resolve();
    });
  });
}

/** All agent execution surfaces share this path, including background jobs,
 * watch commands and content generation. Arguments never include secrets. */
export function spawnContained(command: string, args: readonly string[], options: SpawnOptions, owner: string, unit = `tardis-worker-${randomUUID()}`, runtimeSeconds?: number, durable = false, admission: { conversationTurn?: boolean } = {}): ChildProcess {
  // Person-initiated turns are the ONLY launches admitted while pressure
  // holds (an automation wake is machine work and waits its turn like any
  // job). The person path opts in explicitly; nothing is inferred from shape.
  assertResourcesForSpawn(owner, typeof options.cwd === 'string' ? options.cwd : undefined, { conversationTurn: admission.conversationTurn === true });
  if (!resourceGuardRequired()) return spawn(command, args, options);
  if (options.shell) throw new Error('Contained launches require an explicit shell command.');
  if (!OWNED_UNIT.test(unit)) throw new Error('Invalid worker scope identity.');
  unit = unit.endsWith('.service') ? unit : `${unit}.service`;
  if (!OWNED_UNIT.test(unit)) throw new Error('Invalid worker service identity.');
  // A person's turn is never muted, but it must not evict a healthy sibling
  // either: when the slice cannot fit a full worker, this one runs with a
  // memory cap sized to what is actually left (floor 1 GiB) instead of
  // pushing the slice into an OOM that kills the largest resident worker.
  let memoryCeiling: { high: number; max: number } | undefined;
  if (admission.conversationTurn === true) {
    const headroom = sliceMemoryHeadroom();
    if (headroom !== null && headroom < HOST_LIMITS.memoryHigh) {
      const max = Math.max(GiB, Math.floor(headroom * 0.95));
      memoryCeiling = { high: Math.floor(max * 0.75), max };
      console.warn(`[resource-guard] Admitted a conversation turn with a reduced memory cap (${(max / GiB).toFixed(1)} GiB) to protect running workers.`);
    }
  }
  const child = spawn('systemd-run', containedLaunchArgs(unit, command, args, durable, runtimeSeconds, options, memoryCeiling), options);
  const identity = { unit, expectedExit: false };
  startingScopes.set(unit, Date.now() + 60_000);
  containedChildren.set(child, identity);
  scopeIdentities.set(unit, identity);
  // Scope registration is asynchronous. Wait for the first sample rather
  // than mistaking a not-yet-created cgroup for a completed job.
  const arm = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      watchContainedScope(unit, owner, typeof options.cwd === 'string' ? options.cwd : process.cwd());
    }
  }, 1000);
  arm.unref();
  // The manager bounds startup. Never kill a launcher merely because a
  // sampled cgroup has not appeared: resume bursts can take longer than 10s.
  // No process-name matching, pid reuse races or broad cleanup signals:
  // systemd owns descendant cleanup and the private mount disappears on exit.
  child.once('error', () => recordResourceIncident(owner, 'The contained worker could not start. No uncontained fallback was launched.'));
  child.once('error', () => { clearTimeout(arm); startingScopes.delete(unit); scopeIdentities.delete(unit); unwatchContainedScope(unit); });
  child.once('exit', (code, signal) => {
    clearTimeout(arm);
    startingScopes.delete(unit);
    // The launcher client exiting does NOT prove the worker stopped: under
    // --wait it usually does, but a stopped launcher can orphan a unit that
    // is still running. Confirm the unit settled before clearing tracking;
    // an orphan keeps its watch and identity so its owner can still stop it.
    void confirmUnitSettled(unit).then(async (settled) => {
      scopeIdentities.delete(unit);
      unwatchContainedScope(unit);
      if (!settled) {
        watchContainedScope(unit, owner, typeof options.cwd === 'string' ? options.cwd : process.cwd());
        recordResourceIncident(owner, 'The worker outlived its launcher (the launcher was stopped while the unit still runs). It keeps running under its own limits and stays tracked by its unit.');
        return;
      }
      if (identity.expectedExit || (code === 0 && !signal)) return;
      // Failed scopes stay loaded until inspected, so an OOM can be attributed
      // from systemd's result instead of guessing from exit 137. Then release
      // only this launch's randomly named failure record, never another unit.
      const result = await scopeOutcome(unit);
      // A launch that never registered a scope never ran a command: systemd-run
      // itself refused it (unsupported property, unit clash, manager trouble).
      // Say so plainly — a silent refusal must never look like a healthy host.
      // But a worker that ran and exited non-zero leaves no cgroup once
      // --collect removes it, so the cgroup's absence alone proves nothing:
      // ask the journal whether the unit ever started (identity fields only,
      // never MESSAGE or command output).
      if (!result
        && !existsSync(`${userCgroup}/tardis.slice/${SLICE}/${containedUnitName(unit)}`)
        && !(await unitEverStarted(unit)))
      {
        recordResourceIncident(owner, `The contained launch was refused before its scope registered (exit ${code ?? signal}). TARDIS did not run it uncontained.`);
        return;
      }
      if (result === 'oom-kill') recordResourceIncident(owner,
        MEMORY_FAILURE_NOTICE
        );
      else if (result === 'timeout') recordResourceIncident(owner, 'This worker reached its time limit and was stopped. Its private scratch and child processes were released; the job did not finish.');
      else if (signal) recordResourceIncident(owner, `The worker ended unexpectedly (${signal}). Its private scratch and child processes were released. The cause was not confirmed as out of memory.`);
      if (result && result !== 'success') await commandOutput('systemctl', ['--user', 'reset-failed', containedUnitName(unit)]).catch(() => '');
    });
  });
  return child;
}

/// Did this scope ever actually start? A launch systemd-run refuses never
/// creates the unit, so the journal has no record for it. A scope that ran and
/// exited non-zero leaves a bounded unit record behind even after --collect
/// removes its cgroup. Only identity/comm fields are requested — never MESSAGE
/// or command output.
async function unitEverStarted(unit: string): Promise<boolean> {
  if (!OWNED_UNIT.test(unit)) return false;
  const out = await commandOutput('journalctl', ['--user', `--unit=${containedUnitName(unit)}`, '--no-pager', '-n', '1', '-o', 'json', '--output-fields=UNIT,_COMM']).catch(() => '');
  return out.trim().length > 0;
}

export async function scopeOutcome(unit: string): Promise<string> {
  if (!OWNED_UNIT.test(unit)) return '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const out = await commandOutput('systemctl', ['--user', 'show', containedUnitName(unit), '-p', 'Result', '-p', 'ActiveState']).catch(() => '');
    const values = Object.fromEntries(out.split('\n').map((line) => line.split('=')));
    if (!out) break;
    if (!['active', 'deactivating'].includes(values.ActiveState)) {
      if (values.Result && values.Result !== 'success') return values.Result;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  // Collected scopes still have a structured manager failure record. Request
  // ONLY result/identity fields, never MESSAGE, command lines or job output.
  // systemd unit_log_failure emits UNIT_RESULT (src/core/unit.c).
  const journal = await commandOutput('journalctl', ['--user', `--unit=${containedUnitName(unit)}`, '--no-pager', '-n', '5', '-o', 'json',
    '--output-fields=UNIT_RESULT,USER_UNIT,UNIT,_COMM', 'UNIT_RESULT=oom-kill', 'UNIT_RESULT=timeout']).catch(() => '');
  for (const line of journal.split('\n')) {
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry._COMM !== 'systemd' || (entry.USER_UNIT !== containedUnitName(unit) && entry.UNIT !== containedUnitName(unit))) continue;
      if (entry.UNIT_RESULT === 'oom-kill' || entry.UNIT_RESULT === 'timeout') return entry.UNIT_RESULT;
    } catch { /* incomplete/unavailable journal: never infer a cause */ }
  }
  return '';
}

/** Signal this manager-owned worker tree; the manager handles PID identity,
 * graceful shutdown and the final cgroup cleanup, including detached children. */
export function signalContainedWorker(child: ChildProcess, signal: NodeJS.Signals): boolean {
  const identity = containedChildren.get(child);
  if (!identity) return false;
  if (signal === 'SIGTERM' || signal === 'SIGKILL') identity.expectedExit = true;
  if (child.exitCode !== null || child.signalCode !== null) return true;
  const unit = containedUnitName(identity.unit);
  if (signal === 'SIGKILL') {
    // The manager owns the tree: kill the whole cgroup, escalating to a stop
    // (TimeoutStopSec applies its own escalation) if the manager is busy.
    // NEVER fall back to signaling the launcher: the systemd-run client is
    // not the worker, and killing it only orphans a live unit and silently
    // drops its monitoring.
    void commandOutput('systemctl', ['--user', 'kill', '--kill-whom=all', '--signal=SIGKILL', unit])
      .catch(() => commandOutput('systemctl', ['--user', 'stop', unit]).catch(() => { /* manager unreachable */ }));
  } else {
    // Graceful: signal the command INSIDE the sandbox (the launcher's direct
    // child, which prlimit exec'd into the CLI), never the bwrap launcher
    // itself: bwrap has no signal handler, so signaling it turns every
    // graceful interrupt into a die-with-parent SIGKILL of the CLI.
    void gracefulUnitSignal(identity.unit, signal)
      .catch(() => commandOutput('systemctl', ['--user', 'kill', '--kill-whom=main', `--signal=${signal}`, unit])
        .catch(() => commandOutput('systemctl', ['--user', 'stop', unit]).catch(() => { /* manager unreachable */ })));
  }
  return true;
}

/** Signal the CLI inside a worker unit without touching the bwrap launcher:
 *  the unit's MainPID is bwrap; the direct child of MainPID is the command
 *  (prlimit exec'd into the CLI). Throws when the tree cannot be read, so
 *  callers fall back to manager-level signaling. */
async function gracefulUnitSignal(unit: string, signal: NodeJS.Signals): Promise<void> {
  const name = containedUnitName(unit);
  const main = Number(await commandOutput('systemctl', ['--user', 'show', name, '-p', 'MainPID', '--value']));
  if (!Number.isSafeInteger(main) || main <= 0) throw new Error('no main pid');
  const procs = readFileSync(`${userCgroup}/tardis.slice/${SLICE}/${name}/cgroup.procs`, 'utf8')
    .trim().split('\n').map(Number).filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  const inner = procs.filter((pid) => pid !== main);
  if (!inner.length) throw new Error('no inner command pid');
  const targets: number[] = [];
  for (const pid of inner) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[1]);
      if (ppid === main) targets.push(pid);
    } catch { /* raced */ }
  }
  if (!targets.length) throw new Error('no direct child of the launcher');
  for (const pid of targets) {
    try { process.kill(pid, signal); } catch { /* raced */ }
  }
}

/** Wait for a unit to be inactive/failed (it usually already is when its
 *  --wait client exits). False when it is still running or the manager
 *  cannot answer: tracking must be KEPT, never cleared on a guess. */
async function confirmUnitSettled(unit: string): Promise<boolean> {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const state = await unitActiveState(unit);
    if (state === 'inactive' || state === 'failed') return true;
    if (state === 'unknown') return false;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

/** Free memory inside the shared slice right now, or null when unreadable. */
function sliceMemoryHeadroom(): number | null {
  try {
    const max = Number(readFileSync(`${userCgroup}/tardis.slice/${SLICE}/memory.max`, 'utf8').trim());
    const used = Number(readFileSync(`${userCgroup}/tardis.slice/${SLICE}/memory.current`, 'utf8').trim());
    return Number.isFinite(max) && Number.isFinite(used) ? max - used : null;
  } catch { return null; }
}

export function containedScopeOf(child: ChildProcess): string | undefined { return containedChildren.get(child)?.unit; }

/** Failed durable scopes may outlive the server that launched them. Reaping
 * their terminal metadata must not depend on that server's exit listener. */
export async function releaseContainedScope(unit: string): Promise<void> {
  if (!OWNED_UNIT.test(unit)) return;
  const result = await scopeOutcome(unit);
  if (result && result !== 'success') await commandOutput('systemctl', ['--user', 'reset-failed', containedUnitName(unit)]).catch(() => '');
}
