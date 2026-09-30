// Long foreground call gate wiring: settings for the Claude CLI hooks. The hook
// script (server/scripts/long-call-gate.mjs) blocks obviously long shell calls
// with a "use job_start" error and nudges after 60s. Agent home threads only.

import { LONG_CALL_GATE_SCRIPT } from '../config.ts';
import { agentForChatId } from './agents.ts';
import { isAgentThread } from './threadKey.ts';
import { isVoiceChatId } from './voicePrompt.ts';

function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** `--settings` JSON for a Claude-family spawn, or null when the gate does not
 *  apply (not an agent thread, a voice thread, or switched off). */
export function longCallGateSettings(chatId: string): string | null {
  if (process.env.RIVENDELL_LONG_CALL_GATE === 'off') return null;
  if (!isAgentThread(chatId) || isVoiceChatId(chatId)) return null;
  const who = agentForChatId(chatId)?.name ?? chatId;
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
