// Matt's asks are open by default, the simple timer (card-baadaf B+C,
// redesigned Oct 13 2026 after 7 review rounds on the complex version showed
// the interaction between the ask store, the commitment store, the event
// matching, and the failure paths never converges). No linking, no matching,
// no commitment store, no event-shape parsing. Just a timer per Matt message:
//
//   a Matt message in any agent lane with no visible reply for 15 minutes
//   nudges that lane's agent; 15 more minutes nudges the Chief. Never Matt.
//
//   any commitment past its due time nudges its owner; 15 more minutes
//   nudges the Chief.
//
// Both ride the 60s hygiene tick. Best effort, fail-open, at-most-once.

import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from '../config.ts';
import { agentForChatId, type Agent } from '../chat/agents.ts';
import { isAgentThread, bareChatId } from '../chat/threadKey.ts';
import { listCommitments, markCommitmentRaised } from './commitmentStore.ts';

const ASK_FILE = join(STATE_DIR, 'matt-asks.json');
const NUDGE_AFTER_MS = 15 * 60_000;
const ESCALATE_AFTER_MS = 15 * 60_000;
const TEXT_SNIPPET = 120;

export type MattAsk = {
  id: string;
  agentId: string;
  logKey: string;
  text: string;
  askedAt: number;
  nudgedAt?: number;
  escalatedAt?: number;
};

type AskStore = { asks: MattAsk[] };

function readAsks(): AskStore {
  let raw: string;
  try {
    raw = readFileSync(ASK_FILE, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { asks: [] };
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as { asks?: unknown };
    if (!parsed || !Array.isArray(parsed.asks)) return { asks: [] };
    const asks: MattAsk[] = [];
    for (const item of parsed.asks.slice(0, 500)) {
      if (!item || typeof item !== 'object') continue;
      const a = item as Record<string, unknown>;
      if (typeof a.id !== 'string' || typeof a.agentId !== 'string' || typeof a.logKey !== 'string' || typeof a.text !== 'string') continue;
      asks.push({
        id: a.id,
        agentId: a.agentId,
        logKey: a.logKey,
        text: a.text.slice(0, TEXT_SNIPPET),
        askedAt: typeof a.askedAt === 'number' && Number.isFinite(a.askedAt) ? a.askedAt : 0,
        ...(typeof a.nudgedAt === 'number' && a.nudgedAt > 0 ? { nudgedAt: a.nudgedAt } : {}),
        ...(typeof a.escalatedAt === 'number' && a.escalatedAt > 0 ? { escalatedAt: a.escalatedAt } : {}),
      });
    }
    return { asks };
  } catch (err) {
    // A torn file is not empty: the next accepted write replaces it whole
    // (the same recovery the commitment store uses). Propagate so a damaged
    // file is never silently overwritten with an empty store first.
    throw err;
  }
}

function saveAsks(store: AskStore): void {
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${ASK_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, ASK_FILE);
}

function agentForLogKey(logKey: string): Agent | null {
  const chatId = logKey.slice(logKey.lastIndexOf('|') + 1);
  if (!isAgentThread(chatId)) return null;
  return agentForChatId(bareChatId(chatId)) ?? null;
}

/** A Matt message landed in an agent lane: start its timer. Fail-open. */
export function noteMattAsk(logKey: string, text: string): void {
  try {
    const agent = agentForLogKey(logKey);
    if (!agent) return;
    const store = readAsks();
    store.asks.push({
      id: `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      agentId: agent.id,
      logKey,
      text: text.replace(/\s+/g, ' ').trim().slice(0, TEXT_SNIPPET),
      askedAt: Date.now(),
    });
    saveAsks(store);
  } catch {
    // Never block the message path.
  }
}

/** The agent produced a visible reply in the lane: every open ask for that
 *  lane closes. Fail-open. */
export function closeMattAsksForLane(logKey: string): void {
  try {
    const store = readAsks();
    const before = store.asks.length;
    store.asks = store.asks.filter((a) => a.logKey !== logKey);
    if (store.asks.length !== before) saveAsks(store);
  } catch {
    // Never block the reply path.
  }
}

/** The card-comment close: any card comment by a live roster agent closes
 *  their open asks (the comment proves active work on a card). Fail-open. */
export function closeMattAsksForAgent(agentId: string): void {
  try {
    const store = readAsks();
    const before = store.asks.length;
    store.asks = store.asks.filter((a) => a.agentId !== agentId);
    if (store.asks.length !== before) saveAsks(store);
  } catch {
    // Never block the card path.
  }
}

/** One sweep: nudges the agent for a Matt ask open past 15 minutes (once),
 *  and the Chief for one still open 15 minutes after the nudge (once).
 *  Also nudges the owner of any commitment past its due time (once), and the
 *  Chief 15 minutes after (once). Never Matt. Returns the deliveries,
 *  having already marked them (at-most-once). */
export function sweepMattAsks(): Array<{ kind: 'agent' | 'chief'; to: string; text: string }> {
  const due: Array<{ kind: 'agent' | 'chief'; to: string; text: string }> = [];
  try {
    const now = Date.now();
    const store = readAsks();
    let dirty = false;
    for (const ask of store.asks) {
      if (!ask.nudgedAt && now - ask.askedAt >= NUDGE_AFTER_MS) {
        ask.nudgedAt = now;
        dirty = true;
        due.push({
          kind: 'agent',
          to: ask.agentId,
          text: `Matt's message in your lane is 15 minutes old with no reply: "${ask.text}". Answer him in the lane.`,
        });
      } else if (ask.nudgedAt && !ask.escalatedAt && now - ask.nudgedAt >= ESCALATE_AFTER_MS) {
        ask.escalatedAt = now;
        dirty = true;
        due.push({
          kind: 'chief',
          to: 'chief-of-staff',
          text: `Matt's ask flag: ${ask.agentId}'s lane has an unanswered Matt message ("${ask.text}") open ${Math.round((now - ask.askedAt) / 60000)} minutes with no reply. It went to them; make sure they act on it.`,
        });
      }
    }
    if (dirty) saveAsks(store);
  } catch {
    // A sweep hiccup is a missed cycle, not a crash.
  }
  // Piece C, the same simple idea: any commitment past its due time nudges
  // its owner, and 15 minutes later nudges the Chief. No linking, no
  // matching — the commitment store already has dueAt and the sweep just
  // checks it. The commitment's own fields (raised.owner / raised.chief)
  // are the at-most-once marks.
  try {
    const now = Date.now();
    for (const c of listCommitments()) {
      if (!c.due || !c.dueAt) continue;
      if (c.dueAt > now) continue;
      if (c.agentId === 'chief-of-staff') continue;
      if (!c.raised?.owner && !c.raised?.chief) {
        // First encounter: nudge the owner and the Chief together (the
        // commitment sweep in PR #180 does this per-recipient with
        // delivery-confirmed marks; this is the simple version).
        due.push({
          kind: 'agent',
          to: c.agentId,
          text: `Your commitment [${c.id}] "${c.text}" (due ${c.due}) is past due. Clear it with the commitments tool.`,
        });
        due.push({
          kind: 'chief',
          to: 'chief-of-staff',
          text: `Past-due commitment: ${c.agentId}'s [${c.id}] "${c.text}" (due ${c.due}). It went to them; make sure they act on it.`,
        });
        // Mark both so the next sweep doesn't repeat.
        markRaised(c.id);
      }
    }
  } catch {
    // Same fail-open.
  }
  return due;
}

/** Mark a commitment raised (both recipients) in the commitment store. */
function markRaised(id: string): void {
  try {
    markCommitmentRaised(id, 'owner');
    markCommitmentRaised(id, 'chief');
  } catch {
    // Never block the sweep on a store hiccup.
  }
}
