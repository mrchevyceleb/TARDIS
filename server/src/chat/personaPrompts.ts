// Persona scope documents — each agent's "who I am / what I do" markdown.
// Records (which agent owns which file) live in agents.ts; this module only
// reads/writes the files with an mtime hot-reload cache.

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from './config.ts';
import { agentForChatId, cliForAgentEngine, wantsFullToolbox } from './agents.ts';
import { DESK_ROOM_ENABLED } from '../config.ts';
import { sessionBriefs, sessionMemory, taskControlGuidance } from './sessionPolicy.ts';
import { sharedRule, type SharedRuleId } from './sharedRules.ts';

export const PERSONAS_DIR = join(STATE_DIR, 'personas');

const cache = new Map<string, { mtime: number; text: string }>();

function readScopeFile(file: string): string {
  const path = join(PERSONAS_DIR, file);
  try {
    const mtime = statSync(path).mtimeMs;
    const hit = cache.get(path);
    if (hit && hit.mtime === mtime) return hit.text;
    const text = readFileSync(path, 'utf8').trim();
    cache.set(path, { mtime, text });
    return text;
  } catch {
    return '';
  }
}

/** The agent's scope for a home-thread chatId ('' when no agent owns it). */
export function personaPromptFor(chatId: string, memory = sessionMemory(chatId)): string {
  const agent = agentForChatId(chatId);
  // A non-roster lane has no persona and no roster toolbox entry — it mounts
  // the full toolbox, so it still needs the router guidance that moved out of
  // the global AGENTS.md (lean is a roster choice; nothing else can be lean).
  if (!agent) return sharedRule('ops-toolbox');
  const scope = readScopeFile(`${agent.id}.md`);
  // The ops-toolbox rule (assistant-mcp router guidance) rides the same
  // roster setting as the MCP mount itself: lean lanes have no assistant-mcp,
  // so they never see its instructions either. Antigravity mounts no
  // TARDIS-managed MCP at all (one machine-global config TARDIS never
  // writes), so its lanes never see the rule either, whatever the toolbox.
  const mountsOfficeTools = wantsFullToolbox(agent) && cliForAgentEngine(agent.engine) !== 'agy';
  return [scope, memory, sessionBriefs(chatId), taskControlGuidance(chatId), sharedRule('team-status'), sharedRule('background-jobs'), sharedRule('sidebar'), DESK_ROOM_ENABLED ? sharedRule('desk') : null, mountsOfficeTools ? sharedRule('ops-toolbox') : null].filter(Boolean).join('\n\n');
}

/** Scope text for an agent record's home (REST use). */
export function personaScopeFor(home: string): string {
  const agent = agentForChatId(home);
  if (!agent) return '';
  return readScopeFile(`${agent.id}.md`);
}

/** Write an agent's scope file (create/update path). */
export function writeScopeFile(file: string, body: string): void {
  mkdirSync(PERSONAS_DIR, { recursive: true });
  writeFileSync(join(PERSONAS_DIR, file), body);
}

/** An engine's own basics, addressed to the agent by name. */
export const engineRule = (id: SharedRuleId, chatId: string): string =>
  sharedRule(id, { name: agentForChatId(chatId)?.name ?? 'a teammate' });
