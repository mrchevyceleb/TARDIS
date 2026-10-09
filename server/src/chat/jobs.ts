// Background jobs (job_start): the one way an agent runs long work on any
// engine without blocking its turn.
//
// An agent hands TARDIS a name and a shell command. The server writes the
// command to a script, runs it detached in its own systemd scope (so a TARDIS
// restart does not kill it), captures output to a log, and records the exit
// code in a file the moment the command ends. A tick resolves each job from
// that file, then delivers a job-result into the agent's own home thread, the
// same path a routine or watch_job wake uses (every engine). Jobs persist in
// ~/.rivendell/jobs.json and keep being tracked after a restart. The UI reads
// GET /api/jobs to show a per-chat "N jobs running" list with Stop.
//
// Honesty rule: a result never says "finished" unless the command exited on
// its own. Stopped, timed out, and vanished-without-an-exit-record are
// reported as exactly that.
//
// No new privilege: the command runs with the same shell power the agent's
// own session already has on this host.

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { STATE_DIR } from '../config.ts';
import { JsonStore } from '../lib/jsonStore.ts';
import { listAgents } from './agents.ts';
import { canLaunchInScope, pidMatches, pidStart, visibleWakeText } from './jobWatches.ts';
import { sendToAgentHome } from './teamBus.ts';

export type JobState = 'running' | 'finished' | 'failed' | 'stopped' | 'timed-out' | 'lost';
export type JobStopper = 'agent' | 'user' | 'timeout';

export type Job = {
  id: string;
  createdAt?: string;
  updatedAt?: string;
  agentId: string;
  name: string;
  command: string;
  cwd: string;
  state: JobState;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  /** Minutes; past this the job is stopped and reported as timed out. */
  timeoutMin: number;
  deadline: number;
  /** The wrapper shell's pid and /proc starttime (pid-reuse guard). */
  pid?: number;
  pidStart?: number | null;
  /** systemd scope unit, when the job runs in its own scope. */
  unit?: string;
  /** Kernel boot id when the job started. A pid (and its /proc starttime) is
   *  only meaningful within one boot, so a different boot id means nothing of
   *  ours can still be running and no pid may ever be signalled. */
  bootId?: string;
  stoppedBy?: JobStopper;
  /** The exact result text still owed to the agent. Cleared once delivered. */
  wakeText?: string;
  /** Lane that started the job; the result returns there. Absent → background. */
  lane?: 'main' | 'bg';
};

const store = new JsonStore<Job>('jobs.json', []);
const JOBS_DIR = join(STATE_DIR, 'jobs');

const TICK_MS = 5_000;
const RETRY_MS = 60_000;
const MIN_TIMEOUT_MIN = 1;
const MAX_TIMEOUT_MIN = 24 * 60;
const DEFAULT_TIMEOUT_MIN = 120;
const MAX_RUNNING_PER_AGENT = 12;
const KEEP_ENDED_MS = 72 * 60 * 60_000;
const STOP_GRACE_MS = 8_000;
const KILL_CONFIRM_MS = 3_000;
/** How long a fresh job may exist without a recorded pid (launch in flight). */
const LAUNCH_ORPHAN_MS = 30_000;
/** A launch that dies inside this window without an exit record never started. */
const LAUNCH_HANDSHAKE_MS = 700;
const TAIL_LINES = 12;
const TAIL_CHARS = 1600;

let mutations: Promise<unknown> = Promise.resolve();
function serialize<T>(op: () => Promise<T>): Promise<T> {
  const run = mutations.then(op, op);
  mutations = run.then(() => {}, () => {});
  return run;
}

/** Jobs being resolved or delivered right now. One outcome, one wake. */
/** Owed results for one agent deliver as ONE bundled wake, oldest first. */
const WAKE_BUNDLE_MAX = 5;

const delivering = new Set<string>();
/** One bundle delivery in flight per agent, so a long admission wait inside
 *  sendToAgentHome never stacks concurrent sends for one lane. */
const deliveringAgent = new Set<string>();
/** Jobs a stop is in flight for. The tick must not call one "lost" just
 *  because its wrapper already died while a stubborn child waits for KILL. */
const stopping = new Set<string>();

const BOOT_ID = (() => {
  try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return ''; }
})();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const retryUntil = new Map<string, number>();

const etHourFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23',
});
function etHour(ms: number): number {
  return Number(etHourFmt.format(new Date(ms)));
}

/** Quiet hours hold (Matt, Oct 8 2026): an owed wake for a job STARTED
 *  outside 22:00-05:00 ET holds through the window and resumes after 05:00.
 *  A job started inside the window was started on purpose (overnight
 *  emergency work) and delivers normally. */
function heldForQuietHours(job: Job, now: number): boolean {
  const h = etHour(now);
  if (h >= 5 && h < 22) return false;
  const started = etHour(job.startedAt);
  return !(started >= 22 || started < 5);
}

const logPath = (id: string) => join(JOBS_DIR, `${id}.log`);
const exitPath = (id: string) => join(JOBS_DIR, `${id}.exit`);
const cmdPath = (id: string) => join(JOBS_DIR, `${id}.cmd.sh`);
const runPath = (id: string) => join(JOBS_DIR, `${id}.run.sh`);

/** Single-quote a value for embedding in the wrapper script. */
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Last bytes of a file, decoded, with terminal escapes stripped. */
function readTail(file: string, maxBytes = 8192): string {
  try {
    const size = statSync(file).size;
    if (size === 0) return '';
    const fd = openSync(file, 'r');
    try {
      const len = Math.min(size, maxBytes);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      // eslint-disable-next-line no-control-regex
      return buf.toString('utf8').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r(?!\n)/g, '\n');
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}

function lastLines(file: string, count: number): string {
  const lines = readTail(file).split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.slice(-count).join('\n');
}

export function jobLastLine(job: Job): string {
  return lastLines(logPath(job.id), 1).slice(0, 200);
}

export function jobLogTail(id: string, lines: number): string {
  return lastLines(logPath(id), Math.max(1, Math.min(400, lines)));
}

function readExitCode(id: string): number | null {
  try {
    const raw = readFileSync(exitPath(id), 'utf8').trim();
    const code = Number(raw);
    return raw !== '' && Number.isInteger(code) ? code : null;
  } catch {
    return null;
  }
}

/** What happened, in words that never overstate. */
function outcomeText(job: Job): string {
  const took = fmtDuration((job.endedAt ?? Date.now()) - job.startedAt);
  switch (job.state) {
    case 'finished': return `finished: exit 0 in ${took}`;
    case 'failed': {
      const code = job.exitCode ?? -1;
      // Above 128 a shell often means "killed by a signal", but exit 200 is also valid: say only what is known.
      return `failed: exit ${code} in ${took}${code > 128 ? ` (exit codes above 128 often mean the process was killed by a signal)` : ''}`;
    }
    case 'stopped': return `was stopped${job.stoppedBy === 'user' ? ' from the UI' : ''} after ${took}. It did NOT finish.`;
    case 'timed-out': return `timed out after ${job.timeoutMin}m and was stopped. It did NOT finish.`;
    case 'lost': return `is gone after ${took}: it ended without recording an exit code (host restart, out of memory, or an outside kill), so its result is unknown. Read the log.`;
    default: return 'is still running';
  }
}

function resultText(job: Job): string {
  const tail = lastLines(logPath(job.id), TAIL_LINES).slice(-TAIL_CHARS);
  return [
    `[job: ${job.name}] Job "${job.name}" ${outcomeText(job)}`,
    tail ? `Last output:\n${tail}` : 'No output was captured.',
    `Full log: ${logPath(job.id)}`,
    'Background job result from job_start. This is not a message from a person.',
  ].join('\n');
}

export type CreateJobInput = {
  agentId: string;
  lane?: unknown;
  name?: unknown;
  command?: unknown;
  cwd?: unknown;
  timeoutMin?: unknown;
};

/** Start a job. Throws Error with a plain reason on bad input (the route maps
 *  it to 4xx). */
export async function createJob(input: CreateJobInput): Promise<Job> {
  if (!listAgents().some((a) => a.id === input.agentId)) throw new Error('unknown agentId');
  if (typeof input.command !== 'string' || !input.command.trim()) throw new Error('command is required (a shell command)');
  const command = input.command.trim();
  if (command.length > 16_000) throw new Error('command is too long; put it in a script file and run that');
  const fallbackName = command.split(/\s+/)[0]?.split('/').pop() || 'job';
  const name = (typeof input.name === 'string' ? input.name : fallbackName).trim().replace(/\s+/g, ' ').slice(0, 80) || fallbackName;
  let cwd = homedir();
  if (input.cwd !== undefined) {
    if (typeof input.cwd !== 'string' || !isAbsolute(input.cwd.trim())) throw new Error('cwd must be an absolute path on this host');
    cwd = input.cwd.trim();
    let isDir = false;
    try { isDir = statSync(cwd).isDirectory(); } catch { /* missing */ }
    if (!isDir) throw new Error(`cwd is not an existing directory: ${cwd}`);
  }
  if (input.timeoutMin !== undefined
    && (typeof input.timeoutMin !== 'number' || !Number.isSafeInteger(input.timeoutMin) || input.timeoutMin < MIN_TIMEOUT_MIN || input.timeoutMin > MAX_TIMEOUT_MIN)) {
    throw new Error(`timeoutMin must be an integer ${MIN_TIMEOUT_MIN}-${MAX_TIMEOUT_MIN} minutes`);
  }
  const timeoutMin = typeof input.timeoutMin === 'number' ? input.timeoutMin : DEFAULT_TIMEOUT_MIN;

  const id = randomUUID();
  const short = id.slice(0, 8);
  const scoped = await canLaunchInScope();
  const unit = scoped ? `tardis-job-${short}` : undefined;
  mkdirSync(JOBS_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(cmdPath(id), `#!/bin/bash\n${command}\n`, { mode: 0o700 });
  writeFileSync(logPath(id), '', { mode: 0o600 });
  // The wrapper records the exit code atomically (tmp + mv) only when the
  // command ends on its own. A killed wrapper writes nothing, which is how a
  // stop or an outside kill is told apart from a real exit. A working
  // directory that cannot be entered fails the job instead of running the
  // command somewhere else.
  const recordExit = (code: string) => `printf '%s' ${code} >${shq(`${exitPath(id)}.tmp`)} && mv ${shq(`${exitPath(id)}.tmp`)} ${shq(exitPath(id))}`;
  writeFileSync(runPath(id), [
    '#!/bin/bash',
    `cd ${shq(cwd)} 2>/dev/null || { echo ${shq(`job_start: cannot enter the working directory ${cwd}`)} >>${shq(logPath(id))}; ${recordExit('127')}; exit 127; }`,
    `/bin/bash ${shq(cmdPath(id))} >>${shq(logPath(id))} 2>&1 </dev/null`,
    'code=$?',
    recordExit('"$code"'),
    '',
  ].join('\n'), { mode: 0o700 });

  // Reserve first: the record (and the per-agent limit, counted in the same
  // serialized step) exists before anything runs, so concurrent starts cannot
  // exceed the limit and a failed launch never leaves an untracked process.
  const now = Date.now();
  let reserved: Job;
  try {
    reserved = await serialize(async () => {
      const running = (await store.list()).filter((j) => j.agentId === input.agentId && j.state === 'running').length;
      if (running >= MAX_RUNNING_PER_AGENT) throw new Error(`${running} jobs are already running for this agent; stop or wait for one before starting another`);
      return store.create({
        id, agentId: input.agentId, name, command, cwd, state: 'running' as const,
        startedAt: now, timeoutMin, deadline: now + timeoutMin * 60_000,
        unit, bootId: BOOT_ID || undefined,
        lane: input.lane === 'main' ? 'main' as const : 'bg' as const,
      });
    });
  } catch (err) {
    cleanupFiles(id);
    throw err;
  }

  const child = scoped
    ? spawn('systemd-run', ['--user', '--scope', '--quiet', '--collect', '--expand-environment=no', '--unit', unit!, '/bin/bash', runPath(id)], { detached: true, stdio: 'ignore' })
    : spawn('/bin/bash', [runPath(id)], { detached: true, stdio: 'ignore' });
  child.unref();
  // Launch handshake: a spawn error, or a process that dies at once without an
  // exit record (systemd-run refusing the scope), never started. Do not claim
  // success for it.
  const launchFailure = await new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (value: string | null) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => finish(null), LAUNCH_HANDSHAKE_MS);
    child.once('error', (err) => finish(err.message));
    child.once('exit', (code) => finish(readExitCode(id) !== null ? null : `it exited with code ${code} before starting`));
  });
  if (launchFailure !== null || typeof child.pid !== 'number') {
    try { await serialize(() => store.delete(id)); } catch { /* the tick will mark it lost */ }
    cleanupFiles(id);
    throw new Error(`the job could not be started: ${launchFailure ?? 'no process was created'}`);
  }
  let job: Job | null = null;
  try {
    job = await serialize(() => store.update(id, { pid: child.pid, pidStart: pidStart(child.pid!) }));
  } catch { /* handled below */ }
  if (!job) {
    // Untracked is worse than not started: stop what we launched.
    await terminateJob({ ...reserved, pid: child.pid, pidStart: pidStart(child.pid) }).catch(() => false);
    try { await serialize(() => store.delete(id)); } catch { /* best effort */ }
    cleanupFiles(id);
    throw new Error('the job could not be recorded, so it was stopped');
  }
  console.log(`[jobs] started "${name}" (${short}) for ${input.agentId} pid=${child.pid}${unit ? ` scope=${unit}` : ' (no scope)'}`);
  return job;
}

function cleanupFiles(id: string): void {
  for (const file of [logPath(id), exitPath(id), `${exitPath(id)}.tmp`, cmdPath(id), runPath(id)]) {
    try { rmSync(file, { force: true }); } catch { /* best effort */ }
  }
}

/** A `systemctl --user` call against a wedged user manager can hang forever.
 *  Nothing here is worth blocking the reaper on, so every spawn gets a hard
 *  deadline and an unanswered call resolves null (= "could not determine"),
 *  which every caller already treats conservatively. */
const RUN_TIMEOUT_MS = 10_000;

/** runQuiet's answer when a command hit the deadline. Distinct from null on
 *  purpose: null means systemd could not be reached AT ALL, which is the one
 *  case where falling back to the wrapper pid is right. A timeout means the
 *  scope's state is simply unknown, and treating unknown as dead would let the
 *  reaper declare a job finished while its processes keep running. */
const RUN_TIMED_OUT = Symbol('run-timed-out');

function withDeadline<T>(
  child: ReturnType<typeof spawn>,
  resolve: (value: T) => void,
  onTimeout: T,
): () => void {
  const timer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    resolve(onTimeout);
  }, RUN_TIMEOUT_MS);
  // Never hold the event loop open just for a reaper probe.
  timer.unref?.();
  return () => clearTimeout(timer);
}

function runQuiet(cmd: string, args: string[]): Promise<number | null | typeof RUN_TIMED_OUT> {
  return new Promise((resolve) => {
    try {
      const p = spawn(cmd, args, { stdio: 'ignore' });
      const done = withDeadline<number | null | typeof RUN_TIMED_OUT>(p, resolve, RUN_TIMED_OUT);
      p.once('error', () => { done(); resolve(null); });
      p.once('exit', (code) => { done(); resolve(code); });
    } catch {
      resolve(null);
    }
  });
}

/** Same as runQuiet but hands back trimmed stdout (null if the command could
 *  not run or exited nonzero). Used for the one systemd property that cannot
 *  be read from an exit code. */
function runCaptured(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      p.stdout.setEncoding('utf8');
      p.stdout.on('data', (chunk: string) => { out += chunk; });
      const done = withDeadline<string | null>(p, resolve, null);
      p.once('error', () => { done(); resolve(null); });
      p.once('close', (code) => { done(); resolve(code === 0 ? out.trim() : null); });
    } catch {
      resolve(null);
    }
  });
}

/** The wrapper shell (the scope's main process) is still the process we
 *  started, on this same boot. */
function wrapperAlive(job: Job): boolean {
  if (job.bootId && job.bootId !== BOOT_ID) return false;
  return typeof job.pid === 'number' && Number.isSafeInteger(job.pid) && job.pid > 1 && pidMatches(job.pid, job.pidStart);
}

/** Anything of the job still running: the whole scope when it has one. */
async function jobAlive(job: Job): Promise<boolean> {
  if (job.bootId && job.bootId !== BOOT_ID) return false;
  if (job.unit) {
    const active = await runQuiet('systemctl', ['--user', 'is-active', '--quiet', `${job.unit}.scope`]);
    // Unanswered is not evidence of death: a wedged user manager must leave the
    // job alive rather than let the reaper report a running job as gone.
    if (active === RUN_TIMED_OUT) return true;
    if (active !== null) {
      if (active !== 0) return false;
      // An ABANDONED scope keeps ActiveState=active with nothing left inside
      // it, so is-active on its own calls a long-finished job alive forever.
      // That is a live loop, not a cosmetic wrong answer: the timeout stop
      // signals an empty cgroup, this still answers alive, stopJob throws,
      // and the 5s tick retries it for the life of the process — about 46
      // `systemctl` spawns per attempt, per job (4 jobs sat like this for
      // 4-6 hours on Oct 7 2026). No tasks in the cgroup means no job.
      // Only an explicit "0" counts as gone: with task accounting off the
      // property reads "[not set]", and an unknown must stay alive rather
      // than report a running job as finished.
      const tasks = await runCaptured('systemctl', ['--user', 'show', `${job.unit}.scope`, '-p', 'TasksCurrent', '--value']);
      return tasks !== '0';
    }
  }
  return wrapperAlive(job);
}

/** Release a scope with nothing left inside it. systemd holds an ABANDONED
 *  scope at ActiveState=active indefinitely once its processes are gone, so a
 *  scope nothing ever stops leaks for the life of the login session (94 had
 *  piled up on this box by Oct 7 2026, 90 of them from jobs that had finished
 *  normally). Never tears down a scope that still has tasks, and never reports
 *  failure: cleanup must not break a job's bookkeeping. */
async function releaseScope(job: Job): Promise<void> {
  if (!job.unit || (job.bootId && job.bootId !== BOOT_ID)) return;
  await releaseUnit(job.unit);
}

/** Scopes awaiting release, with the attempts each has left. The wrapper writes
 *  its exit file BEFORE it exits, so a job terminalizes while descendants can
 *  still be inside its scope: the first release then correctly declines, and
 *  without this the job is no longer running and nothing ever retries, so the
 *  scope leaks exactly as before. Attempts are bounded so a scope that never
 *  empties cannot be probed for the life of the process. */
const pendingRelease = new Map<string, number>();
const RELEASE_ATTEMPTS = 60;
/** Probes per tick. Every probe can sit out the full RUN_TIMEOUT_MS against a
 *  wedged user manager, and this drain shares the tick with job completion and
 *  timeout handling, so an unbounded pass could delay those by attempts ×
 *  timeout. Retries rotate to the back of the map, so a long queue still drains
 *  fairly instead of starving behind the first few. */
const RELEASE_PER_TICK = 4;

async function releaseUnit(unit: string): Promise<void> {
  const tasks = await runCaptured('systemctl', ['--user', 'show', `${unit}.scope`, '-p', 'TasksCurrent', '--value']);
  // Already inactive (empty value), or task accounting is off so emptiness can
  // never be established ("[not set]"). Either way there is nothing to retry.
  if (tasks === '' || tasks === '[not set]') {
    pendingRelease.delete(unit);
    return;
  }
  // Empty, so it is ours to release — but only a stop that actually SUCCEEDED
  // finishes the job. A transiently wedged user manager would otherwise drop
  // the retry and permanently leak the very scope this exists to clean up.
  if (tasks === '0' && await runQuiet('systemctl', ['--user', 'stop', `${unit}.scope`]) === 0) {
    pendingRelease.delete(unit);
    return;
  }
  // Still occupied, or a probe or stop that did not succeed: try again later,
  // re-inserted at the back so other pending units get their turn first.
  const left = pendingRelease.get(unit) ?? RELEASE_ATTEMPTS;
  pendingRelease.delete(unit);
  if (left > 1) pendingRelease.set(unit, left - 1);
}

async function pollDead(isAlive: () => Promise<boolean> | boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (!(await isAlive())) return true;
    if (Date.now() >= end) return false;
    await sleep(250);
  }
}

/** Terminate a job's whole process tree and confirm it is gone: TERM, then KILL
 *  after the grace. Never signals a pid <= 1, and never signals by pid across a
 *  reboot. Resolves false when something is still alive after the KILL. */
async function terminateJob(job: Job): Promise<boolean> {
  if (job.bootId && job.bootId !== BOOT_ID) return true;
  if (job.unit) {
    const kill = (sig: 'SIGTERM' | 'SIGKILL') => runQuiet('systemctl', ['--user', 'kill', '--kill-whom=all', `--signal=${sig}`, `${job.unit}.scope`]);
    await kill('SIGTERM');
    let dead = await pollDead(() => jobAlive(job), STOP_GRACE_MS);
    if (!dead) {
      await kill('SIGKILL');
      dead = await pollDead(() => jobAlive(job), KILL_CONFIRM_MS);
    }
    if (dead) await releaseScope(job);
    return dead;
  }
  // No scope (systemd unavailable): the wrapper leads its own process group.
  // Only signal a group whose leader we can still verify; its members can
  // outlive the wrapper, so confirm the whole group is gone, not just the pid.
  if (!wrapperAlive(job)) return true;
  const pgid = job.pid!;
  const groupAlive = () => {
    try { process.kill(-pgid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
  };
  try { process.kill(-pgid, 'SIGTERM'); } catch { /* gone */ }
  if (await pollDead(groupAlive, STOP_GRACE_MS)) return true;
  try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ }
  return pollDead(groupAlive, KILL_CONFIRM_MS);
}

/** Stop a running job. Returns the updated record, or null if it is not
 *  running (already ended or unknown). The job is recorded as stopped only
 *  once it is confirmed gone; otherwise this throws and it stays running.
 *  `by` decides whether the agent is woken: an agent that stopped its own job
 *  already knows. */
export async function stopJob(id: string, by: JobStopper): Promise<Job | null> {
  const job = (await store.list()).find((j) => j.id === id);
  if (!job || job.state !== 'running' || stopping.has(id)) return null;
  stopping.add(id);
  try {
    if (!(await terminateJob(job))) throw new Error('the job is still running after SIGKILL; check the host and try again');
  } catch (err) {
    stopping.delete(id);
    throw err;
  }
  return serialize(async () => {
    const current = (await store.list()).find((j) => j.id === id);
    if (!current || current.state !== 'running') return null;
    // Natural completion wins the race: a command that exited on its own before
    // the stop landed is reported as what it did, never as stopped.
    const natural = checkRunning(current, Date.now());
    if (natural && natural.state !== 'lost') {
      return store.update(id, { ...natural, wakeText: resultText({ ...current, ...natural } as Job) });
    }
    const ended = { ...current, state: (by === 'timeout' ? 'timed-out' : 'stopped') as JobState, endedAt: Date.now(), stoppedBy: by };
    const patch: Partial<Job> = { state: ended.state, endedAt: ended.endedAt, stoppedBy: by };
    if (by !== 'agent') patch.wakeText = resultText(ended);
    return store.update(id, patch);
  }).finally(() => { stopping.delete(id); });
}

export async function listJobs(): Promise<Job[]> {
  return store.list();
}

export async function getJob(id: string): Promise<Job | null> {
  return (await store.list()).find((j) => j.id === id) ?? null;
}

/** Resolve a running job from its exit record or its wrapper's liveness.
 *  Returns the patch to persist, or null to keep waiting (the deadline is the
 *  caller's job: it needs a stop). */
function checkRunning(job: Job, now: number): Partial<Job> | null {
  // Liveness first, then the exit file: the wrapper writes the exit file
  // before it exits, so a dead wrapper with no exit file is really gone.
  const alive = wrapperAlive(job);
  const code = readExitCode(job.id);
  if (code !== null) {
    // The tick is 5s coarse; the exit record's mtime is when it really ended.
    let endedAt = now;
    try { endedAt = Math.min(now, statSync(exitPath(job.id)).mtimeMs); } catch { /* keep now */ }
    return { state: code === 0 ? 'finished' : 'failed', exitCode: code, endedAt };
  }
  // A fresh record with no pid yet is a launch in flight, not a lost job.
  if (typeof job.pid !== 'number' && now - job.startedAt < LAUNCH_ORPHAN_MS) return null;
  if (!alive) return { state: 'lost', exitCode: null, endedAt: now };
  return null;
}

/** One tick at a time. Every tick awaits per-job `systemctl` probes, stops and
 *  scope releases, so a slow or wedged batch can outlast TICK_MS; without this
 *  guard the interval would start a second pass over the same jobs and stack up
 *  overlapping `systemctl` children — the resource loop the reaper fixes. */
let ticking = false;

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await runTick();
  } finally {
    ticking = false;
  }
}

async function runTick(): Promise<void> {
  let jobs: Job[];
  try {
    jobs = await store.list();
  } catch (err) {
    console.warn('[jobs] store unreadable:', (err as Error).message);
    return;
  }
  const now = Date.now();
  for (const job of jobs) {
    if (delivering.has(job.id)) continue;
    if (job.state === 'running') {
      if (stopping.has(job.id)) continue;
      let patch = checkRunning(job, now);
      // Wrapper gone but the scope still has processes: not lost, still running
      // (the deadline or a Stop will end it).
      if (patch?.state === 'lost' && job.unit && await jobAlive(job)) patch = null;
      if (patch) {
        const ended = { ...job, ...patch } as Job;
        await serialize(async () => {
          const current = (await store.list()).find((j) => j.id === job.id);
          if (current?.state === 'running') await store.update(job.id, { ...patch, wakeText: resultText(ended) });
        });
        // The job ended on its own, so no one signalled its scope: release it.
        await releaseScope(job);
      } else if (now >= job.deadline) {
        try {
          await stopJob(job.id, 'timeout');
        } catch (err) {
          console.warn(`[jobs] "${job.name}": timeout stop failed:`, (err as Error).message);
        }
      }
      continue;
    }
    if (job.wakeText) continue; // owed wakes deliver as bundles below
    if (job.endedAt && now - job.endedAt > KEEP_ENDED_MS && !job.wakeText) {
      await serialize(() => store.delete(job.id));
      cleanupFiles(job.id);
      retryUntil.delete(job.id);
    }
  }
  // Owed results deliver as ONE bundled wake per agent+lane per tick, oldest
  // first: a busy lane accumulates results all day, and waking it once per
  // result floods it the moment it goes idle (Oct 8: 139 single-result turns
  // to one lane between 22:03 and 00:31). Jobs started inside quiet hours
  // deliver normally; results owed from before the window hold until 05:00 ET.
  const owed = new Map<string, { agentId: string; lane: string; jobs: Job[] }>();
  for (const job of jobs) {
    if (!job.wakeText || job.state === 'running' || delivering.has(job.id)) continue;
    if ((retryUntil.get(job.id) ?? 0) > now) continue;
    if (heldForQuietHours(job, now)) continue;
    const key = `${job.agentId}\u0000${job.lane ?? 'bg'}`;
    const group = owed.get(key) ?? { agentId: job.agentId, lane: job.lane ?? 'bg', jobs: [] };
    group.jobs.push(job);
    owed.set(key, group);
  }
  for (const group of owed.values()) {
    if (deliveringAgent.has(group.agentId)) continue;
    const bundle = group.jobs.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0)).slice(0, WAKE_BUNDLE_MAX);
    for (const job of bundle) delivering.add(job.id);
    deliveringAgent.add(group.agentId);
    void deliverBundle(group.agentId, bundle).finally(() => {
      for (const job of bundle) delivering.delete(job.id);
      deliveringAgent.delete(group.agentId);
    });
  }
  // Scopes whose job had already ended but which still held processes when we
  // first tried. Keyed by unit, so a record deleted above is still cleaned up.
  for (const unit of [...pendingRelease.keys()].slice(0, RELEASE_PER_TICK)) await releaseUnit(unit);
}

/** Deliver owed results as one wake. On failure (agent busy past the
 *  admission wait, engine down) the exact text stays on each record and the
 *  bundle retries after RETRY_MS. */
async function deliverBundle(agentId: string, jobs: Job[]): Promise<void> {
  const names = jobs.map((job) => `"${job.name}"`).join(', ');
  try {
    const agent = listAgents().find((a) => a.id === agentId);
    if (!agent) {
      await serialize(() => Promise.all(jobs.map((job) => store.update(job.id, { wakeText: undefined }))));
      return;
    }
    const text = jobs.map((job) => job.wakeText!).join('\n\n');
    const result = await sendToAgentHome(agent, text, {
      peerFrom: jobs.length === 1 ? `⏱ ${jobs[0].name}` : `⏱ ${jobs.length} finished jobs`,
      peerFromRole: 'automation',
      peerText: visibleWakeText(text),
      lane: jobs[0].lane === 'main' ? 'main' : 'bg',
    });
    if (result.delivered) {
      await serialize(() => Promise.all(jobs.map((job) => store.update(job.id, { wakeText: undefined }))));
      for (const job of jobs) retryUntil.delete(job.id);
      console.log(`[jobs] ${names} (${jobs[0].state}${jobs.length > 1 ? ` +${jobs.length - 1} more` : ''}) → woke ${agent.name}`);
      return;
    }
    for (const job of jobs) retryUntil.set(job.id, Date.now() + RETRY_MS);
    console.warn(`[jobs] ${names}: result not delivered (${result.reason}); will retry`);
  } catch (err) {
    for (const job of jobs) retryUntil.set(job.id, Date.now() + RETRY_MS);
    console.warn(`[jobs] ${names}: delivery failed:`, (err as Error).message);
  }
}

/** Watch loop, started once at boot. Jobs started before a restart keep being
 *  tracked: their scopes survive, and the exit record is on disk. */
export function startJobScheduler(): void {
  const iv = setInterval(() => { void tick().catch((err) => console.warn('[jobs] tick failed:', (err as Error).message)); }, TICK_MS);
  iv.unref?.();
}
