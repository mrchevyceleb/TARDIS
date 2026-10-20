// Fresh chat (card-8d427d, Matt Oct 20 2026): Matt, Kip, Max and Riley can
// give any agent a clean, empty chat with one move before a task, so the
// lane starts sharp on its instructions and the brief. The agent keeps its
// persona, memory files, commitments and Desk cards — only the chat
// history goes. Matt already has the UI Fresh button; this is the bus-level
// version the other leads can call.
//
// Safety: a lane with a live turn is never cleared — cutting work mid-flight
// would lose it. The reset bumps the thread's durable generation first
// (same store the UI freshStart commits), retires every live engine
// session and its native resume ids, then wipes the durable log, so no
// client or engine can resurrect the conversation that was just discarded.

import { brainForAgent, cliForAgentEngine, listAgents, type Agent } from './agents.ts';
import type { CliKind } from './runner.ts';
import { clearEventLog } from './event-log-store.ts';
import { persistThreadResetEpoch } from './threadResetStore.ts';
import { clearThreadSessionIds } from './sessions.ts';
import { backgroundChatId, isAgentThread, threadLogKey } from './threadKey.ts';
import { ELROND_WORKSPACE_PATH } from '../config.ts';

/** Leads allowed to fresh a lane, by roster id or display name (the MCP
 *  forwards whichever identity the runner stamped: id or name). */
const FRESH_CALLERS = new Set(['matt', 'kip', 'chief-of-staff', 'chief of staff', 'max', 'riley']);

/** True when the caller may fresh another lane's chat. */
export function canFreshChat(callerId: string): boolean {
  return FRESH_CALLERS.has(callerId.trim().toLowerCase());
}

export type FreshChatResult =
  | { ok: true; agent: string; agentId: string }
  | { ok: false; reason: string };

/** Find an agent by id or display name (case-insensitive). */
export function findAgentForFresh(name: string): Agent | null {
  const needle = name.trim().toLowerCase();
  if (!needle) return null;
  const agents = listAgents();
  return (
    agents.find((a) => a.id.toLowerCase() === needle)
    ?? agents.find((a) => a.name.trim().toLowerCase() === needle)
    ?? null
  );
}

/**
 * Fresh one agent's home chat. Refuses while any engine session for the
 * lane is busy. Never throws; a failure returns the reason.
 */
export async function freshChatForAgent(agent: Agent, callerId: string): Promise<FreshChatResult> {
  if (!canFreshChat(callerId)) {
    return { ok: false, reason: 'only Matt, Kip, Max and Riley can fresh a chat' };
  }
  const chatId = agent.home;
  if (!isAgentThread(chatId)) return { ok: false, reason: `${agent.name} has no home chat to fresh` };
  const brain = brainForAgent(agent);
  const cli = cliForAgentEngine(brain.engine);
  const logKey = threadLogKey(ELROND_WORKSPACE_PATH, chatId);

  const runner = await import('./runner.ts');
  const sessions = runner.activeChatSessions();
  const laneSessions = sessions.filter((s) => s.chatId === chatId || s.chatId === backgroundChatId(chatId));
  const busy = laneSessions.some((s) => s.busy);
  if (busy) {
    return { ok: false, reason: `${agent.name} has a live turn — wait for it to end, then fresh` };
  }

  try {
    // Commit the reset generation before clearing anything (the UI
    // freshStart does the same): clients then replay the coherent new log.
    const resetAt = Date.now();
    await persistThreadResetEpoch(logKey, resetAt);
    // Retire every live engine (idle ones too) and erase native resume ids,
    // so switching back to an old engine cannot resurrect the thread.
    for (const s of laneSessions) {
      await runner.interruptSession({ cli: s.cli, repoPath: s.cwd, chatId: s.chatId });
      runner.dropSession(s.cli, s.cwd, s.chatId);
    }
    await clearThreadSessionIds(ELROND_WORKSPACE_PATH, chatId, cli as CliKind);
    await clearEventLog(logKey);
    return { ok: true, agent: agent.name, agentId: agent.id };
  } catch (err) {
    return { ok: false, reason: `fresh failed: ${(err as Error).message}` };
  }
}

/** HTTP-facing entry: resolve the agent, then fresh. */
export async function freshChatByName(agentName: string, callerId: string): Promise<FreshChatResult> {
  const agent = findAgentForFresh(agentName);
  if (!agent) return { ok: false, reason: `no teammate named "${agentName}"` };
  return freshChatForAgent(agent, callerId);
}
