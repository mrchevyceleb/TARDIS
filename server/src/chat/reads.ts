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
  eventTexts,
  isAutomationPeerEvent,
  isJobResultPeerEvent,
  isPersonPeerEvent,
  isTeammatePeerEvent,
  isNoopToken,
  isQuietRoutineReply,
  isRoutineNoiseEvent,
  isToolResultUserEvent,
} from './routineNoise.ts';
import { PROVIDER_CONTINUE_EVENT } from './providerSwitch.ts';
import { REPLY_NUDGE_EVENT } from './replyNudge.ts';

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
  if (isQuietRoutineReply(text)) return true;
  const dur = inner.duration_ms;
  if (typeof dur === 'number' && dur <= 0 && !text) return true;
  const turns = inner.num_turns;
  if ((turns === 0 || turns === '0') && !text) return true;
  return false;
}

/** A frame whose every text is a protocol no-op (NO_UPDATE, EOS, "Quiet.") renders nothing, so it never badges. */
function isNoopOnly(raw: unknown): boolean {
  const texts = eventTexts(raw).map((x) => x.trim()).filter(Boolean);
  return texts.length > 0 && texts.every(isNoopToken);
}

/** Streamed text blocks (Codex, Banana, voice continuations) arrive as stream_event deltas and may never be
 *  followed by a full assistant frame. Returns the finished block's text on content_block_stop, else null. */
function finishedStreamText(stream: { type?: string; index?: unknown; content_block?: { type?: string; text?: unknown }; delta?: { type?: string; text?: unknown } } | undefined, open: Map<number, string>): string | null {
  if (!stream || typeof stream !== 'object') return null;
  if (stream.type === 'message_start') { open.clear(); return null; }
  const index = typeof stream.index === 'number' ? stream.index : null;
  if (index === null) return null;
  if (stream.type === 'content_block_start' && stream.content_block?.type === 'text') {
    open.set(index, typeof stream.content_block.text === 'string' ? stream.content_block.text : '');
  } else if (stream.type === 'content_block_delta' && stream.delta?.type === 'text_delta' && open.has(index)) {
    open.set(index, (open.get(index) ?? '') + String(stream.delta.text ?? ''));
  } else if (stream.type === 'content_block_stop') {
    const text = open.get(index);
    open.delete(index);
    return text ?? null;
  }
  return null;
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
    // One badge per turn: a working turn narrates between tool calls and then
    // repeats its answer in the `result`, but that is one reply waiting, not many.
    // A teammate handoff or a Desk/voice message is never a reply to the person:
    // it only starts a turn, and the turn badges when its reply is real text.
    let turnCounted = false;
    // A turn a teammate's handoff or a job result started is not a conversation with the person: none of its replies
    // badge, until the person speaks in the thread or an automation turn starts.
    let silentTurn = false;
    // Whether the current turn already has a first message. A peer message that lands mid-turn is a steer into a turn
    // someone else started, so it must not change who the turn belongs to.
    let turnHasOrigin = false;
    // Silence ends with its turn. Only a turn that starts with no message of its own (a provider continue or a reply
    // nudge) carries on the previous one, so it takes that turn's silence; every other new turn starts audible.
    let carriedSilent = false;
    const openStream = new Map<number, string>();
    // Where each open block's text last arrived. A block belongs to that frame, not to the stop frame that closes it.
    const streamTextAt = new Map<number, number>();
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
      // Streamed text arrives as `stream_event` deltas, and eventInner() unwraps those to the bare delta, so read
      // the stored frame itself. A subagent's stream is private work, like its other frames.
      // Runners persist their frames inside a transport envelope ({type:'event', event:{type:'stream_event', ...}}),
      // Claude's own frames arrive bare, so unwrap one level before looking at the type.
      let outer = ((raw as { ev?: unknown } | null)?.ev ?? raw) as Record<string, unknown> | null;
      const envelopeParent = outer && outer.type === 'event' ? outer.parent_tool_use_id : undefined;
      if (outer && outer.type === 'event' && outer.event && typeof outer.event === 'object') {
        outer = outer.event as Record<string, unknown>;
      }
      if (outer && outer.type === 'stream_event') {
        if (outer.parent_tool_use_id || envelopeParent) continue;
        const frame = outer.event as Parameters<typeof finishedStreamText>[0];
        if (frame?.type === 'message_start') streamTextAt.clear();
        const frameIndex = typeof frame?.index === 'number' ? frame.index : null;
        if (frameIndex !== null) {
          const addsText = frame?.type === 'content_block_start'
            ? frame.content_block?.type === 'text' && Boolean(frame.content_block.text)
            : frame?.type === 'content_block_delta' && frame.delta?.type === 'text_delta' && Boolean(frame.delta.text);
          if (addsText) streamTextAt.set(frameIndex, i);
        }
        const streamed = finishedStreamText(frame, openStream);
        const textIdx = frameIndex !== null ? streamTextAt.get(frameIndex) : undefined;
        if (frameIndex !== null && frame?.type === 'content_block_stop') streamTextAt.delete(frameIndex);
        // Bookkeeping above runs for every turn, so block state never goes stale; only the badge is gated.
        if (silentTurn || streamed === null || !streamed.trim()) continue;
        const blockPastCursor = (textIdx ?? i) > cursorIdx;
        if (afterAutomation) {
          if (blockPastCursor) { autoAfterRead = true; autoTexts.push(streamed); }
          continue;
        }
        // A stream-only reply is still a visible one. Pre-cursor blocks mark the turn counted without badging, so
        // the same reply's later result cannot re-badge something Matt already saw.
        if (isNoopToken(streamed) || isRoutineNoiseEvent({ type: 'assistant', text: streamed }, false)) continue;
        if (!turnCounted) { if (blockPastCursor) unread++; turnCounted = true; }
        continue;
      }
      // A background subagent's own frames (parent_tool_use_id) are its private
      // work: the chat reducer drops them, so they can never be a visible reply.
      if (eventInner(raw)?.parent_tool_use_id) continue;
      if (t === 'peer_message' && isJobResultPeerEvent(raw)) {
        if (turnHasOrigin) continue;
        flushAuto();
        turnCounted = false;
        silentTurn = true;
        turnHasOrigin = true;
        carriedSilent = false;
        continue;
      }
      if (t === 'peer_message' && isAutomationPeerEvent(raw)) {
        // A routine steered into a turn that already has a first message does not change who owns it, and the turn
        // keeps its one badge.
        if (turnHasOrigin) continue;
        flushAuto();
        turnCounted = false;
        silentTurn = false;
        turnHasOrigin = true;
        carriedSilent = false;
        afterAutomation = true;
        autoAfterRead = pastCursor;
        continue;
      }
      // Tool results arrive as `user` events. They are still the automation
      // turn, not a human message that should flush it.
      if (isToolResultUserEvent(raw)) continue;
      // A turn a GLM provider cut, that nothing will finish on its own, is
      // waiting on the user even though no reply text exists.
      if (t === '_terminal_error') {
        if (eventInner(raw)?.unread === true && !turnCounted && !silentTurn) { if (pastCursor) unread++; turnCounted = true; }
        continue;
      }
      // A turn that ended without a result (cut, failed, replaced by _terminal_error) still closes the turn, or its
      // counted flag would swallow the next reply. Every runner emits `result` before `turnEnd`, so this never
      // double counts.
      if (t === 'turnEnd') {
        turnCounted = false;
        turnHasOrigin = false;
        carriedSilent = silentTurn;
        silentTurn = false;
        openStream.clear();
        streamTextAt.clear();
        continue;
      }
      if (t === 'turnStart') { turnHasOrigin = false; continue; }
      if (t === REPLY_NUDGE_EVENT) {
        silentTurn = silentTurn || carriedSilent;
        turnHasOrigin = true;
        continue;
      }
      // The automatic continue of a cut routine turn is still that routine:
      // its quiet NO_UPDATE must not badge.
      if (t === PROVIDER_CONTINUE_EVENT) {
        silentTurn = silentTurn || carriedSilent;
        turnHasOrigin = true;
        if (eventInner(raw)?.automation === true && !silentTurn) {
          flushAuto();
          afterAutomation = true;
          autoAfterRead = pastCursor;
        }
        turnCounted = false;
        continue;
      }
      if (t === '_user_echo' || t === 'user' || t === 'peer_message') {
        // A harness-injected user message (the post-compaction summary) is not the person speaking, so it changes
        // nothing about the turn: no flush, no recount, no reopened silence.
        if (t === 'user' && eventInner(raw)?.isSynthetic === true) continue;
        // A teammate or other non-person peer steered into a turn that already has an origin does not change who
        // owns it. Only the person's own Desk or voice message reopens a turn mid-flight.
        if (t === 'peer_message' && turnHasOrigin && !isPersonPeerEvent(raw)) continue;
        flushAuto();
        turnCounted = false;
        silentTurn = isTeammatePeerEvent(raw);
        turnHasOrigin = true;
        carriedSilent = false;
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
        if (pastCursor && !silentTurn && !isNonReplyResult(raw) && !isNoopOnly(raw) && !turnCounted) unread++;
        turnCounted = false;
        continue;
      }
      // Bootstrap / transport: system init, hooks, working keepalives,
      // compacted dividers, errors — never a waiting reply.
      if (t !== 'assistant') continue;
      if (silentTurn) continue;
      if (isRoutineNoiseEvent(raw, afterAutomation)) continue;
      if (!eventText(raw).trim() || isNoopOnly(raw)) continue;
      // Pre-cursor replies still mark the turn counted (without badging), so a result that repeats an answer
      // Matt already read cannot badge again.
      if (!turnCounted) { if (pastCursor) unread++; turnCounted = true; }
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
