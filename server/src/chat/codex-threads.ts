import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SeqEvent } from './runner.ts';

/** A log event as it comes back from the durable store. `eng` records which
 *  engine produced it. Events this process emitted are still in the in-memory
 *  buffer unstamped — provenance is added to the persisted copy — so only a
 *  stamp that DISAGREES disqualifies an event. */
type StampedEvent = SeqEvent & { eng?: string };

/**
 * Recover this engine's own most recent native thread id from a session's
 * event log.
 *
 * An agent home thread keeps ONE engine-neutral durable log (threadKey.ts), so
 * a Claude or Grok turn's `session_id` sits in the same array as Codex's.
 * Native provider session ids are engine-specific: handing a foreign one to
 * `thread/resume` kills the turn with "no rollout found for thread id …", and
 * persisting it poisons the lane for every later turn on that thread.
 */
export function latestThreadIdFromEvents(
  events: ReadonlyArray<StampedEvent>,
  cli: string,
): string | null {
  let threadId: string | null = null;
  for (const se of events) {
    if (typeof se.eng === 'string' && se.eng && se.eng !== cli) continue;
    const ev = se.ev;
    if (ev.type === 'turnEnd' && typeof ev.sessionId === 'string') {
      threadId = ev.sessionId;
      continue;
    }
    if (ev.type !== 'event') continue;
    const inner = ev.event;
    if (!inner || typeof inner !== 'object') continue;
    if (inner.type === 'system' && inner.subtype === 'init' && typeof inner.session_id === 'string') {
      threadId = inner.session_id;
      continue;
    }
    if (inner.type === 'result' && typeof inner.session_id === 'string') {
      threadId = inner.session_id;
    }
  }
  return threadId;
}

/** Where the codex CLI keeps its rollouts for the account this turn bills. */
export function codexHomeFor(env: NodeJS.ProcessEnv): string {
  const explicit = typeof env.CODEX_HOME === 'string' ? env.CODEX_HOME.trim() : '';
  return explicit || join(homedir(), '.codex');
}

/** Cap on directory entries one lookup may read, so a huge rollout store can
 *  never stall a turn. Exceeding it makes the answer inconclusive, never a
 *  false "missing". */
const SCAN_BUDGET = 20_000;

/**
 * True only when we PROVED codex has no rollout for `threadId`.
 *
 * `thread/resume` against a rollout codex has pruned (or never wrote) fails the
 * whole turn before a single token, so a turn that is about to resume checks
 * first and starts a fresh thread with recovered context instead. Every
 * uncertain answer is `false`: an unreadable store, a scan over budget, or a
 * layout we don't recognise (no `rollout-*.jsonl` seen at all) must not discard
 * a thread id that may be perfectly live.
 */
export async function codexRolloutMissing(codexHome: string, threadId: string): Promise<boolean> {
  if (!threadId) return false;
  let budget = SCAN_BUDGET;
  let sawAnyRollout = false;
  // true = found, false = not in this subtree, null = inconclusive.
  // The walk is async so a huge rollout store can never stall the event loop
  // (and with it every HTTP/WebSocket turn) mid-lookup.
  const walk = async (dir: string): Promise<boolean | null> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    // Rollout paths are date-ordered (sessions/YYYY/MM/DD/rollout-<ts>-<id>),
    // so newest-first finds a live thread in the first few reads.
    entries.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
    for (const entry of entries) {
      if (budget-- <= 0) return null;
      if (entry.isDirectory()) {
        const found = await walk(join(dir, entry.name));
        if (found !== false) return found;
        continue;
      }
      if (!entry.isFile()) continue;
      // `.jsonl` and codex's compressed `.jsonl.zst` are both live rollouts.
      if (!entry.name.startsWith('rollout-') || !entry.name.includes('.jsonl')) continue;
      sawAnyRollout = true;
      if (entry.name.includes(threadId)) return true;
    }
    return false;
  };
  const result = await walk(join(codexHome, 'sessions'));
  if (result !== false) return false;
  return sawAnyRollout;
}
