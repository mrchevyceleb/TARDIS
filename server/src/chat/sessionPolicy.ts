import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { STATE_DIR } from './config.ts';
import { bareChatId, isAgentThread } from './threadKey.ts';

/** Operator-owned configuration, so another installation can map its own team. */
export type AgentSessionPolicy = {
  directory?: string;
  skills?: string[];
  lead?: boolean;
  memoryIndex?: boolean;
  excludeInstructions?: string[];
  startTokenCeiling?: number;
};
type Policy = { agents?: Record<string, AgentSessionPolicy>; defaults?: AgentSessionPolicy };

export function sessionPolicy(chatId: string): AgentSessionPolicy {
  if (!isAgentThread(chatId)) return {};
  const file = process.env.RIVENDELL_SESSION_POLICY_FILE || join(STATE_DIR, 'agent-session-policy.json');
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as Policy;
    return { ...data.defaults, ...data.agents?.[bareChatId(chatId).slice(4)] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return {};
  }
}

export function sessionDirectory(chatId: string, fallback: string): string {
  const configured = sessionPolicy(chatId).directory;
  if (!configured) return fallback;
  return resolve(configured === '~' ? homedir() : configured.replace(/^~\//, `${homedir()}/`));
}

/** The generation permits exactly one cutover from TARDIS-seeded sessions. */
export const NATIVE_SESSION_GENERATION = 1;
export const NATIVE_COMPACT_TOKENS = 300_000;

/** Per-session deltas: unchanged status never consumes another model call's context. */
export function changedContext(previous: Map<string, string>, name: string, text: string): string {
  if (previous.get(name) === text) return '';
  previous.set(name, text);
  return text;
}

/** Native skill overrides retain every callable skill while keeping only the
 * role's descriptions in the fixed prompt. No account/profile files change. */
export function nativeClaudeSettings(chatId: string): Record<string, unknown> {
  const policy = sessionPolicy(chatId);
  const descriptions = new Set(policy.skills ?? ['codex-fix', 'opus-fix', 'no-crap-allowed']);
  const skillOverrides: Record<string, string> = {};
  for (const root of [join(homedir(), '.claude', 'skills'), join(homedir(), '.claude-tardis', 'skills')]) {
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory() || entry.isSymbolicLink()) skillOverrides[entry.name] = descriptions.has(entry.name) ? 'on' : 'name-only';
      }
    } catch { /* an installation may not have this profile */ }
  }
  return {
    skillOverrides,
    autoMemoryEnabled: policy.memoryIndex === true,
    ...(policy.excludeInstructions?.length ? { claudeMdExcludes: policy.excludeInstructions } : {}),
  };
}
