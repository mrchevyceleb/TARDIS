// Restart auto-wake (card-489107).
//
// A service restart kills every turn in flight. On the way down the running
// server already writes a restart tombstone into each busy lane's durable
// thread log (chat/crashTombstone.ts: an assistant event tagged
// `_serviceRestart`), which tells the agent "your turn was killed, re-check" the
// next time it runs. Nothing made it run: lanes sat idle until a person messaged
// each one (Sep 30 13:37, four lanes, about nine minutes).
//
// So, once after boot, look at each roster agent's thread log. A lane whose log
// ends in a tombstone with no activity since was cut and has not resumed: wake
// it with one short handoff. The tombstone is the only record used, so this
// works on the first restart that loads it, needs nothing written at shutdown,
// and cannot repeat: the wake itself starts a turn, and that turn's events end
// the "unanswered" state. Lanes whose tombstone is older than this boot's window, or that are
// already running again, are left alone.
//
// RIVENDELL_RESTART_WAKE=off disables it; RIVENDELL_RESTART_WAKE_DRY_RUN=1 logs
// the would-be wakes instead of delivering. The sent-set lives in
// ~/.rivendell/restart-wakes.json (RIVENDELL_RESTART_WAKE_FILE overrides).

import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { STATE_DIR } from '../config.ts';

/** Sessions register a few seconds after boot; the first look waits for that. */
const FIRST_RUN_MS = 25_000;
/** A tombstone written longer than this before the boot is an old restart, not
 *  the one that just happened (the bounce itself takes seconds). */
const TOMBSTONE_MAX_AGE_MS = 15 * 60_000;
/** The tombstone sits at the end of the log; anything that resumed the lane
 *  since is after it, so a tail is enough. Generous, because events queued
 *  before the kill can still be flushed behind the tombstone (if it has still
 *  scrolled out, the lane has run a lot since and is resumed). */
const TAIL_BYTES = 4 * 1024 * 1024;
/** The kill itself writes a few rows (result, turn end, interrupted, background
 *  notes) within a couple of seconds of the tombstone. A row later than this is
 *  the lane being used again, whatever engine wrote it (not every engine writes
 *  a turn-start row). Rows stamped at or after this process's boot are the new
 *  process's by definition and count at any distance. */
const SETTLE_MS = 10_000;
/** Sent-set entries are forgotten after this. */
const SENT_KEEP_MS = 24 * 60 * 60_000;
/** Spacing between wakes, so a restart that cut many lanes stays well inside
 *  the team bus's shared per-minute handoff budget (20 a minute for everyone). */
const WAKE_SPACING_MS = 2_000;
const RETRY_SPACING_MS = 20_000;
const MAX_TRIES = 3;
const TIME_ZONE = 'America/New_York';

export type WakeAgent = { id: string; name: string; home: string };
export type WakeDelivery = { delivered: boolean; reason?: string };

export type WakeDeps = {
  now: () => number;
  /** When this process started; a tombstone must predate it by less than the max age. */
  bootMs: number;
  listAgents: () => WakeAgent[] | Promise<WakeAgent[]>;
  /** Time of the restart tombstone that ends this agent's log with no turn since, or null. */
  cutAt: (agent: WakeAgent) => number | null | Promise<number | null>;
  /** Ground truth for one agent right now: a turn running, a delivery queued for it, or neither. */
  laneStatus: (agent: WakeAgent) => 'working' | 'queued' | 'idle' | Promise<'working' | 'queued' | 'idle'>;
  /** Which (agent, tombstone) pairs already got their wake, across restarts. */
  sent: { has: (key: string) => boolean; add: (key: string) => void };
  deliver: (message: { to: string; text: string }) => Promise<WakeDelivery>;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  dryRun: boolean;
};

export type WakeReport = { woken: string[]; skipped: string[]; failed: string[]; note?: string };

const OFF_VALUES = new Set(['off', '0', 'false', 'no']);
const ON_VALUES = new Set(['1', 'true', 'yes', 'on']);

export function restartWakeEnabled(): boolean {
  return !OFF_VALUES.has((process.env.RIVENDELL_RESTART_WAKE ?? '').trim().toLowerCase());
}

function restartWakeDryRun(): boolean {
  return ON_VALUES.has((process.env.RIVENDELL_RESTART_WAKE_DRY_RUN ?? '').trim().toLowerCase());
}

// ---- reading the tombstone --------------------------------------------------------

export type CutReadOptions = { bootMs?: number; tailBytes?: number };

/** Time of the restart tombstone that ends this event log with no activity
 *  since, or null (no tombstone, or the lane has been used again). Reads only
 *  the tail. `bootMs` is when the current process started: a row stamped at or
 *  after it was written by the new process. */
export function unansweredRestartCutAt(file: string, opts: CutReadOptions = {}): number | null {
  const tailBytes = opts.tailBytes ?? TAIL_BYTES;
  const bootMs = opts.bootMs ?? Number.POSITIVE_INFINITY;
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - tailBytes);
    const length = size - start;
    const buf = Buffer.alloc(length);
    let got = 0;
    // A read may return fewer bytes than asked; keep going until the range is full.
    while (got < length) {
      const n = readSync(fd, buf, got, length - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    let text = buf.toString('utf8', 0, got);
    // A tail that starts mid-file starts mid-line; drop the partial one.
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    let cutAt: number | null = null;
    for (const line of text.split('\n')) {
      if (!line) continue;
      const marked = line.includes('"_serviceRestart"');
      // Before any tombstone nothing needs reading; after one, each row's time says
      // whether it is the kill settling or the lane being used again.
      if (!marked && cutAt === null) continue;
      let row: { at?: unknown; ev?: { event?: { _serviceRestart?: unknown } } };
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (marked && row.ev?.event?._serviceRestart === true && typeof row.at === 'number') cutAt = row.at;
      else if (cutAt !== null && typeof row.at === 'number' && (row.at >= bootMs || row.at > cutAt + SETTLE_MS)) cutAt = null;
    }
    return cutAt;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

async function cutAtFromLog(agent: WakeAgent, bootMs: number): Promise<number | null> {
  const [{ EVENT_LOG_DIR, sanitizeKey }, { threadLogKey }, { ASSISTANT_HUB_PATH }] = await Promise.all([
    import('../chat/event-log-store.ts'),
    import('../chat/threadKey.ts'),
    import('../chat/config.ts'),
  ]);
  return unansweredRestartCutAt(join(EVENT_LOG_DIR, `${sanitizeKey(threadLogKey(ASSISTANT_HUB_PATH, agent.home))}.jsonl`), { bootMs });
}

// ---- waking -----------------------------------------------------------------------

function etClock(ms: number): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
}

export function wakeText(cutAt: number): string {
  return [
    `TARDIS restarted at ${etClock(cutAt)} ET and cut your turn off mid-work.`,
    'Re-check where you were (your thread, your Desk cards, anything you had running), then carry on with what is left.',
    'If you were answering a person, finish answering them.',
    'If nothing is left to do, reply with exactly NO_UPDATE.',
  ].join(' ');
}

function sentFile(): string {
  return process.env.RIVENDELL_RESTART_WAKE_FILE?.trim() || join(STATE_DIR, 'restart-wakes.json');
}

/** File-backed set of "<agent>@<tombstone time>" keys. Any read or write problem
 *  fails open: the worst case is one extra wake, never a missed one. */
export function fileSentSet(file: string = sentFile(), now: () => number = Date.now): WakeDeps['sent'] {
  let cache: Record<string, number> | null = null;
  const load = (): Record<string, number> => {
    if (cache) return cache;
    cache = {};
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown; sent?: Record<string, unknown> };
      if (parsed.version === 1 && parsed.sent && typeof parsed.sent === 'object') {
        for (const [key, at] of Object.entries(parsed.sent)) if (typeof at === 'number' && now() - at < SENT_KEEP_MS) cache[key] = at;
      }
    } catch {
      // missing or unreadable: start empty
    }
    return cache;
  };
  return {
    has: (key) => key in load(),
    add: (key) => {
      const sent = load();
      sent[key] = now();
      try {
        mkdirSync(dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, `${JSON.stringify({ version: 1, sent })}\n`, { encoding: 'utf8', mode: 0o600 });
        renameSync(tmp, file);
      } catch {
        // the in-memory set still stops a repeat within this process
      }
    },
  };
}

function defaultDeps(): WakeDeps {
  const bootMs = Date.now() - Math.round(process.uptime() * 1000);
  return {
    now: () => Date.now(),
    bootMs,
    listAgents: async () => (await import('../chat/agents.ts')).listAgents(),
    cutAt: (agent) => cutAtFromLog(agent, bootMs),
    // The team roster's own view (workspace-aware, and it counts deliveries still
    // queued for the lane), the same one team_status reports.
    laneStatus: async (agent) => {
      const { teamRoster } = await import('../chat/teamBus.ts');
      return (await teamRoster()).find((row) => row.id === agent.id)?.status ?? 'idle';
    },
    sent: fileSentSet(),
    deliver: async ({ to, text }) => {
      const { deliverTeamMessage } = await import('../chat/teamBus.ts');
      // A plain named sender (never source 'desk', the human owner): it lands as
      // a teammate handoff, the same path the Desk hygiene nudges use.
      return deliverTeamMessage({ from: 'TARDIS', to, text, wait: false });
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (line) => console.log(line),
    dryRun: restartWakeDryRun(),
  };
}

/** One pass over the roster. Tests and the proof harness pass their own deps. */
export async function runRestartWake(overrides: Partial<WakeDeps> = {}): Promise<WakeReport> {
  const deps = { ...defaultDeps(), ...overrides };
  const report: WakeReport = { woken: [], skipped: [], failed: [] };
  const cut: { agent: WakeAgent; at: number }[] = [];
  for (const agent of await deps.listAgents()) {
    if (agent.id === 'owner' || !agent.home) continue;
    const at = await deps.cutAt(agent);
    if (at === null) continue;
    if (deps.bootMs - at > TOMBSTONE_MAX_AGE_MS || at > deps.now()) {
      deps.log(`[restart-wake] ${agent.id}: restart marker from ${etClock(at)} ET is not from this restart, not waking`);
      continue;
    }
    cut.push({ agent, at });
  }
  if (!cut.length) {
    report.note = 'no lane was left cut';
    return report;
  }
  deps.log(`[restart-wake] ${cut.length} agent lane${cut.length === 1 ? '' : 's'} cut mid-turn and not resumed: ${cut.map((c) => c.agent.id).join(', ')}`);

  for (const [index, { agent, at }] of cut.entries()) {
    if (index > 0) await deps.sleep(WAKE_SPACING_MS);
    const sentKey = `${agent.id}@${at}`;
    if (deps.sent.has(sentKey)) {
      report.skipped.push(agent.id);
      deps.log(`[restart-wake] ${agent.id}: already woken for the ${etClock(at)} ET restart, not waking again`);
      continue;
    }
    const text = wakeText(at);
    if (deps.dryRun) {
      report.woken.push(agent.id);
      deps.log(`[restart-wake] dry run, would wake ${agent.id}: ${text}`);
      continue;
    }
    let result: WakeDelivery = { delivered: false, reason: 'not tried' };
    let resumed = false;
    for (let attempt = 1; attempt <= MAX_TRIES; attempt += 1) {
      if (attempt > 1) await deps.sleep(RETRY_SPACING_MS);
      // Looked at again before every attempt: the lane may have picked up work
      // (or had a delivery queued for it) while this pass paced, or while a retry waited.
      if ((await deps.laneStatus(agent)) !== 'idle' || (await deps.cutAt(agent)) !== at) {
        resumed = true;
        break;
      }
      try {
        result = await deps.deliver({ to: agent.id, text });
      } catch (error) {
        result = { delivered: false, reason: (error as Error).message };
      }
      if (result.delivered) break;
    }
    if (resumed) {
      report.skipped.push(agent.id);
      deps.log(`[restart-wake] ${agent.id}: running again on its own, not waking`);
    } else if (result.delivered) {
      deps.sent.add(sentKey);
      report.woken.push(agent.id);
      deps.log(`[restart-wake] woke ${agent.id}`);
    } else {
      report.failed.push(agent.id);
      deps.log(`[restart-wake] could not wake ${agent.id}: ${result.reason ?? 'unknown reason'}`);
    }
  }
  return report;
}

let started = false;

/** Schedules the one post-boot wake pass. */
export function startRestartWake(): boolean {
  if (started) return true;
  if (!restartWakeEnabled()) {
    console.log('[restart-wake] off (RIVENDELL_RESTART_WAKE=off): lanes cut by a restart are not woken');
    return false;
  }
  started = true;
  setTimeout(() => {
    void runRestartWake().catch((error) => console.warn(`[restart-wake] failed: ${(error as Error).message}`));
  }, FIRST_RUN_MS).unref();
  if (restartWakeDryRun()) console.log('[restart-wake] dry run: wakes are logged, not delivered');
  return true;
}
