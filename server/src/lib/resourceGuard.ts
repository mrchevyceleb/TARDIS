import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, readFileSync, readlinkSync, statfsSync } from 'node:fs';
import { mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { totalmem } from 'node:os';
import { randomUUID } from 'node:crypto';
import { assertMemoryAvailableForSpawn } from '../chat/memory.ts';
import { JsonStore } from './jsonStore.ts';
import { STATE_DIR } from '../config.ts';

const GiB = 1024 ** 3;
export const WORKER_LIMITS = { memoryHigh: 6 * GiB, memoryMax: 8 * GiB, swapMax: 256 * 1024 ** 2, tasks: 512, cpuPercent: 200, scratch: 4 * GiB };
const SLICE = 'tardis-workers.slice';
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
let aggregateTaskLimit = 4096;
let monitor: ReturnType<typeof setInterval> | undefined;
let retryInitialization: ReturnType<typeof setTimeout> | undefined;
let monitoring = false;
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
  // The workspace and existing /tmp inputs remain visible. All *new* standard
  // temporary output goes into this private, size-limited mount. PID 1
  // reaps children; closing the worker also ends setsid/nohup descendants.
  // No host scratch directory is scanned or deleted, even after a crash.
  return ['--unshare-user', '--unshare-pid', '--unshare-ipc', ...(!durable ? ['--die-with-parent'] : []), '--cap-drop', 'ALL',
    '--bind', '/', '/', '--dev-bind', '/dev', '/dev', '--proc', '/proc', '--size', String(WORKER_LIMITS.scratch), '--tmpfs', '/dev/shm',
    '--ro-bind', '/sys/fs/cgroup', '/sys/fs/cgroup',
    '--dir', '/dev/shm/tardis',
    '--setenv', 'TMPDIR', '/dev/shm/tardis', '--setenv', 'TMP', '/dev/shm/tardis', '--setenv', 'TEMP', '/dev/shm/tardis'];
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
    const properties = await commandOutput('systemctl', ['--user', 'show', SLICE, '-p', 'LoadState', '-p', 'MemoryHigh', '-p', 'MemoryMax', '-p', 'MemorySwapMax', '-p', 'MemoryOOMGroup', '-p', 'TasksMax', '-p', 'CPUQuotaPerSecUSec']);
    const values: Record<string, string> = Object.fromEntries(properties.split('\n').map((line) => line.split('=')));
    const bounded = (key: string, ceiling: number) => Number(values[key]) > 0 && Number(values[key]) <= ceiling;
    const quota = values.CPUQuotaPerSecUSec?.match(/^([\d.]+)(us|ms|s)$/);
    const units: Record<string, number> = { us: 1, ms: 1000, s: 1_000_000 };
    const quotaMicros = quota ? Number(quota[1]) * (units[quota[2]] ?? Infinity) : Infinity;
    if (values.LoadState !== 'loaded' || !bounded('MemoryHigh', 28 * GiB) || !bounded('MemoryMax', 32 * GiB)
      || !Number.isFinite(Number(values.MemorySwapMax)) || Number(values.MemorySwapMax) > GiB
      || values.MemoryOOMGroup !== 'no' || !bounded('TasksMax', 4096) || !(quotaMicros > 0 && quotaMicros <= 12_000_000)) {
      throw new Error('Install the bounded tardis-workers.slice policy from docs/RESOURCE-GUARD.md.');
    }
    aggregateTaskLimit = Number(values.TasksMax);
    // Real capability check: missing user namespaces/AppArmor permission must
    // refuse work clearly, never silently bypass scratch/process containment.
    await commandOutput('/usr/bin/bwrap', [...sandboxArgs(), '--', '/usr/bin/prlimit', '--core=0:0', '--fsize=1073741824:1073741824', '--', '/bin/sh', '-c', 'test -c /dev/null && : >/dev/null && dd if=/dev/urandom of=/dev/null bs=1 count=1 status=none && test -d /dev/shm/tardis']);
    recent = (await incidents.list()).slice(0, 50);
    await reapOwnedConfigs();
    ready = true;
    if (!monitor) { monitor = setInterval(() => { void monitorWrites(); }, 2000); monitor.unref(); }
    readiness = 'Each worker has kernel memory, swap, CPU and process limits, with private scratch that disappears on exit.';
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
  if (!ready || !/^tardis-(?:worker|job|watch)-[a-f0-9-]+$/.test(unit) || watchedScopes.has(unit)) return;
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
  try {
    // Bounded probes, no recursive filesystem walks or /proc-wide scans.
    for (const [unit, entry] of [...watchedScopes].slice(0, 256)) {
      let io: string;
      try { io = readFileSync(`${userCgroup}/tardis.slice/${SLICE}/${unit}.scope/io.stat`, 'utf8'); }
      catch {
        // A completed scope can disappear before the coarse jobs tick records
        // its result. That is normal cleanup, not loss of controller support.
        if (!existsSync(`${userCgroup}/tardis.slice/${SLICE}/${unit}.scope`)) {
          if (Date.now() - entry.missingAt > 10_000) unwatchContainedScope(unit);
          continue;
        }
        if (Date.now() - entry.missingAt > 10_000 && Date.now() - entry.alertedAt > 60_000) {
          entry.alertedAt = Date.now();
          recordResourceIncident(entry.owner, 'Worker disk accounting is unavailable. TARDIS is holding new work until the host policy is checked.');
          accountingFaults.add(unit);
        }
        continue;
      }
      accountingFaults.delete(unit); // a transient accounting outage can heal
      entry.missingAt = Date.now();
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
          await commandOutput('systemctl', ['--user', 'kill', '--signal=SIGKILL', `${unit}.scope`]);
          const message = `TARDIS stopped this worker because it ${reason}. Work saved in the workspace remains available; this job did not finish.`;
          recordResourceIncident(entry.owner, message, { unit });
          return message;
        } catch {
          const identity = scopeIdentities.get(unit);
          if (identity) identity.expectedExit = false;
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
        taskMax = Number(readFileSync(`${slice}/pids.max`, 'utf8').trim());
        tasks = Number(readFileSync(`${slice}/pids.current`, 'utf8').trim());
      } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || existsSync(slice)) throw err; } // slice may not have started yet
      let reserved = 0;
      for (const [unit, until] of startingScopes) {
        if (until <= Date.now()) { startingScopes.delete(unit); continue; }
        let counted = 0;
        try { counted = Number(readFileSync(`${slice}/${unit}.scope/pids.current`, 'utf8').trim()); } catch { /* registration in flight */ }
        reserved += Math.max(0, WORKER_LIMITS.tasks - (Number.isFinite(counted) ? counted : 0));
      }
      if (!Number.isFinite(taskMax) || !Number.isFinite(tasks) || taskMax - tasks - reserved < WORKER_LIMITS.tasks) return 'The shared worker process budget is full; TARDIS held new work until another job releases its threads.';
    }
  } catch { return 'Resource readings are unavailable; TARDIS held new work rather than guessing.'; }
  return null;
}

export function assertResourcesForSpawn(owner: string, cwd?: string): void {
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

/** All agent execution surfaces share this path, including background jobs,
 * watch commands and content generation. Arguments never include secrets. */
export function spawnContained(command: string, args: readonly string[], options: SpawnOptions, owner: string, unit = `tardis-worker-${randomUUID()}`, runtimeSeconds?: number, durable = false): ChildProcess {
  assertResourcesForSpawn(owner, typeof options.cwd === 'string' ? options.cwd : undefined);
  if (!resourceGuardRequired()) return spawn(command, args, options);
  if (options.shell) throw new Error('Contained launches require an explicit shell command.');
  if (!/^tardis-(?:worker|job|watch)-[a-f0-9-]+$/.test(unit)) throw new Error('Invalid worker scope identity.');
  const child = spawn('systemd-run', ['--user', '--scope', '--quiet', ...(durable ? ['--collect'] : []), '--expand-environment=no',
    `--slice=${SLICE}`, `--unit=${unit}`, '-p', `MemoryHigh=${WORKER_LIMITS.memoryHigh}`, '-p', `MemoryMax=${WORKER_LIMITS.memoryMax}`,
    '-p', `MemorySwapMax=${WORKER_LIMITS.swapMax}`, '-p', 'MemoryOOMGroup=yes', '-p', `TasksMax=${WORKER_LIMITS.tasks}`,
    '-p', 'IOAccounting=yes', '-p', `CPUQuota=${WORKER_LIMITS.cpuPercent}%`,
    ...(runtimeSeconds ? ['-p', `RuntimeMaxSec=${runtimeSeconds}`] : []),
    '/usr/bin/bwrap', ...sandboxArgs(durable), '--', '/usr/bin/prlimit', '--core=0:0', '--fsize=1073741824:1073741824', '--', command, ...args], options);
  const identity = { unit, expectedExit: false };
  startingScopes.set(unit, Date.now() + 10_000);
  containedChildren.set(child, identity);
  scopeIdentities.set(unit, identity);
  // Scope registration is asynchronous. Wait for the first sample rather
  // than mistaking a not-yet-created cgroup for a completed job.
  const arm = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) watchContainedScope(unit, owner, typeof options.cwd === 'string' ? options.cwd : process.cwd());
  }, 1000);
  arm.unref();
  const registration = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null && !existsSync(`${userCgroup}/tardis.slice/${SLICE}/${unit}.scope`)) {
      identity.expectedExit = true;
      try { child.kill('SIGKILL'); } catch { /* launcher gone */ }
      recordResourceIncident(owner, 'The worker scope did not register within ten seconds. TARDIS stopped its launcher; no uncontained retry was started.');
    }
  }, 10_000);
  registration.unref();
  // No process-name matching, pid reuse races or broad cleanup signals:
  // bubblewrap owns the PID namespace and kernel destroys its private tmpfs.
  child.once('error', () => recordResourceIncident(owner, 'The contained worker could not start. No uncontained fallback was launched.'));
  child.once('error', () => { clearTimeout(arm); clearTimeout(registration); startingScopes.delete(unit); scopeIdentities.delete(unit); unwatchContainedScope(unit); });
  child.once('exit', (code, signal) => {
    clearTimeout(arm);
    clearTimeout(registration);
    startingScopes.delete(unit);
    scopeIdentities.delete(unit);
    unwatchContainedScope(unit);
    if (identity.expectedExit || (code === 0 && !signal)) return;
    // Failed scopes stay loaded until inspected, so an OOM can be attributed
    // from systemd's result instead of guessing from exit 137. Then release
    // only this launch's randomly named failure record, never another unit.
    void scopeOutcome(unit).then(async (result) => {
      if (result === 'oom-kill') recordResourceIncident(owner,
        MEMORY_FAILURE_NOTICE
        );
      else if (result === 'timeout') recordResourceIncident(owner, 'This worker reached its time limit and was stopped. Its private scratch and child processes were released; the job did not finish.');
      else if (signal) recordResourceIncident(owner, `The worker ended unexpectedly (${signal}). Its private scratch and child processes were released. The cause was not confirmed as out of memory.`);
      if (result && result !== 'success') await commandOutput('systemctl', ['--user', 'reset-failed', `${unit}.scope`]).catch(() => '');
    });
  });
  return child;
}

export async function scopeOutcome(unit: string): Promise<string> {
  if (!/^tardis-(?:worker|job|watch)-[a-f0-9-]+$/.test(unit)) return '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const out = await commandOutput('systemctl', ['--user', 'show', `${unit}.scope`, '-p', 'Result', '-p', 'ActiveState']).catch(() => '');
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
  const journal = await commandOutput('journalctl', ['--user', `--unit=${unit}.scope`, '--no-pager', '-n', '5', '-o', 'json',
    '--output-fields=UNIT_RESULT,USER_UNIT,UNIT,_COMM', 'UNIT_RESULT=oom-kill', 'UNIT_RESULT=timeout']).catch(() => '');
  for (const line of journal.split('\n')) {
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry._COMM !== 'systemd' || (entry.USER_UNIT !== `${unit}.scope` && entry.UNIT !== `${unit}.scope`)) continue;
      if (entry.UNIT_RESULT === 'oom-kill' || entry.UNIT_RESULT === 'timeout') return entry.UNIT_RESULT;
    } catch { /* incomplete/unavailable journal: never infer a cause */ }
  }
  return '';
}

/** Signal the inner CLI, letting it flush its conversation before PID 1 tears
 * down the namespace. Do not kill bwrap alongside a graceful SIGTERM. */
export function signalContainedWorker(child: ChildProcess, signal: NodeJS.Signals): boolean {
  const identity = containedChildren.get(child);
  if (!identity) return false;
  if (signal === 'SIGTERM' || signal === 'SIGKILL') identity.expectedExit = true;
  if (child.exitCode !== null || child.signalCode !== null) return true;
  try {
    const pids = readFileSync(`${userCgroup}/tardis.slice/${SLICE}/${identity.unit}.scope/cgroup.procs`, 'utf8').trim().split(/\s+/).slice(0, WORKER_LIMITS.tasks);
    for (const raw of pids) {
      const pid = Number(raw);
      if (!(pid > 1)) continue;
      try {
        const ns = readFileSync(`/proc/${pid}/status`, 'utf8').match(/^NSpid:\s+(.+)$/m)?.[1].trim().split(/\s+/);
        if (ns?.length !== 2 || ns[1] !== '2') continue;
        if (!readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim().endsWith(`/${identity.unit}.scope`)) continue;
        process.kill(pid, signal);
        return true;
      } catch { /* exited during lookup */ }
    }
  } catch { /* launch not yet registered */ }
  // Before the CLI exists, ending the launcher cannot lose a turn's state.
  try { child.kill(signal); } catch { /* already gone */ }
  return true;
}

export function containedScopeOf(child: ChildProcess): string | undefined { return containedChildren.get(child)?.unit; }

/** Failed durable scopes may outlive the server that launched them. Reaping
 * their terminal metadata must not depend on that server's exit listener. */
export async function releaseContainedScope(unit: string): Promise<void> {
  if (!/^tardis-(?:worker|job|watch)-[a-f0-9]{8}-[a-f0-9-]{27}$/.test(unit)) return;
  const result = await scopeOutcome(unit);
  if (result && result !== 'success') await commandOutput('systemctl', ['--user', 'reset-failed', `${unit}.scope`]).catch(() => '');
}
