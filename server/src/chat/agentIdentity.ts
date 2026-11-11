// Who an agent's own process is. Every agent-thread spawn carries its stable
// roster id in the environment, so anything the agent runs from its shell can
// say whose work it is (the T3 Code launcher records a session's owner from it).

import { agentForChatId } from './agents.ts';
import { isAgentThread } from './threadKey.ts';

export function agentIdentityEnv(chatId: string): Record<string, string> {
  const agent = isAgentThread(chatId) ? agentForChatId(chatId) : undefined;
  return agent ? { RIVENDELL_AGENT_ID: agent.id } : {};
}
