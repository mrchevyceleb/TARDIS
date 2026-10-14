// Matt's asks are open by default, the simple timer (card-baadaf B+C,
// redesigned Oct 13 2026 after 7 review rounds on the complex version showed
// the interaction between the ask store, the commitment store, the event
// matching, and the failure paths never converges). No linking, no matching,
// no commitment store, no event-shape parsing. Just a timer per Matt message:
//
//   a Matt message in any agent lane with no visible reply for 15 minutes
//   nudges that lane's agent; 15 more minutes nudges the Chief. Never Matt.
//
//   Past-due commitment nudges are NOT here: the merged commitment sweeper
//   (#180, startCommitmentSweeper) already owns them — a second sweep over
//   the same store would double-nudge it.
//
// The asks ride their own 60s tick (startMattAsksScheduler). Best effort,
// fail-open, at-most-once.

import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from '../config.ts';
import { agentForChatId, type Agent } from '../chat/agents.ts';
import { isAgentThread, bareChatId } from '../chat/threadKey.ts';

const ASK_FILE = join(STATE_DIR, 'matt-asks.json');
const NUDGE_AFTER_MS = 15 * 60_000;
const ESCALATE_AFTER_MS = 15 * 60_000;
const TEXT_SNIPPET = 120;
const DELIVERY_TIMEOUT_MS = 10_000;

// One real close check per (logKey, lane) per process: streamed replies arrive
// as many deltas, and re-reading and re-parsing the store on every delta would
// block the event loop after the ask is already closed. A new Matt message
// (noteMattAsk) re-arms its key.
const closedLanes = new Set<string>();

export type MattAsk = {
  id: string;
  agentId: string;
  logKey: string;
  /** Lane the ask landed in: home and bg sessions share a logKey, so an ask
   *  only closes on visible output from its own lane. */
  lane: 'home' | 'bg';
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
    for (const item of parsed.asks) {
      if (!item || typeof item !== 'object') continue;
      const a = item as Record<string, unknown>;
      if (typeof a.id !== 'string' || typeof a.agentId !== 'string' || typeof a.logKey !== 'string' || typeof a.text !== 'string') continue;
      asks.push({
        id: a.id,
        agentId: a.agentId,
        logKey: a.logKey,
        lane: a.lane === 'bg' ? 'bg' : 'home',
        text: a.text.slice(0, TEXT_SNIPPET),
        askedAt: typeof a.askedAt === 'number' && Number.isFinite(a.askedAt) ? a.askedAt : 0,
        ...(typeof a.nudgedAt === 'number' && a.nudgedAt > 0 ? { nudgedAt: a.nudgedAt } : {}),
        ...(typeof a.escalatedAt === 'number' && a.escalatedAt > 0 ? { escalatedAt: a.escalatedAt } : {}),
      });
    }
    return { asks };
  } catch (err) {
    // A torn file used to propagate (so a damaged file would never be
    // silently overwritten) — but every writer here catches fail-open, so
    // propagation permanently disabled the feature instead. Quarantine the
    // damaged file and recover an empty store: the next accepted write
    // rebuilds it, and the torn copy stays for inspection.
    try {
      renameSync(ASK_FILE, `${ASK_FILE}.torn-${Date.now().toString(36)}`);
    } catch {
      // Nothing to quarantine (or already gone): recover empty regardless.
    }
    console.warn(`[matt-asks] store was torn — quarantined, recovering empty: ${(err as Error)?.message}`);
    return { asks: [] };
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
export function noteMattAsk(logKey: string, lane: 'home' | 'bg', text: string): void {
  try {
    closedLanes.delete(`${logKey}|${lane}`);
    const agent = agentForLogKey(logKey);
    if (!agent) return;
    const store = readAsks();
    store.asks.push({
      id: `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      agentId: agent.id,
      logKey,
      lane,
      text: text.replace(/\s+/g, ' ').trim().slice(0, TEXT_SNIPPET),
      askedAt: Date.now(),
    });
    saveAsks(store);
  } catch {
    // Never block the message path.
  }
}

/** The agent produced a visible reply in the lane: every open ask for that
 *  logKey AND lane closes (home and bg share a logKey, so a bg routine, job,
 *  or handoff reply never closes Matt's home-lane asks). Fail-open. */
export function closeMattAsksForLane(logKey: string, lane: 'home' | 'bg'): void {
  const memoKey = `${logKey}|${lane}`;
  if (closedLanes.has(memoKey)) return;
  closedLanes.add(memoKey);
  try {
    const store = readAsks();
    const before = store.asks.length;
    store.asks = store.asks.filter((a) => a.logKey !== logKey || a.lane !== lane);
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

/** Undo a sweep mark so a rate-limited nudge retries on the next tick: the
 *  one explicit delivery failure whose mark is restored (a transient,
 *  retryable condition — every other failure or crash keeps the mark, the
 *  documented at-most-once trade, the same contract as the Desk quiet-check
 *  sweep). Fail-open. */
export function restoreAskMark(askId: string, kind: 'agent' | 'chief'): void {
  try {
    const store = readAsks();
    const ask = store.asks.find((a) => a.id === askId);
    if (!ask) return;
    if (kind === 'agent') delete ask.nudgedAt;
    else delete ask.escalatedAt;
    saveAsks(store);
  } catch {
    // Fail-open: a missed restore leaves the at-most-once trade as-is.
  }
}

/** One sweep: nudges the agent for a Matt ask open past 15 minutes (once),
 *  and the Chief for one still open 15 minutes after the nudge (once).
 *  Never Matt. Returns the deliveries, having already marked them
 *  (at-most-once). Past-due commitment nudges are NOT here — the merged
 *  commitment sweeper (startCommitmentSweeper, #180) already owns them, and
 *  a second sweep over the same store would double-nudge it. */
export function sweepMattAsks(): Array<{ askId: string; kind: 'agent' | 'chief'; to: string; text: string }> {
  const due: Array<{ askId: string; kind: 'agent' | 'chief'; to: string; text: string }> = [];
  try {
    const now = Date.now();
    const store = readAsks();
    let dirty = false;
    for (const ask of store.asks) {
      if (!ask.nudgedAt && now - ask.askedAt >= NUDGE_AFTER_MS) {
        ask.nudgedAt = now;
        dirty = true;
        due.push({
          askId: ask.id,
          kind: 'agent',
          to: ask.agentId,
          text: `Matt's message in your lane is 15 minutes old with no reply: "${ask.text}". Answer him in the lane.`,
        });
      } else if (ask.nudgedAt && !ask.escalatedAt && now - ask.nudgedAt >= ESCALATE_AFTER_MS) {
        ask.escalatedAt = now;
        dirty = true;
        due.push({
          askId: ask.id,
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
  return due;
}

// ---- scheduler ------------------------------------------------------------------

let asksTimer: ReturnType<typeof setInterval> | null = null;
let asksSweepInFlight = false;

/** The 60s tick that delivers the ask nudges: its own in-flight guard (a
 *  hung sweep suppresses only its own future runs) and per-nudge isolated
 *  delivery (one failed delivery never skips the later nudges of the same
 *  sweep — their marks are already consumed). Fail-open. */
export function startMattAsksScheduler(): boolean {
  if (asksTimer) return true;
  const run = async () => {
    const due = sweepMattAsks();
    if (!due.length) return;
    const { deliverTeamMessage } = await import('../chat/teamBus.ts');
    for (const nudge of due) {
      try {
        // A delivery that never settles must not hang the scheduler (the
        // in-flight guard would never clear): every delivery is bounded.
        const sent = await Promise.race([
          deliverTeamMessage({ from: 'Desk', to: nudge.to, text: nudge.text, wait: false }),
          new Promise<{ delivered: false; reason: 'delivery timed out' }>((resolve) => {
            setTimeout(() => resolve({ delivered: false, reason: 'delivery timed out' }), DELIVERY_TIMEOUT_MS).unref();
          }),
        ]);
        if (!sent.delivered) {
          console.warn(`[matt-asks] nudge to ${nudge.to} not delivered: ${sent.reason}`);
          // A rate-limited delivery is transient: restore the mark so the
          // nudge retries on the next tick instead of being consumed
          // (every other failure keeps the mark — at-most-once).
          if (typeof sent.reason === 'string' && /rate limit/i.test(sent.reason)) {
            restoreAskMark(nudge.askId, nudge.kind);
          }
        }
      } catch (error) {
        console.warn(`[matt-asks] nudge to ${nudge.to} failed: ${(error as Error)?.message}`);
      }
    }
    console.log(`[matt-asks] sweep: ${due.length} due, delivered best effort`);
  };
  asksTimer = setInterval(() => {
    if (asksSweepInFlight) return;
    asksSweepInFlight = true;
    void run()
      .catch((e) => console.warn(`[matt-asks] sweep: ${(e as Error)?.message}`))
      .finally(() => { asksSweepInFlight = false; });
  }, 60_000);
  asksTimer.unref();
  return true;
}
