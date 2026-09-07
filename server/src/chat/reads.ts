// Unread tracking — "this agent replied and is waiting for you". The server
// knows each agent home thread's latest event seq; the focused client reports
// reads; the agents API carries the delta as `unread`.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR, ELROND_WORKSPACE_PATH } from '../config.ts';
import { loadEventLogSync } from './event-log-store.ts';
import { agentLogKey } from './teamBus.ts';
import { logKeyFor } from './threadKey.ts';
import { isThreadWatched } from './threadWatch.ts';
import type { Agent } from './agents.ts';
import {
  eventInner,
  eventText,
  eventType,
  isAutomationPeerEvent,
  isQuietRoutineReply,
  isRoutineNoiseEvent,
} from './routineNoise.ts';

const READS_FILE = join(STATE_DIR, 'agent-reads.json');

type Reads = Record<string, number>;

function readReads(): Reads {
  try {
    return JSON.parse(readFileSync(READS_FILE, 'utf8')) as Reads;
  } catch {
    return {};
  }
}

function writeReads(reads: Reads): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(READS_FILE, JSON.stringify(reads, null, 2));
}

function lastReadIndex(events: { seq: number }[], lastRead: number): number {
  if (lastRead <= 0) return -1;
  let idx = -1;
  for (let i = 0; i < events.length; i++) {
    if (events[i].seq === lastRead) idx = i;
  }
  if (idx >= 0) return idx;
  for (let i = 0; i < events.length; i++) {
    if (events[i].seq <= lastRead) idx = i;
  }
  return idx;
}

function resultReplyText(raw: unknown): string {
  const t = eventText(raw).trim();
  if (t) return t;
  const inner = eventInner(raw);
  const r = inner?.result;
  return typeof r === 'string' ? r.trim() : '';
}

/** Session-init / keepalive / failed-boot results are not a waiting reply.
 *  Empty homes collect these from engine connect (hook/init/`result`
 *  duration_ms=0 / error_during_execution) even when nobody ever messaged. */
function isNonReplyResult(raw: unknown): boolean {
  const inner = eventInner(raw);
  if (!inner) return true;
  if (inner.is_error === true) return true;
  const sub = typeof inner.subtype === 'string' ? inner.subtype : '';
  if (sub === 'error_during_execution' || sub === 'error') return true;
  const text = resultReplyText(raw);
  const dur = inner.duration_ms;
  if (typeof dur === 'number' && dur <= 0 && !text) return true;
  const turns = inner.num_turns;
  if ((turns === 0 || turns === '0') && !text) return true;
  return false;
}

/** Latest persisted seq in an agent's home log (0 when no log yet).
 *  Recency is the last line's seq (append order), not max(seq): a trailing
 *  duplicate/rewound seq is still the newest event. */
export function agentLatestSeq(agent: Agent): number {
  try {
    const { events } = loadEventLogSync(agentHistoryKey(agent));
    return events.length ? events[events.length - 1].seq : 0;
  } catch {
    return 0;
  }
}

/** An agent home thread's durable log is engine-free, so unread counting keeps
 *  working across a model change instead of resetting to an empty lane. */
function agentHistoryKey(agent: Agent): string {
  const { cli, chatKey } = agentLogKey(agent);
  return logKeyFor(cli, ELROND_WORKSPACE_PATH, chatKey);
}

/** Count of assistant-authored events since the last read (0 = read). */
export function agentUnread(agent: Agent): number {
  // Muted companions still write and talk to the crew; they just never badge.
  if (agent.muted) return 0;
  try {
    const { events } = loadEventLogSync(agentHistoryKey(agent));
    if (!events.length) return 0;
    {
      // A thread the user is actively watching (visible tab) can never be "waiting
      // for you" — replies there are seen as they land. Advance the durable
      // cursor too, so a reply rendered on a visible tab can't re-badge after
      // the tab backgrounds before the client's next mark-read POST.
      const { chatKey } = agentLogKey(agent);
      if (isThreadWatched(ELROND_WORKSPACE_PATH, chatKey)) {
        const reads = readReads();
        const lastSeq = events[events.length - 1].seq;
        if ((reads[agent.id] ?? 0) < lastSeq) {
          reads[agent.id] = lastSeq;
          writeReads(reads);
        }
        return 0;
      }
    }
    const maxSeq = events.reduce((m, e) => (e.seq > m ? e.seq : m), 0);
    const reads = readReads();
    let lastRead = reads[agent.id] ?? 0;
    if (lastRead > maxSeq) {
      // True truncation / lane wipe: every seq in the file is below the
      // cursor. A trailing duplicate lower seq is NOT truncation (max is
      // still high) — do not reset, or empty-home bootstrap results badge.
      lastRead = 0;
      reads[agent.id] = 0;
      writeReads(reads);
    }
    // Append-position cursor: last occurrence of lastRead, then everything
    // after that line (even a rewound/duplicate seq) is eligible.
    const cursorIdx = lastReadIndex(events, lastRead);
    if (cursorIdx >= events.length - 1) return 0;
    // Count events after lastRead that carry assistant text (replies waiting).
    // Walk forward so an automation peer before lastRead still tags the
    // following quiet reply as noise (stale cursor / mark-read race).
    // Automation turns badge once, on the final answer — Thoughts + NO_UPDATE
    // must not light the pin.
    let unread = 0;
    let afterAutomation = false;
    let autoTexts: string[] = [];
    let autoAfterRead = false;
    const flushAuto = () => {
      if (!afterAutomation) return;
      const last = [...autoTexts].reverse().find((t) => t.trim()) ?? '';
      if (autoAfterRead && last && !isQuietRoutineReply(last)) unread++;
      afterAutomation = false;
      autoTexts = [];
      autoAfterRead = false;
    };
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const raw = e.ev ?? e;
      const t = eventType(raw);
      const pastCursor = i > cursorIdx;
      if (t === 'peer_message' && isAutomationPeerEvent(raw)) {
        flushAuto();
        afterAutomation = true;
        autoAfterRead = pastCursor;
        continue;
      }
      if (t === '_user_echo' || t === 'user' || t === 'peer_message') {
        flushAuto();
        if (t === 'peer_message' && pastCursor) unread++;
        continue;
      }
      if (afterAutomation && t === 'assistant') {
        if (pastCursor) autoAfterRead = true;
        const text = eventText(raw);
        // Only post-cursor text: a later transport result must not resurrect
        // already-read assistant content as a new unread.
        if (pastCursor && text.trim()) autoTexts.push(text);
        continue;
      }
      if (t === 'result') {
        if (afterAutomation) {
          if (pastCursor && !isNonReplyResult(raw)) autoAfterRead = true;
          flushAuto();
          continue;
        }
        if (pastCursor && !isNonReplyResult(raw)) unread++;
        continue;
      }
      if (!pastCursor) continue;
      // Bootstrap / transport: system init, hooks, working keepalives,
      // compacted dividers, errors, turnEnd — never a waiting reply.
      if (t !== 'assistant') continue;
      if (isRoutineNoiseEvent(raw, afterAutomation)) continue;
      if (!eventText(raw).trim()) continue;
      unread++;
    }
    flushAuto();
    return unread;
  } catch {
    return 0;
  }
}

/** The focused client calls this while it has the agent's thread open. */
export function markAgentRead(agentId: string, seq: number): void {
  const reads = readReads();
  if ((reads[agentId] ?? 0) >= seq) return;
  reads[agentId] = seq;
  writeReads(reads);
}
