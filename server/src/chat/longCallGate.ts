// Long foreground call gate wiring. The hook script (server/scripts/long-call-gate.mjs)
// blocks obviously long shell calls with a "use job_start" error and nudges after 60s.
// Agent home threads only. Claude spawns carry the hook in per-spawn --settings; Codex
// and Pi read a global hook/extension, so TARDIS marks agent-thread spawns through the
// environment and the global hook stays inert for every other run on the machine.

import { LONG_CALL_GATE_SCRIPT } from '../config.ts';
import { agentForChatId } from './agents.ts';
import { isAgentThread } from './threadKey.ts';
import { isVoiceChatId } from './voicePrompt.ts';

function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The agent name the gate acts for on this chat, or null when it does not apply
 *  (not an agent thread, a voice thread, or switched off). */
function gateAgent(chatId: string): string | null {
  if (process.env.RIVENDELL_LONG_CALL_GATE === 'off') return null;
  if (!isAgentThread(chatId) || isVoiceChatId(chatId)) return null;
  return agentForChatId(chatId)?.name ?? chatId;
}

/** `--settings` JSON for a Claude-family spawn, or null when the gate does not apply. */
export function longCallGateSettings(chatId: string): string | null {
  const who = gateAgent(chatId);
  if (!who) return null;
  const command = (mode: 'pre' | 'post') => `node ${shq(LONG_CALL_GATE_SCRIPT)} ${mode} ${shq(who)}`;
  const entry = (mode: 'pre' | 'post') => [{ matcher: 'Bash', hooks: [{ type: 'command', command: command(mode), timeout: 10 }] }];
  return JSON.stringify({
    hooks: {
      PreToolUse: entry('pre'),
      PostToolUse: entry('post'),
      PostToolUseFailure: entry('post'),
    },
  });
}

/** Spawn-environment additions for a Codex or Pi spawn. The installed global hook
 *  (Codex hooks.json) and Pi extension do nothing unless RIVENDELL_LONG_CALL_GATE_AGENT
 *  is set, and run the script at RIVENDELL_LONG_CALL_GATE_SCRIPT, so they always use
 *  the same rules as the Claude gate. Empty when the gate does not apply. */
export function longCallGateEnv(chatId: string): Record<string, string> {
  const who = gateAgent(chatId);
  if (!who) return {};
  return { RIVENDELL_LONG_CALL_GATE_AGENT: who, RIVENDELL_LONG_CALL_GATE_SCRIPT: LONG_CALL_GATE_SCRIPT };
}
