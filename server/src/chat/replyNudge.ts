/** Reply-first safety net.
 *
 *  A person's message is owed visible text. An agent that answers inside a
 *  thinking block and then works tool after tool leaves them staring at
 *  nothing, because thinking is never rendered. Once a person's message has
 *  gone REPLY_NUDGE_TOOLS tool calls or REPLY_NUDGE_MS with no assistant text,
 *  the runner hands the agent one harness note asking it to say where it is:
 *  Claude-family lanes end the turn at a tool boundary (nothing is cancelled)
 *  and open a new one with the note, Codex and Pi take it as a native steer.
 *  One nudge per person message; only a new person message re-arms it. */

import type { SeqEvent } from './runner.ts';

export const REPLY_NUDGE_TOOLS = 5;
export const REPLY_NUDGE_MS = 60_000;
/** Never on the first tool call: a single quiet step is not silence yet. */
const REPLY_NUDGE_MIN_TOOLS = 2;

/** Stream event recording that a nudge went out. Not rendered. */
export const REPLY_NUDGE_EVENT = '_reply_nudge';

export const REPLY_NUDGE_NOTE = '<rivendell-steer>System note, not a new message from the person: they have seen nothing from you since their message, and they cannot see your thinking. Say in visible text what you understood and what you are doing, then continue.</rivendell-steer>';

export type ReplyNudgeReason = 'tools' | 'time';
export type ReplyNudge = { reason: ReplyNudgeReason; tools: number; elapsedMs: number };

/** A person's own message (Matt in Hall, or the owner on the Desk), as opposed
 *  to a teammate, routine, job wake or voice delivery. */
export function isPersonMessage(opts: { peerFrom?: string; peerFromRole?: string }): boolean {
  return !opts.peerFrom || opts.peerFromRole === 'desk';
}

export function replyNudgeEvent(nudge: ReplyNudge): SeqEvent['ev'] {
  return { type: 'event', event: { type: REPLY_NUDGE_EVENT, ...nudge, ts: Date.now() } } as SeqEvent['ev'];
}

export class ReplyWatch {
  private armedAt: number | null = null;
  private toolIds = new Set<string>();
  private fired = false;
  private retried = false;
  private claimed: ReplyNudge | null = null;

  /** `agent` names the lane in the journal; resolved only when a line is logged. */
  constructor(private readonly agent: () => string, private readonly engine: string) {}

  private who(): string {
    try { return this.agent(); } catch { return '?'; }
  }

  /** A person's message was admitted: count from here, with the one nudge back. */
  arm(now = Date.now()): void {
    this.armedAt = now;
    this.toolIds.clear();
    this.fired = false;
    this.retried = false;
    this.claimed = null;
  }

  /** A turn that no person's message started owes nothing. */
  reset(): void {
    this.armedAt = null;
    this.toolIds.clear();
    this.fired = false;
    this.retried = false;
    this.claimed = null;
  }

  /** This nudge was refused before it reached the agent: allow one more try for
   *  the same person's message, never more. A newer message has its own nudge,
   *  so a late refusal of an older one releases nothing. */
  release(nudge: ReplyNudge): void {
    if (this.claimed !== nudge || this.armedAt === null || this.retried) return;
    this.fired = false;
    this.retried = true;
    this.claimed = null;
  }

  /** Still waiting on visible text for the person's message. */
  waiting(): boolean {
    return this.armedAt !== null;
  }

  noteTool(id: string): void {
    if (this.armedAt !== null) this.toolIds.add(id);
  }

  /** Visible assistant text arrived, so the person has their reply. */
  noteText(now = Date.now()): void {
    if (this.armedAt === null) return;
    if (!this.fired) console.log(`[reply-nudge] agent=${this.who()} engine=${this.engine} ok=visible tools=${this.toolIds.size} elapsedMs=${now - this.armedAt}`);
    this.armedAt = null;
  }

  /** What is owed right now, without spending the nudge. */
  due(now = Date.now()): ReplyNudgeReason | null {
    if (this.armedAt === null || this.fired || this.toolIds.size < REPLY_NUDGE_MIN_TOOLS) return null;
    if (this.toolIds.size >= REPLY_NUDGE_TOOLS) return 'tools';
    return now - this.armedAt >= REPLY_NUDGE_MS ? 'time' : null;
  }

  /** Spend the one nudge for this person's message (and log it), or null. */
  claim(now = Date.now()): ReplyNudge | null {
    const reason = this.due(now);
    if (!reason || this.armedAt === null) return null;
    this.fired = true;
    const nudge = this.claimed = { reason, tools: this.toolIds.size, elapsedMs: now - this.armedAt };
    console.log(`[reply-nudge] agent=${this.who()} engine=${this.engine} reason=${reason} tools=${nudge.tools} elapsedMs=${nudge.elapsedMs}`);
    return nudge;
  }
}
