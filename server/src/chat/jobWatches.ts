// Background job watches — wake an agent when a long job resolves.
//
// An agent hands TARDIS exactly one of a pid (its own nohup'd job), a file
// (should appear or grow), or a command (the server runs it detached). When
// it resolves, TARDIS delivers a message into that agent's own home thread
// as a normal turn, the same delivery path a routine uses — works for every
// engine (claude, codex, zai, xai, banana). Watches persist in
// ~/.rivendell/job-watches.json and re-arm after a TARDIS restart. A command
// spawned by an earlier server process degrades honestly to its persisted
// pid (exit code unknown) — unless its exit was already recorded, in which
// case the recorded outcome survives the restart and delivers as-is.
//
// No new privilege is granted: pid/file watching is read-only, and `command`
// runs with the same shell power the agent's own session already has on
// this host.

import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { statSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { JsonStore } from '../lib/jsonStore.ts';
import { listAgents } from './agents.ts';
import { sendToAgentHome } from './teamBus.ts';

export type JobWatchKind = 'pid' | 'file' | 'command';

export type JobWatch = {
  id: string;
  createdAt?: string;
  updatedAt?: string;
  agentId: string;
  /** Short label for the wake message, e.g. "scanner build". */
  note: string;
  kind: JobWatchKind;
  pid?: number;
  file?: string;
  command?: string;
  /** Minutes; the wake says "timed out" after this. */
  timeoutMin: number;
  /** ms epoch deadline. */
  deadline: number;
  /** file watches: size when the watch started; null = file absent. */
  baselineSize?: number | null;
  /** command watches: the server already spawned it. */
  spawned?: boolean;
  /** Linux /proc starttime of the watched pid, captured at arm time — the
   *  cheap pid-reuse guard: a reused pid no longer matches, so the wake
   *  resolves honestly instead of following an unrelated process. */
  pidStart?: number | null;
  /** Set once the job resolved but the wake could not land yet (busy lane).
   *  The tick retries this exact text so retries and restarts never re-derive
   *  or degrade the outcome. */
  resolvedText?: string;
};

const store = new JsonStore<JobWatch>('job-watches.json', []);

const MIN_TIMEOUT_MIN = 1;
const MAX_TIMEOUT_MIN = 24 * 60;
const TICK_MS = 10_000;
/** Delivery retry cooldown after an admission failure. */
const RETRY_MS = 60_000;
/** Drop an undeliverable wake well after its own timeout rather than
 *  retrying forever. */
const UNDELIVERABLE_GRACE_MS = 2 * 60 * 60_000;

/** Live children for command watches this process spawned. The 'exit' event
 *  fires while this process lives; after a restart the tick degrades to the
 *  persisted pid. */
const children = new Map<string, ChildProcess>();
/** Watches currently delivering (tick + exit listeners). One resolution,
 *  one wake — the set add is synchronous, so the paths cannot double-fire. */
const delivering = new Set<string>();
/** Delivery retry cooldowns after admission failures. */
const retryUntil = new Map<string, number>();

// All store mutations are read-modify-write, so they run one at a time.
let mutations: Promise<unknown> = Promise.resolve();
function serialize<T>(op: () => Promise<T>): Promise<T> {
  const run = mutations.then(op, op);
  mutations = run.then(() => {}, () => {});
  return run;
}

export function listJobWatches(): Promise<JobWatch[]> {
  return store.list();
}

/** Watches with agent names (panel / GET route). */
export async function jobWatchesWithAgents(): Promise<Array<JobWatch & { agentName: string }>> {
  const names = new Map(listAgents().map((a) => [a.id, a.name]));
  const watches = await store.list();
  return watches.filter((w) => names.has(w.agentId)).map((w) => ({ ...w, agentName: names.get(w.agentId) ?? '' }));
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'; // exists, not ours
  }
}

/** /proc/<pid>/stat starttime (field 22). null when /proc cannot answer
 *  (non-Linux), which falls back to existence-only checking. */
function pidStart(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm can contain spaces and parens; everything after the last ')' is
    // whitespace-split fields, where fields[0] is state (field 3).
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const start = Number(fields[19]);
    return Number.isFinite(start) && start > 0 ? start : null;
  } catch {
    return null;
  }
}

/** Alive AND still the same process we armed (start guard when known). */
function pidMatches(pid: number, start: number | null | undefined): boolean {
  if (!pidAlive(pid)) return false;
  if (start == null) return true;
  return pidStart(pid) === start;
}

function exitText(code: number | null, signal: NodeJS.Signals | null): string {
  return `finished: exit ${code ?? 'unknown'}${signal ? ` (signal ${signal})` : ''}`;
}

export type CreateJobWatchInput = {
  agentId: string;
  note: unknown;
  pid?: unknown;
  file?: unknown;
  command?: unknown;
  timeoutMin?: unknown;
};

/** Create a watch. Exactly one of pid | file | command. Throws Error with a
 *  plain reason on bad input (the route maps it to 4xx). */
export async function createJobWatch(input: CreateJobWatchInput): Promise<JobWatch> {
  if (!listAgents().some((a) => a.id === input.agentId)) throw new Error('unknown agentId');
  const note = String(input.note ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
  if (!note) throw new Error('note is required (a short label for the wake message)');
  const picked = (['pid', 'file', 'command'] as const).filter((key) => input[key] !== undefined && input[key] !== null && String(input[key]).trim() !== '');
  if (picked.length !== 1) throw new Error('pass exactly one of pid, file, or command');
  let timeoutMin = 60;
  if (input.timeoutMin !== undefined && input.timeoutMin !== null && String(input.timeoutMin).trim() !== '') {
    const raw = Number(input.timeoutMin);
    if (!Number.isFinite(raw) || raw < MIN_TIMEOUT_MIN || raw > MAX_TIMEOUT_MIN) {
      throw new Error(`timeoutMin must be ${MIN_TIMEOUT_MIN}-${MAX_TIMEOUT_MIN} minutes`);
    }
    timeoutMin = Math.round(raw);
  }
  const deadline = Date.now() + timeoutMin * 60_000;

  if (picked[0] === 'pid') {
    const pid = Number(input.pid);
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('pid must be a positive integer');
    if (!pidAlive(pid)) throw new Error(`process ${pid} has already exited — there is nothing left to watch`);
    return serialize(() => store.create({
      agentId: input.agentId, note, kind: 'pid' as const, pid, pidStart: pidStart(pid), timeoutMin, deadline,
    }));
  }

  if (picked[0] === 'file') {
    const file = String(input.file).trim();
    if (!isAbsolute(file)) throw new Error('file must be an absolute path on this host');
    let baselineSize: number | null;
    try {
      baselineSize = statSync(file).size;
    } catch {
      baselineSize = null; // absent: resolve when it appears
    }
    return serialize(() => store.create({
      agentId: input.agentId, note, kind: 'file' as const, file, timeoutMin, deadline, baselineSize,
    }));
  }

  // command: the server runs it detached right now.
  const command = String(input.command).trim();
  if (!command) throw new Error('command must be a shell command');
  const child = spawn(command, { shell: true, detached: true, stdio: 'ignore' });
  // With shell:true spawn() itself almost never fails synchronously (sh -c
  // gets the pid); a spawn failure surfaces via 'error' with pid undefined.
  if (typeof child.pid !== 'number') throw new Error('the command could not be started');
  // Listen IMMEDIATELY: a fast command can exit while the record is still
  // being written (the exit event would fire with no listener and be lost),
  // and an unlistened 'error' would crash the process. The outcome is
  // buffered and resolved once the record is durable.
  let buffered: string | null = null;
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => { buffered = exitText(code, signal); };
  const onError = (err: Error) => { buffered = `failed to run: ${err.message}`; };
  child.once('exit', onExit);
  child.once('error', onError);
  const pid = child.pid;
  const start = pidStart(pid);
  const id = randomUUID();
  try {
    const created = await serialize(() => store.create({
      id, agentId: input.agentId, note, kind: 'command' as const, command, pid, pidStart: start, timeoutMin, deadline, spawned: true,
    }));
    if (buffered === null) {
      // Not exited yet: swap the buffer listeners for the durable arm. If the
      // exit event is queued but undispatched, it lands on the new listener.
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      armChild(created.id, child);
    } else {
      // Already exited during the write: nothing left to arm, resolve now.
      void resolveWatchById(created.id, buffered);
    }
    return created;
  } catch (err) {
    // Persistence failed: no watch will ever wake for this command, so don't
    // leave it running untracked. Kill the detached process group.
    child.removeListener('exit', onExit);
    child.removeListener('error', onError);
    try { process.kill(-pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* already gone */ } }
    throw err;
  }
}


/** Command child: listen for exit while this process lives. */
function armChild(id: string, child: ChildProcess): void {
  children.set(id, child);
  child.once('exit', (code, signal) => {
    children.delete(id);
    void resolveWatchById(id, exitText(code, signal));
  });
  child.once('error', (err) => {
    children.delete(id);
    void resolveWatchById(id, `failed to run: ${err.message}`);
  });
  child.unref();
}

/** Resolve a persisted watch by id (exit-listener path). */
async function resolveWatchById(id: string, outcome: string): Promise<void> {
  const watch = (await store.list()).find((w) => w.id === id);
  if (!watch) return; // deleted meanwhile: nothing to say
  await deliverWake(watch, outcome);
}

/** Cascade: an agent's watches die with it (no ghost retry loops). */
export async function deleteJobWatchesForAgent(agentId: string): Promise<void> {
  await serialize(async () => {
    const watches = await store.list();
    await store.replace(watches.filter((w) => w.agentId !== agentId));
  });
}

export async function deleteJobWatch(id: string): Promise<boolean> {
  return serialize(() => store.delete(id));
}

/** Fresh resolution detail for a watch on this tick, or null to keep
 *  waiting. A resolvedText already on the record skips this entirely. */
function checkWatch(watch: JobWatch, now: number): string | null {
  if (now >= watch.deadline) {
    return `timed out after ${watch.timeoutMin}m. The watch gave up — check the job yourself; nothing further will arrive.`;
  }
  if (watch.kind === 'pid' && typeof watch.pid === 'number') {
    if (pidMatches(watch.pid, watch.pidStart)) return null;
    if (pidAlive(watch.pid)) return `finished: process ${watch.pid} exited (its pid was reused by another process)`;
    return `finished: process ${watch.pid} exited`;
  }
  if (watch.kind === 'file' && watch.file) {
    try {
      const size = statSync(watch.file).size;
      if (watch.baselineSize == null) return `finished: file ${watch.file} appeared (${fmtBytes(size)})`;
      if (size > watch.baselineSize) return `finished: file ${watch.file} grew from ${fmtBytes(watch.baselineSize)} to ${fmtBytes(size)}`;
      return null;
    } catch {
      return null; // absent or unreadable: the timeout bounds the wait
    }
  }
  if (watch.kind === 'command' && watch.spawned && !children.has(watch.id)) {
    // Restarted server (or the child already drained): no live child handle.
    // resolvedText carries the real outcome when there was one.
    if (typeof watch.pid === 'number' && !pidMatches(watch.pid, watch.pidStart)) {
      return `finished: the process exited. Exit code unknown — the server restarted while the job ran.`;
    }
    return null;
  }
  return null;
}

/** One resolution → one wake, then the watch is removed. On delivery failure
 *  (agent busy past the 30-minute admission wait, engine down) the outcome
 *  is persisted and retried every RETRY_MS; UNDELIVERABLE_GRACE past the
 *  deadline it is dropped with a log line so it can never loop forever. */
async function deliverWake(watch: JobWatch, outcome: string): Promise<boolean> {
  if (delivering.has(watch.id)) return false;
  delivering.add(watch.id);
  try {
    const agent = listAgents().find((a) => a.id === watch.agentId);
    if (!agent) {
      console.warn(`[job-watches] ${watch.note}: agent was deleted; dropping the wake`);
      await serialize(() => store.delete(watch.id));
      return false;
    }
    // Persist the outcome BEFORE the delivery attempt: sendToAgentHome can
    // wait for an admission boundary for up to 30 minutes, and a restart
    // during that window must not lose the real exit code to the degraded
    // unknown-code path.
    if (watch.resolvedText !== outcome) {
      await serialize(() => store.update(watch.id, { resolvedText: outcome }));
      watch = { ...watch, resolvedText: outcome };
    }
    const detail = watch.kind === 'command' && watch.command
      ? `command: ${watch.command.slice(0, 120)}`
      : watch.kind === 'file' && watch.file ? `file: ${watch.file}` : `pid: ${watch.pid}`;
    const text = [
      `[job: ${watch.note}] Your job "${watch.note}" ${outcome}`,
      `(${detail})`,
      'Background job wake from watch_job. If the result matters, check it now — this wake is the only notification.',
    ].join('\n');
    const result = await sendToAgentHome(agent, text, {
      peerFrom: `⏱ ${watch.note}`,
      peerFromRole: 'automation',
      peerText: `job: ${watch.note}`,
    });
    if (result.delivered) {
      await serialize(() => store.delete(watch.id));
      console.log(`[job-watches] ${watch.note} → woke ${agent.name}: ${outcome}`);
      return true;
    }
    if (Date.now() > watch.deadline + UNDELIVERABLE_GRACE_MS) {
      console.warn(`[job-watches] ${watch.note}: wake undeliverable (${result.reason}); dropping`);
      await serialize(() => store.delete(watch.id));
      return false;
    }
    // resolvedText is already persisted above; the tick retries it.
    retryUntil.set(watch.id, Date.now() + RETRY_MS);
    console.warn(`[job-watches] ${watch.note}: wake not delivered (${result.reason}); will retry`);
    return false;
  } finally {
    delivering.delete(watch.id);
  }
}

/** Watch loop — started once at boot. */
export function startJobWatchScheduler(): void {
  const tick = async () => {
    let watches: JobWatch[];
    try {
      watches = await store.list();
    } catch (err) {
      console.warn('[job-watches] store unreadable:', (err as Error).message);
      return;
    }
    const now = Date.now();
    for (const watch of watches) {
      if (delivering.has(watch.id) || (retryUntil.get(watch.id) ?? 0) > now) continue;
      const outcome = watch.resolvedText ?? checkWatch(watch, now);
      if (outcome) void deliverWake(watch, outcome);
    }
  };
  const iv = setInterval(() => { void tick(); }, TICK_MS);
  iv.unref?.();
}
