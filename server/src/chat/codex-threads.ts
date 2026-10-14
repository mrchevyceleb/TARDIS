import type { Dirent } from 'node:fs';
import { opendir } from 'node:fs/promises';
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
  exclude?: ReadonlySet<string>,
): string | null {
  let threadId: string | null = null;
  for (const se of events) {
    // Positively-known provenance only: an unstamped event might belong to
    // any engine sharing this thread's log, and a foreign engine's session
    // id must never be recovered as ours (the log is engine-neutral; the
    // runner stamps its own events at emit, so unstamped means unknown).
    if (se.eng !== cli) continue;
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
  // A tombstoned latest id wins over any older fallback: the lane was
  // explicitly cleared for a fresh start, so nothing may be resurrected.
  if (threadId && exclude?.has(threadId)) return null;
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
    // Stream the directory instead of materializing a full listing: readdir
    // had already allocated every entry before the budget was ever checked,
    // so a huge rollout store could still spike memory and stall the read
    // despite the cap. opendir hands out one entry at a time, the budget is
    // consumed per streamed entry, and the bounded slice is still walked
    // newest-first.
    const entries: Dirent[] = [];
    let moreBeyondBudget = false;
    try {
      const handle = await opendir(dir);
      try {
        for (;;) {
          const entry = await handle.read();
          if (!entry) break;
          if (budget <= 0) {
            moreBeyondBudget = true;
            break;
          }
          budget -= 1;
          entries.push(entry);
        }
      } finally {
        await handle.close().catch(() => {});
      }
    } catch {
      return null;
    }
    // Rollout paths are date-ordered (sessions/YYYY/MM/DD/rollout-<ts>-<id>),
    // so newest-first finds a live thread in the first few reads.
    entries.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const found = await walk(join(dir, entry.name));
        if (found !== false) return found;
        continue;
      }
      if (!entry.isFile()) continue;
      // `.jsonl` and codex's compressed `.jsonl.zst` are both live rollouts:
      // anchored extensions only (a `rollout-*.jsonl.bak` is not one), and the
      // thread id must be the filename's final segment before the extension,
      // matched exactly — a substring id must never match an unrelated rollout.
      const isRolloutFile = /\.(jsonl|jsonl\.zst)$/.test(entry.name);
      if (!entry.name.startsWith('rollout-') || !isRolloutFile) continue;
      sawAnyRollout = true;
      if (entry.name.endsWith(`-${threadId}.jsonl`) || entry.name.endsWith(`-${threadId}.jsonl.zst`)) return true;
    }
    // Entries the budget never let us read could still hold the target.
    return moreBeyondBudget ? null : false;
  };
  const result = await walk(join(codexHome, 'sessions'));
  if (result !== false) return false;
  return sawAnyRollout;
}
