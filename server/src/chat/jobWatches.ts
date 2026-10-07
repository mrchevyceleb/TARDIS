// Background job watches — wake an agent when a long job resolves.
//
// An agent hands TARDIS exactly one of a pid (its own nohup'd job), a file
// (should appear or grow), or a command (the server runs it detached). When
// it resolves, TARDIS delivers a message into that agent's own home thread
// as a normal turn, the same delivery path a routine uses — works for every
// engine (claude, codex, zai, xai, banana). Watches persist in
// ~/.rivendell/job-watches.json and re-arm after a TARDIS restart. A command
// runs in its own systemd scope (see launchWatchCommand), so a restart of the
// service does not kill it. A command spawned by an earlier server process
// degrades honestly to its persisted pid (exit code unknown) — unless its
// exit was already recorded, in which case the recorded outcome survives the
// restart and delivers as-is.
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
  /** Lane that armed the watch; the wake returns there. Absent → background. */
  lane?: 'main' | 'bg';
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

/** /proc/<pid>/stat starttime (field 22, clock ticks since boot — pid 1
 *  legitimately reads 0). null when /proc cannot answer (non-Linux), which
 *  falls back to existence-only checking. */
export function pidStart(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm can contain spaces and parens; everything after the last ')' is
    // whitespace-split fields, where fields[0] is state (field 3), so
    // starttime (field 22) is fields[19].
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const start = Number(fields[19]);
    return Number.isFinite(start) && start >= 0 ? start : null;
  } catch {
    return null;
  }
}

/** Alive AND still the same process we armed (start guard when known). */
export function pidMatches(pid: number, start: number | null | undefined): boolean {
  if (!pidAlive(pid)) return false;
  if (start == null) return true;
  return pidStart(pid) === start;
}

function exitText(code: number | null, signal: NodeJS.Signals | null): string {
  // Killed by a signal: the watching command died, which says nothing about the
  // job it was watching. Never call that "finished".
  if (code === null) {
    return `was NOT reported finished: the command watching it was stopped${signal ? ` (signal ${signal})` : ''}, so its state is unknown and it may still be running. Check it, and re-arm the watch if you still need the wake.`;
  }
  return `finished: exit ${code}`;
}

let scopeProbe: Promise<boolean> | null = null;
/** Whether a command can be started in its own transient systemd scope. Probed
 *  once, off the event loop: a scope needs the user manager's bus, which not
 *  every host has. (--expand-environment=no keeps the shell program from being
 *  rewritten by systemd; an older systemd that lacks it fails the probe and
 *  falls back to the plain spawn.) */
export function canLaunchInScope(): Promise<boolean> {
  scopeProbe ??= new Promise<boolean>((resolve) => {
    try {
      const probe = spawn('systemd-run', ['--user', '--scope', '--quiet', '--collect', '--expand-environment=no', 'true'], { stdio: 'ignore' });
      const timer = setTimeout(() => { try { probe.kill('SIGKILL'); } catch { /* gone */ } resolve(false); }, 5000);
      timer.unref?.();
      probe.once('error', () => { clearTimeout(timer); resolve(false); });
      probe.once('exit', (code) => { clearTimeout(timer); resolve(code === 0); });
    } catch {
      resolve(false);
    }
  });
  return scopeProbe;
}

/** Start a watch command detached. Under systemd it goes into its own scope
 *  (systemd-run execs the shell in place, so the pid is the shell's), which
 *  keeps it outside rivendell.service's cgroup: a service restart used to kill
 *  every watcher (KillMode=control-group) and wake the agent with a SIGTERM
 *  for a job that was still running. */
function launchWatchCommand(command: string, scoped: boolean): ChildProcess {
  if (!scoped) return spawn(command, { shell: true, detached: true, stdio: 'ignore' });
  const startedAt = Date.now();
  const child = spawn('systemd-run', ['--user', '--scope', '--quiet', '--collect', '--expand-environment=no', '--unit', `tardis-watch-${randomUUID().slice(0, 8)}`, '/bin/sh', '-c', command], { detached: true, stdio: 'ignore' });
  // A scope that fails to register exits 1 within moments. Probe again on the
  // next launch instead of trusting the earlier answer forever.
  child.once('exit', (code) => { if (code === 1 && Date.now() - startedAt < 2000) scopeProbe = null; });
  return child;
}

export type CreateJobWatchInput = {
  agentId: string;
  lane?: unknown;
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
  if (typeof input.note !== 'string') throw new Error('note is required (a short label for the wake message)');
  const note = input.note.trim().replace(/\s+/g, ' ').slice(0, 120);
  if (!note) throw new Error('note is required (a short label for the wake message)');
  // Selection is by PRESENCE, then the present one is type-checked: a
  // malformed sibling selector (pid as a string next to a valid file) is
  // rejected instead of being silently ignored.
  const present = (['pid', 'file', 'command'] as const).filter((key) => input[key] !== undefined);
  if (present.length !== 1) throw new Error('pass exactly one of pid, file, or command');
  const target = present[0];
  if (input.timeoutMin !== undefined
    && (typeof input.timeoutMin !== 'number' || !Number.isSafeInteger(input.timeoutMin) || input.timeoutMin < MIN_TIMEOUT_MIN || input.timeoutMin > MAX_TIMEOUT_MIN)) {
    throw new Error(`timeoutMin must be an integer ${MIN_TIMEOUT_MIN}-${MAX_TIMEOUT_MIN} minutes`);
  }
  const timeoutMin: number = typeof input.timeoutMin === 'number' ? input.timeoutMin : 60;
  const deadline = Date.now() + timeoutMin * 60_000;

  if (target === 'pid') {
    if (typeof input.pid !== 'number' || !Number.isSafeInteger(input.pid) || input.pid <= 0) throw new Error('pid must be a positive integer');
    const pid = input.pid;
    if (!pidAlive(pid)) throw new Error(`process ${pid} has already exited — there is nothing left to watch`);
    return serialize(() => store.create({
      agentId: input.agentId, lane: input.lane === 'main' ? 'main' as const : 'bg' as const, note, kind: 'pid' as const, pid, pidStart: pidStart(pid), timeoutMin, deadline,
    }));
  }

  if (target === 'file') {
    if (typeof input.file !== 'string' || !input.file.trim()) throw new Error('file must be an absolute path on this host');
    const file = input.file.trim();
    if (!isAbsolute(file)) throw new Error('file must be an absolute path on this host');
    let baselineSize: number | null;
    try {
      baselineSize = statSync(file).size;
    } catch {
      baselineSize = null; // absent: resolve when it appears
    }
    return serialize(() => store.create({
      agentId: input.agentId, lane: input.lane === 'main' ? 'main' as const : 'bg' as const, note, kind: 'file' as const, file, timeoutMin, deadline, baselineSize,
    }));
  }

  // command: the server runs it detached right now.
  if (typeof input.command !== 'string' || !input.command.trim()) throw new Error('command must be a shell command');
  const command = input.command.trim();
  const scoped = await canLaunchInScope();
  const child = launchWatchCommand(command, scoped);
  // Listen IMMEDIATELY, before anything else: a spawn failure (EAGAIN/EMFILE,
  // no pid) emits an async 'error' that would crash the process with no
  // listener, and a fast command can exit while the record is still being
  // written. The outcome is buffered and resolved once the record is durable.
  let buffered: string | null = null;
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => { buffered = exitText(code, signal); };
  const onError = (err: Error) => { buffered = `failed to run: ${err.message}`; };
  child.once('exit', onExit);
  child.once('error', onError);
  if (typeof child.pid !== 'number') {
    // The async 'error' is already listened (nothing can resolve this watch);
    // nothing was started, so there is nothing to clean up.
    throw new Error('the command could not be started');
  }
  const pid = child.pid;
  const start = pidStart(pid);
  const id = randomUUID();
  try {
    const created = await serialize(() => store.create({
      id, agentId: input.agentId, lane: input.lane === 'main' ? 'main' as const : 'bg' as const, note, kind: 'command' as const, command, pid, pidStart: start, timeoutMin, deadline, spawned: true,
    }));
    if (buffered === null) {
      // Not exited yet: swap the buffer listeners for the durable arm. If the
      // exit event is queued but undispatched, it lands on the new listener.
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      armChild(created.id, child);
    } else {
      // Already exited during the write: nothing left to arm, resolve now.
      resolveWatchById(created.id, buffered);
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

/** One resolution → one wake. The gate is fully synchronous (the set add
 *  happens before any await), so the tick, the exit listeners, and the
 *  buffered path can never double-deliver or steal each other's outcome. */
function beginDelivery(id: string): boolean {
  if (delivering.has(id)) return false;
  delivering.add(id);
  return true;
}


/** Command child: listen for exit while this process lives. */
function armChild(id: string, child: ChildProcess): void {
  children.set(id, child);
  child.once('exit', (code, signal) => {
    children.delete(id);
    resolveWatchById(id, exitText(code, signal));
  });
  child.once('error', (err) => {
    children.delete(id);
    resolveWatchById(id, `failed to run: ${err.message}`);
  });
  child.unref();
}

/** Resolve a persisted watch by id (exit-listener / buffered path). Gated,
 *  self-catching, and never rejects unobserved. The FIRST recorded
 *  resolution owns the record: a command exit after a recorded timeout (or
 *  any later event) must not overwrite it — the timeout wake already told
 *  the agent to check the job itself, so "nothing further will arrive"
 *  stays true and one resolution stays one wake. */
function resolveWatchById(id: string, outcome: string): void {
  if (!beginDelivery(id)) return;
  void (async () => {
    try {
      const watch = (await store.list()).find((w) => w.id === id);
      if (watch && watch.resolvedText === undefined) await deliverWake(watch, outcome); // caller holds the gate
    } catch (err) {
      console.warn(`[job-watches] resolution for ${id} failed:`, (err as Error).message);
    } finally {
      delivering.delete(id);
    }
  })();
}

/** Terminal cleanup for a watch record: forget cooldowns and detach any
 *  in-memory child tracking (the job itself keeps running — only its
 *  listeners go, so a deleted watch can never resolve later, and no
 *  cooldown or child entry leaks forever). */
function forgetWatch(id: string): void {
  retryUntil.delete(id);
  const child = children.get(id);
  if (child) {
    children.delete(id);
    child.removeAllListeners('exit');
    child.removeAllListeners('error');
  }
}

/** Cascade: an agent's watches die with it (no ghost retry loops). */
export async function deleteJobWatchesForAgent(agentId: string): Promise<void> {
  await serialize(async () => {
    const watches = await store.list();
    const removed = watches.filter((w) => w.agentId === agentId);
    await store.replace(watches.filter((w) => w.agentId !== agentId));
    for (const w of removed) forgetWatch(w.id);
  });
}

export async function deleteJobWatch(id: string): Promise<boolean> {
  const deleted = await serialize(() => store.delete(id));
  if (deleted) forgetWatch(id);
  return deleted;
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

/** What the thread shows for a job wake: the outcome and last output, without
 *  the model-only boilerplate or the host log path. The model still gets the
 *  full text. The chat UI turns this into a job result card. */
export function visibleWakeText(text: string): string {
  // Only the generated trailer goes: the boilerplate line, then the log path
  // above it. Job output that happens to start the same way stays.
  const lines = text.split('\n');
  if (/^Background job (?:result|wake) from /.test(lines[lines.length - 1] ?? '')) lines.pop();
  if (/^Full log: /.test(lines[lines.length - 1] ?? '')) lines.pop();
  return lines.join('\n');
}

/** One resolution → one wake, then the watch is removed. On delivery failure
 *  (agent busy past the 30-minute admission wait, engine down) the outcome
 *  is persisted and retried every RETRY_MS; UNDELIVERABLE_GRACE past the
 *  deadline it is dropped with a log line so it can never loop forever.
 *
 *  The CALLER holds the delivery gate (beginDelivery) and clears it — the
 *  tick, resolveWatchById, and the buffered path all go through the same
 *  synchronous gate, so two paths can never deliver the same watch. This
 *  function never rejects: a bookkeeping failure logs and schedules a
 *  retry (resolvedText carries the outcome) instead of escaping as an
 *  unhandled rejection. */
async function deliverWake(watch: JobWatch, outcome: string): Promise<boolean> {
  try {
    const agent = listAgents().find((a) => a.id === watch.agentId);
    if (!agent) {
      console.warn(`[job-watches] ${watch.note}: agent was deleted; dropping the wake`);
      await serialize(() => store.delete(watch.id));
      forgetWatch(watch.id);
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
      peerText: visibleWakeText(text),
      lane: watch.lane === 'main' ? 'main' : 'bg',
    });
    if (result.delivered) {
      await serialize(() => store.delete(watch.id));
      forgetWatch(watch.id);
      console.log(`[job-watches] ${watch.note} → woke ${agent.name}: ${outcome}`);
      return true;
    }
    if (Date.now() > watch.deadline + UNDELIVERABLE_GRACE_MS) {
      console.warn(`[job-watches] ${watch.note}: wake undeliverable (${result.reason}); dropping`);
      await serialize(() => store.delete(watch.id));
      forgetWatch(watch.id);
      return false;
    }
    // resolvedText is already persisted above; the tick retries it.
    retryUntil.set(watch.id, Date.now() + RETRY_MS);
    console.warn(`[job-watches] ${watch.note}: wake not delivered (${result.reason}); will retry`);
    return false;
  } catch (err) {
    // Store bookkeeping failed mid-delivery: log it, keep the record
    // (resolvedText carries the outcome when its write landed), and let the
    // tick retry rather than escaping as an unhandled rejection.
    retryUntil.set(watch.id, Date.now() + RETRY_MS);
    console.warn(`[job-watches] ${watch.note}: delivery bookkeeping failed:`, (err as Error).message);
    return false;
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
      // Gate synchronously: checkWatch is cheap and sync, so no exit listener
      // can interleave between the resolution and the gate.
      if (outcome && beginDelivery(watch.id)) {
        void deliverWake(watch, outcome)
          .catch((err) => console.warn(`[job-watches] ${watch.note}: delivery failed:`, (err as Error).message))
          .finally(() => delivering.delete(watch.id));
      }
    }
  };
  const iv = setInterval(() => { void tick(); }, TICK_MS);
  iv.unref?.();
}
