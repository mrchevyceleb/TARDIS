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
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { STATE_DIR } from '../config.ts';
import { JsonStore } from '../lib/jsonStore.ts';
import { listAgents } from './agents.ts';
import { canLaunchInScope, pidMatches, pidStart } from './jobWatches.ts';
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
  stoppedBy?: JobStopper;
  /** The exact result text still owed to the agent. Cleared once delivered. */
  wakeText?: string;
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
const TAIL_LINES = 12;
const TAIL_CHARS = 1600;

let mutations: Promise<unknown> = Promise.resolve();
function serialize<T>(op: () => Promise<T>): Promise<T> {
  const run = mutations.then(op, op);
  mutations = run.then(() => {}, () => {});
  return run;
}

/** Jobs being resolved or delivered right now. One outcome, one wake. */
const delivering = new Set<string>();
const retryUntil = new Map<string, number>();

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
      return code > 128 ? `ended with exit ${code} (killed by signal ${code - 128}) after ${took}` : `failed: exit ${code} in ${took}`;
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
    if (!existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);
  }
  if (input.timeoutMin !== undefined
    && (typeof input.timeoutMin !== 'number' || !Number.isSafeInteger(input.timeoutMin) || input.timeoutMin < MIN_TIMEOUT_MIN || input.timeoutMin > MAX_TIMEOUT_MIN)) {
    throw new Error(`timeoutMin must be an integer ${MIN_TIMEOUT_MIN}-${MAX_TIMEOUT_MIN} minutes`);
  }
  const timeoutMin = typeof input.timeoutMin === 'number' ? input.timeoutMin : DEFAULT_TIMEOUT_MIN;

  const running = (await store.list()).filter((j) => j.agentId === input.agentId && j.state === 'running').length;
  if (running >= MAX_RUNNING_PER_AGENT) throw new Error(`${running} jobs are already running for this agent; stop or wait for one before starting another`);

  const id = randomUUID();
  const short = id.slice(0, 8);
  mkdirSync(JOBS_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(cmdPath(id), `#!/bin/bash\n${command}\n`, { mode: 0o700 });
  writeFileSync(logPath(id), '', { mode: 0o600 });
  // The wrapper records the exit code atomically (tmp + mv) only when the
  // command ends on its own. A killed wrapper writes nothing, which is how a
  // stop or an outside kill is told apart from a real exit.
  writeFileSync(runPath(id), [
    '#!/bin/bash',
    `cd ${shq(cwd)} 2>/dev/null || cd "$HOME"`,
    `/bin/bash ${shq(cmdPath(id))} >>${shq(logPath(id))} 2>&1 </dev/null`,
    'code=$?',
    `printf '%s' "$code" >${shq(`${exitPath(id)}.tmp`)} && mv ${shq(`${exitPath(id)}.tmp`)} ${shq(exitPath(id))}`,
    '',
  ].join('\n'), { mode: 0o700 });

  const scoped = await canLaunchInScope();
  const unit = scoped ? `tardis-job-${short}` : undefined;
  const child = scoped
    ? spawn('systemd-run', ['--user', '--scope', '--quiet', '--collect', '--expand-environment=no', '--unit', unit!, '/bin/bash', runPath(id)], { detached: true, stdio: 'ignore' })
    : spawn('/bin/bash', [runPath(id)], { detached: true, stdio: 'ignore' });
  let spawnError: string | null = null;
  child.once('error', (err) => { spawnError = err.message; });
  child.unref();
  if (typeof child.pid !== 'number') {
    cleanupFiles(id);
    throw new Error(`the job could not be started${spawnError ? `: ${spawnError}` : ''}`);
  }
  const now = Date.now();
  const job = await serialize(() => store.create({
    id, agentId: input.agentId, name, command, cwd, state: 'running' as const,
    startedAt: now, timeoutMin, deadline: now + timeoutMin * 60_000,
    pid: child.pid, pidStart: pidStart(child.pid!), unit,
  }));
  console.log(`[jobs] started "${name}" (${short}) for ${input.agentId} pid=${child.pid}${unit ? ` scope=${unit}` : ' (no scope)'}`);
  return job;
}

function cleanupFiles(id: string): void {
  for (const file of [logPath(id), exitPath(id), `${exitPath(id)}.tmp`, cmdPath(id), runPath(id)]) {
    try { rmSync(file, { force: true }); } catch { /* best effort */ }
  }
}

function runQuiet(cmd: string, args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    try {
      const p = spawn(cmd, args, { stdio: 'ignore' });
      p.once('error', () => resolve(null));
      p.once('exit', (code) => resolve(code));
    } catch {
      resolve(null);
    }
  });
}

/** Terminate a job's whole process tree: TERM now, KILL if anything is still
 *  alive after the grace. Never targets a pid <= 1. */
async function killJobProcesses(job: Job): Promise<void> {
  if (job.unit) {
    await runQuiet('systemctl', ['--user', 'kill', '--kill-whom=all', '--signal=SIGTERM', `${job.unit}.scope`]);
    const timer = setTimeout(() => {
      void runQuiet('systemctl', ['--user', 'kill', '--kill-whom=all', '--signal=SIGKILL', `${job.unit}.scope`]);
    }, STOP_GRACE_MS);
    timer.unref?.();
    return;
  }
  const pid = job.pid;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 1 || !pidMatches(pid, job.pidStart)) return;
  try { process.kill(-pid, 'SIGTERM'); } catch { /* gone */ }
  const timer = setTimeout(() => {
    if (pidMatches(pid, job.pidStart)) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }
  }, STOP_GRACE_MS);
  timer.unref?.();
}

/** Stop a running job. Returns the updated record, or null if it is not
 *  running (already ended or unknown). `by` decides whether the agent is
 *  woken: an agent that stopped its own job already knows. */
export async function stopJob(id: string, by: JobStopper): Promise<Job | null> {
  const job = (await store.list()).find((j) => j.id === id);
  if (!job || job.state !== 'running') return null;
  await killJobProcesses(job);
  return serialize(async () => {
    const current = (await store.list()).find((j) => j.id === id);
    if (!current || current.state !== 'running') return null;
    const ended = { ...current, state: (by === 'timeout' ? 'timed-out' : 'stopped') as JobState, endedAt: Date.now(), stoppedBy: by };
    const patch: Partial<Job> = { state: ended.state, endedAt: ended.endedAt, stoppedBy: by };
    if (by !== 'agent') patch.wakeText = resultText(ended);
    return store.update(id, patch);
  });
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
  const alive = typeof job.pid === 'number' && pidMatches(job.pid, job.pidStart);
  const code = readExitCode(job.id);
  if (code !== null) {
    // The tick is 5s coarse; the exit record's mtime is when it really ended.
    let endedAt = now;
    try { endedAt = Math.min(now, statSync(exitPath(job.id)).mtimeMs); } catch { /* keep now */ }
    return { state: code === 0 ? 'finished' : 'failed', exitCode: code, endedAt };
  }
  if (!alive) return { state: 'lost', exitCode: null, endedAt: now };
  return null;
}

async function tick(): Promise<void> {
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
      const patch = checkRunning(job, now);
      if (patch) {
        const ended = { ...job, ...patch } as Job;
        await serialize(async () => {
          const current = (await store.list()).find((j) => j.id === job.id);
          if (current?.state === 'running') await store.update(job.id, { ...patch, wakeText: resultText(ended) });
        });
      } else if (now >= job.deadline) {
        await stopJob(job.id, 'timeout');
      }
      continue;
    }
    if (job.wakeText && (retryUntil.get(job.id) ?? 0) <= now) {
      delivering.add(job.id);
      void deliver(job).finally(() => delivering.delete(job.id));
      continue;
    }
    if (job.endedAt && now - job.endedAt > KEEP_ENDED_MS && !job.wakeText) {
      await serialize(() => store.delete(job.id));
      cleanupFiles(job.id);
      retryUntil.delete(job.id);
    }
  }
}

/** Deliver the owed result. On failure (agent busy past the admission wait,
 *  engine down) the exact text stays on the record and retries each minute. */
async function deliver(job: Job): Promise<void> {
  try {
    const agent = listAgents().find((a) => a.id === job.agentId);
    if (!agent) {
      await serialize(() => store.update(job.id, { wakeText: undefined }));
      return;
    }
    const result = await sendToAgentHome(agent, job.wakeText!, {
      peerFrom: `⏱ ${job.name}`,
      peerFromRole: 'automation',
      peerText: `job: ${job.name}`,
    });
    if (result.delivered) {
      await serialize(() => store.update(job.id, { wakeText: undefined }));
      retryUntil.delete(job.id);
      console.log(`[jobs] "${job.name}" (${job.state}) → woke ${agent.name}`);
      return;
    }
    retryUntil.set(job.id, Date.now() + RETRY_MS);
    console.warn(`[jobs] "${job.name}": result not delivered (${result.reason}); will retry`);
  } catch (err) {
    retryUntil.set(job.id, Date.now() + RETRY_MS);
    console.warn(`[jobs] "${job.name}": delivery failed:`, (err as Error).message);
  }
}

/** Watch loop, started once at boot. Jobs started before a restart keep being
 *  tracked: their scopes survive, and the exit record is on disk. */
export function startJobScheduler(): void {
  const iv = setInterval(() => { void tick().catch((err) => console.warn('[jobs] tick failed:', (err as Error).message)); }, TICK_MS);
  iv.unref?.();
}
