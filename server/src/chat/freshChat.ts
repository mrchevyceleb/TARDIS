// Fresh chat (card-8d427d, Matt Oct 20 2026): Matt, Kip, Max and Riley can
// give any agent a clean, empty chat with one move before a task, so the
// lane starts sharp on its instructions and the brief. The agent keeps its
// persona, memory files, commitments and Desk cards — only the chat
// history goes. Matt already has the UI Fresh button; this is the bus-level
// version the other leads can call.
//
// Safety (the UI reset barrier): a Fresh only ever applies at the start of a
// new task, never in the middle of one. The call refuses while the lane has
// a live turn, so a dev mid-review or mid-verifier never loses their place.
// The reset claims the thread's Fresh barrier first (new turns are refused
// until release), re-checks busy under that barrier, commits the durable
// reset generation, retires every live engine session on the thread
// (account-pinned siblings included) and its native resume ids, then wipes
// the rolling compact and the durable log — in the same order the UI
// freshStart uses — so no client or engine can resurrect the conversation
// that was just discarded. The committed epoch notifies the WS layer, which
// broadcasts freshStarted so connected clients drop the old transcript.

import { agentFreshChatPerTask, brainForAgent, cliForAgentEngine, listAgents, type Agent } from './agents.ts';
import { isCoderBrief } from './briefEnvelope.ts';
import type { CliKind } from './runner.ts';
import { clearEventLog } from './event-log-store.ts';
import { clearThreadMemory } from './compaction.ts';
import { persistThreadResetEpoch, threadResetEpoch } from './threadResetStore.ts';
import { freshLifecycleCompleted, freshLifecycleStarted } from './freshLifecycle.ts';
import { readComputerContext } from '../devices/context.ts';
import { clearThreadSessionIds } from './sessions.ts';
import { backgroundChatId, bareChatId, isAgentThread, threadLogKey } from './threadKey.ts';
import { ELROND_WORKSPACE_PATH } from '../config.ts';

export type FreshCaller = { id: string; name: string };

/** Leads allowed to fresh a lane. The route resolves the caller from the
 *  server-stamped MCP identity (RIVENDELL_AGENT_ID), never from a free-form
 *  `from`/`caller` a caller can invent. */
export function freshCallerFromAgentId(agentId: string): FreshCaller | null {
  const normalized = agentId.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'matt') return { id: 'matt', name: 'Matt' };
  return listAgents().find((a) => a.id.toLowerCase() === normalized) ?? null;
}

/** Resolve a caller from the lane's signed per-turn context. Engines whose
 *  tool server is shared across lanes (Banana's single serve process) carry
 *  no stamped RIVENDELL_AGENT_ID, so the same signed context computer_start
 *  takes is the identity there (review P1 5). The store rejects a context
 *  issued to another lane's turn (nonce check), so a pasted token cannot
 *  impersonate a lane that is not running it. */
export function freshCallerFromContextToken(token: string): FreshCaller | { error: string } {
  try {
    const ctx = readComputerContext(token);
    const bare = bareChatId(ctx.chatId);
    const agent = listAgents().find((a) => a.home === bare);
    if (!agent) return { error: 'that context belongs to no teammate lane' };
    return { id: agent.id, name: agent.name };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

const FRESH_CALLER_IDS = new Set(['matt', 'kip', 'chief-of-staff', 'riley']);

/** True when the resolved caller may fresh another lane's chat. */
export function canFreshChat(caller: FreshCaller | null): boolean {
  return !!caller && FRESH_CALLER_IDS.has(caller.id.trim().toLowerCase());
}

export type FreshChatResult =
  | { ok: true; agent: string; agentId: string }
  | { ok: false; reason: string };

function sameDisplayName(agents: Agent[], needle: string): Agent[] {
  return agents.filter((a) => a.name.trim().toLowerCase() === needle);
}

/** Resolve a lane for Fresh by id, exact home chatId, or unambiguous display
 *  name. Duplicate display names never resolve silently (P1: erasing the
 *  wrong agent's chat); the caller must name the roster id instead. */
export function resolveFreshTarget(agents: Agent[], name: string): { agent: Agent } | { error: string } {
  const needle = name.trim().toLowerCase();
  if (!needle) return { error: 'agent is required' };
  const byId = agents.find((a) => a.id.toLowerCase() === needle);
  if (byId) return { agent: byId };
  const byHome = agents.find((a) => bareChatId(a.home).toLowerCase() === needle);
  if (byHome) return { agent: byHome };
  const matches = sameDisplayName(agents, needle);
  if (matches.length === 1) return { agent: matches[0] };
  if (matches.length > 1) {
    return { error: `more than one teammate is named "${name}" — use the roster id (${matches.map((a) => a.id).join(', ')})` };
  }
  return { error: `no teammate named "${name}"` };
}

/** Live sessions that belong to this agent thread, main lane and background
 *  sibling alike, keyed by the durable thread log key so another workspace's
 *  chatId never matches (sessions carry their own cwd, and the key carries
 *  it too). */
export function sessionsForFreshThread<T extends { chatId: string; cwd: string; cli: string }>(
  sessions: T[],
  logKey: string,
  threadLogKeyFor: (cwd: string, chatId: string) => string,
): T[] {
  return sessions.filter((s) => threadLogKeyFor(s.cwd, s.chatId) === logKey);
}

/**
 * Fresh one agent's home chat. Refuses while any engine session for the
 * lane is busy. Never throws; a failure returns the reason.
 */
export async function freshChatForAgent(agent: Agent, caller: FreshCaller): Promise<FreshChatResult> {
  if (!canFreshChat(caller)) {
    return { ok: false, reason: 'only Matt, Kip, Max and Riley can fresh a chat' };
  }
  return freshThreadForAgent(agent);
}

/**
 * card-57def8: should a delivery that starts a new task land in a clean chat?
 * Pure decision so both the delivery path and its tests read the same rule:
 * the agent's switch must be on, the delivery must be a coder brief (the
 * same "new task" shape the brief envelope recognises), and the lane must be
 * idle — a busy lane's delivery steers a live turn, and a fresh must never
 * cut one.
 */
export function shouldFreshForTask(opts: {
  senderId: string;
  recipientId: string;
  recipientBusy: boolean;
  agent: Agent;
}): boolean {
  if (opts.recipientBusy) return false;
  if (!agentFreshChatPerTask(opts.agent)) return false;
  return isCoderBrief(opts.senderId, opts.recipientId);
}

/**
 * The reset itself, with no caller gating: the tool gates its caller above,
 * and the automatic per-task fresh is gated by the agent's own switch.
 * Refuses while any engine session for the lane is busy. Never throws.
 */
export async function freshThreadForAgent(agent: Agent): Promise<FreshChatResult> {
  const chatId = agent.home;
  if (!isAgentThread(chatId)) return { ok: false, reason: `${agent.name} has no home chat to fresh` };
  const brain = brainForAgent(agent);
  const cli = cliForAgentEngine(brain.engine) as CliKind;
  const logKey = threadLogKey(ELROND_WORKSPACE_PATH, chatId);

  const runner = await import('./runner.ts');
  const releaseReset = runner.beginThreadResetForLogKey(logKey);
  if (!releaseReset) return { ok: false, reason: `${agent.name}'s chat is already being reset` };
  try {
    // Settle any session lookup that entered before the barrier, then read
    // busy under it: no new turn can claim the lane while the reset runs.
    await runner.settleThreadSessionLookups({ cli, repoPath: ELROND_WORKSPACE_PATH, chatId });
    const sessions = runner.activeChatSessions();
    const laneSessions = sessionsForFreshThread(sessions, logKey, (cwd, id) => threadLogKey(cwd, id));
    const busy = laneSessions.some((s) => s.busy);
    if (busy) {
      return { ok: false, reason: `${agent.name} has a live turn — wait for it to end, then fresh` };
    }

    // Commit the reset generation before clearing anything (same order as
    // the UI freshStart): a client reconnecting mid-reset replays the
    // coherent log instead of trusting a stale cursor, and the WS layer
    // updates its epoch from the commit. freshStarted goes out only after
    // the wipe succeeds (review P1 3).
    const resetAt = await persistThreadResetEpoch(logKey, Math.max(Date.now(), threadResetEpoch(logKey) + 1));
    // The same live-socket cleanup the UI Fresh runs once the epoch commits
    // (review P1 2): every lane generation for this thread bumps, so a stale
    // waiter cannot write after the reset, and held steers die with the
    // thread. The broadcast waits for success below.
    freshLifecycleStarted({ logKey, repo: ELROND_WORKSPACE_PATH, chatId, cli });
    // Retire every live engine (idle ones too), main and background lanes,
    // and erase native resume ids, so switching back to an old engine cannot
    // resurrect the thread. interruptSession already covers the background
    // siblings for the lane; dropSession removes the warm processes.
    const retireChats = new Set<string>([chatId, backgroundChatId(chatId), ...laneSessions.map((s) => s.chatId)]);
    for (const s of laneSessions) {
      await runner.interruptSession({ cli: s.cli as CliKind, repoPath: s.cwd, chatId: s.chatId });
    }
    for (const s of laneSessions) {
      runner.dropSession(s.cli as CliKind, s.cwd, s.chatId);
    }
    // Any chatId variant seen live (account pins) retires under its own id too.
    for (const id of retireChats) {
      await runner.interruptSession({ cli, repoPath: ELROND_WORKSPACE_PATH, chatId: id }).catch(() => undefined);
    }
    await clearThreadSessionIds(ELROND_WORKSPACE_PATH, chatId, cli);
    // Clear the rolling compact and RAG mirror BEFORE the visible log (the
    // UI order): a failure here leaves the old thread coherent and retryable,
    // never a half-wiped seed that resurrects discarded history.
    await clearThreadMemory(logKey, chatId);
    const cleared = await clearEventLog(logKey);
    if (!cleared) return { ok: false, reason: 'fresh failed: the durable chat log could not be cleared' };
    // Only now, with the wipe durable, may connected clients drop their
    // cached transcript and replay the empty log (review P1 3).
    freshLifecycleCompleted({ logKey, repo: ELROND_WORKSPACE_PATH, chatId, cli, resetAt });
    return { ok: true, agent: agent.name, agentId: agent.id };
  } catch (err) {
    return { ok: false, reason: `fresh failed: ${(err as Error).message}` };
  } finally {
    releaseReset();
  }
}

/** HTTP-facing entry: resolve the agent, then fresh. */
export async function freshChatByName(agentName: string, caller: FreshCaller | null): Promise<FreshChatResult> {
  if (!caller) return { ok: false, reason: 'only a named teammate can fresh a chat' };
  if (!canFreshChat(caller)) return { ok: false, reason: 'only Matt, Kip, Max and Riley can fresh a chat' };
  const resolved = resolveFreshTarget(listAgents(), agentName);
  if ('error' in resolved) return { ok: false, reason: resolved.error };
  return freshChatForAgent(resolved.agent, caller);
}
