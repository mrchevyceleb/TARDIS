// Matt's asks are open by default (card-baadaf B): every Matt message in a
// lane opens an item that stays open until the agent closes it by answering
// (any assistant text in the lane) or by linking the work to a card (any card
// comment, which carries a nextCheckAt per piece A). Unclosed after 15
// minutes it nudges the agent; 15 quiet minutes after that, the Chief.
// Opt-out, not opt-in: no promise-detection regex, no guessing — the ask is
// the message itself, and the close is a real action (a reply or a card
// touch), both read off the event stream.

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from '../config.ts';
import { agentForChatId, type Agent } from '../chat/agents.ts';
import { isAgentThread, bareChatId } from '../chat/threadKey.ts';
import { findPromisedTimes, scanOutgoingPromise } from './promiseScan.ts';
import { listCommitments } from './commitmentStore.ts';

const FILE = join(STATE_DIR, 'matt-asks.json');
const TEXT_SNIPPET = 120;
const MAX_OPEN_PER_AGENT = 8;
/** Quiet time before the agent nudge. */
const NUDGE_AFTER_MS = 15 * 60_000;
/** Quiet time after the agent nudge before the Chief copy. */
const ESCALATE_AFTER_MS = 15 * 60_000;

export type MattAsk = {
  id: string;
  agentId: string;
  /** The log key the ask landed in (the agent's home thread). */
  logKey: string;
  /** The chat id (for display). */
  chatId: string;
  text: string;
  askedAt: number;
  nudgedAt?: number;
  escalatedAt?: number;
  /** The auto-added commitment this ask is held open by (piece C). */
  committedId?: string;
};

type Store = { asks: MattAsk[] };

function read(): Store {
  let raw: string;
  try {
    raw = readFileSync(FILE, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { asks: [] };
    // A damaged or temporarily unreadable file is NOT empty: propagate so the
    // fail-open caller skips the mutation instead of overwriting recoverable
    // state with an empty store.
    throw err;
  }
  let parsed: { asks?: unknown };
  try {
    parsed = JSON.parse(raw) as { asks?: unknown };
  } catch (err) {
    // A malformed file is NOT empty: propagate so the fail-open caller skips
    // the mutation instead of overwriting recoverable state. (The commitment
    // store treats a torn file the same way: the next accepted write replaces
    // it, but nothing silently loses the old content first.)
    throw err;
  }
  if (!parsed || !Array.isArray(parsed.asks)) return { asks: [] };
  const asks: MattAsk[] = [];
  for (const item of parsed.asks.slice(0, 200)) {
    if (!item || typeof item !== 'object') continue;
    const a = item as Record<string, unknown>;
    if (typeof a.id !== 'string' || typeof a.agentId !== 'string' || typeof a.logKey !== 'string' || typeof a.text !== 'string') continue;
    asks.push({
      id: a.id,
      agentId: a.agentId,
      logKey: a.logKey,
      chatId: typeof a.chatId === 'string' ? a.chatId : '',
      text: a.text.slice(0, TEXT_SNIPPET),
      askedAt: typeof a.askedAt === 'number' && Number.isFinite(a.askedAt) ? a.askedAt : 0,
      ...(typeof a.nudgedAt === 'number' && a.nudgedAt > 0 ? { nudgedAt: a.nudgedAt } : {}),
      ...(typeof a.escalatedAt === 'number' && a.escalatedAt > 0 ? { escalatedAt: a.escalatedAt } : {}),
      ...(typeof a.committedId === 'string' && a.committedId ? { committedId: a.committedId } : {}),
    });
  }
  return { asks };
}

function save(store: Store): void {
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, FILE);
}

/** The agent for a log key (`thread|<workspace>|<chatId>`), or null. */
function agentForLogKey(logKey: string): Agent | null {
  const chatId = logKey.slice(logKey.lastIndexOf('|') + 1);
  if (!isAgentThread(chatId)) return null;
  return agentForChatId(bareChatId(chatId)) ?? null;
}

/** A Matt message landed in an agent lane: open a ask. Fail-open, never
 *  throws, so the message path is never blocked. */
export function noteMattAsk(logKey: string, text: string): void {
  try {
    const agent = agentForLogKey(logKey);
    if (!agent) return;
    const store = read();
    const open = store.asks.filter((a) => a.agentId === agent.id);
    if (open.length >= MAX_OPEN_PER_AGENT) {
      // The oldest open ask drops when the list is full: the newest ask is
      // always the live one, and a stale one is noise past the nudge cycle.
      store.asks = store.asks.filter((a) => a !== open[0]);
    }
    store.asks.push({
      id: `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      agentId: agent.id,
      logKey,
      chatId: logKey.slice(logKey.lastIndexOf('|') + 1),
      text: text.replace(/\s+/g, ' ').trim().slice(0, TEXT_SNIPPET),
      askedAt: Date.now(),
    });
    save(store);
  } catch {
    // Never block the message path on a store hiccup.
  }
}

/** The agent produced assistant text in the lane: every open ask for that
 *  log key closes as answered. Fail-open. */
export function closeMattAsksForLane(logKey: string): void {
  try {
    const store = read();
    const before = store.asks.length;
    store.asks = store.asks.filter((a) => a.logKey !== logKey);
    if (store.asks.length !== before) save(store);
  } catch {
    // Never block the reply path on a store hiccup.
  }
}

/** An answer that promises a time: if the reply text carries a clock-time
 *  promise (our house rule means every promise carries one, like "8:45pm
 *  ET" or "by 9:00pm ET"), the sentence auto-adds a commitment for this
 *  agent using that exact due time (deterministic on our own time format
 *  via the existing promiseScan parser), and the ask stays open until the
 *  commitment clears. An answer with no promise closes the ask immediately
 *  (the existing behavior). Returns the commitment adds for logging. */
/** The open commitment for this agent matching a promised due instant (a
 *  restatement links to the commitment that already tracks the promise). */
function matchingCommitmentId(agentId: string, dueAt: number): string | undefined {
  const match = listCommitments(agentId).find((c) => c.dueAt === dueAt);
  return match?.id;
}

export async function closeAnsweredMattAsksForLane(logKey: string, replyText: string): Promise<{ added: string[]; addError?: string }> {
  const added: string[] = [];
  try {
    const agent = agentForLogKey(logKey);
    if (!agent) return { added };
    // Deterministic on our own format: the existing findPromisedTimes only
    // matches marker + clock with am/pm, never meaning.
    const promises = findPromisedTimes(replyText);
    if (promises.length === 0) {
      closeMattAsksForLane(logKey);
      return { added };
    }
    // Auto-add the first unmatched promise as a commitment (the same logic
    // as the team_message path, idempotent per source message).
    const scan = scanOutgoingPromise(agent.id, replyText, `ask:${logKey}:${promises[0].dueAt}`);
    added.push(...scan.added.map((a) => a.id));
    // The ask stays open through a commitment until it clears, and NEVER
    // closes on a failure:
    // - A fresh add: the ask links to the new commitment (committedId).
    // - A restatement (no new add, no error): the promise is already
    //   tracked by an existing commitment — find the matching open one by
    //   the same due instant and link the ask to it, so the ask stays alive
    //   through the commitment it already has.
    // - A failed add: the ask stays open with no committedId, so the
    //   15-minute sweep nudges the agent. Never close on a failure.
    const store = read();
    const commitmentId = scan.added[0]?.id;
    const linked = commitmentId ?? (scan.addError ? undefined : matchingCommitmentId(agent.id, promises[0].dueAt));
    if (linked) {
      for (const ask of store.asks) {
        if (ask.logKey !== logKey) continue;
        ask.committedId = linked;
      }
      if (store.asks.some((a) => a.logKey === logKey)) save(store);
    }
    // A failed add (scan.addError set) or a restatement with no matching open
    // commitment: the ask stays open (no committedId), so the sweep nudges it.
    return { added, ...(scan.addError ? { addError: scan.addError } : {}) };
  } catch {
    // Fail-open: the reply is never blocked, and the ask closes plainly.
    closeMattAsksForLane(logKey);
    return { added };
  }
}

/** The agent touched a card (a comment sets a nextCheckAt per piece A):
 *  every open ask for that agent closes as linked to the card. Fail-open. */
export function closeMattAsksForAgent(agentId: string): void {
  try {
    const store = read();
    const before = store.asks.length;
    store.asks = store.asks.filter((a) => a.agentId !== agentId);
    if (store.asks.length !== before) save(store);
  } catch {
    // Never block the card path on a store hiccup.
  }
}

/** One sweep over the open asks: nudges the agent for a ask open past
 *  15 minutes (once), and the Chief for one still open 15 minutes after the
 *  nudge (once). Returns the deliveries to make, having already marked them,
 *  so a crash can drop a nudge but never repeat one. */
export async function sweepMattAsks(): Promise<Array<{ kind: 'agent' | 'chief'; ask: MattAsk; to: string; text: string }>> {
  const due: Array<{ kind: 'agent' | 'chief'; ask: MattAsk; to: string; text: string }> = [];
  try {
    const store = read();
    const now = Date.now();
    let changed = false;
    for (const ask of store.asks) {
      // An ask held open by a commitment (piece C): it nudges only when the
      // commitment itself is past due or has vanished (cleared without closing
      // the ask), and it closes when the commitment clears. The commitment's
      // own sweep already flags past-due ones, so this sweep only handles the
      // ask lifecycle, not the commitment.
      if (ask.committedId) {
        const stillOpen = listCommitments(ask.agentId).some((c) => c.id === ask.committedId);
        if (!stillOpen) {
          // The commitment cleared: the ask closes.
          ask.escalatedAt = now; // mark so it doesn't nudge after removal
          continue;
        }
        // The commitment is still open: the ask is alive through it, not
        // through the 15-minute timer.
        continue;
      }
      if (!ask.nudgedAt && now - ask.askedAt >= NUDGE_AFTER_MS) {
        ask.nudgedAt = now;
        changed = true;
        due.push({
          kind: 'agent',
          ask,
          to: ask.agentId,
          text: `Matt's message in your lane is 15 minutes old with no reply or card touch from you: "${ask.text}". Answer him in the lane or comment on the card that carries the work.`,
        });
      } else if (ask.nudgedAt && !ask.escalatedAt && now - ask.nudgedAt >= ESCALATE_AFTER_MS) {
        ask.escalatedAt = now;
        changed = true;
        due.push({
          kind: 'chief',
          ask,
          to: 'chief-of-staff',
          text: `Matt's ask flag: ${ask.agentId}'s lane has an unanswered Matt message ("${ask.text}") open ${Math.round((now - ask.askedAt) / 60000)} minutes with no reply and no card touch. It went to them; make sure they act on it.`,
        });
      }
    }
    if (changed) save(store);
  } catch {
    // A sweep hiccup is a missed cycle, not a crash: the next tick retries.
  }
  return due;
}
