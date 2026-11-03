// Every instruction an agent gets, layer by layer, from the real files
// (Matt, Nov 3 2026: "i want to be able to easily directly manage ALL CONTEXT
// and instructions ALL agents in tardis get"). The Instructions room reads
// this to show each agent's whole prompt and edits the files in place.

import { readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { STATE_DIR } from './config.ts';
import { listAgents, type Agent } from './agents.ts';
import { PERSONAS_DIR, personaPromptFor } from './personaPrompts.ts';
import { sessionPolicy } from './sessionPolicy.ts';
import { SHARED_RULES, SHARED_RULE_IDS, sharedRuleFile, sharedRuleText, transcriptGuidance } from './sharedRules.ts';
import { DESK_ROOM_ENABLED } from '../config.ts';

export type InstructionLayer = {
  /** Stable key for the UI. */
  key: string;
  title: string;
  /** Plain words on what this layer is and who loads it. */
  note: string;
  path: string;
  text: string;
  bytes: number;
  mtime: number;
  /** Agent ids that receive this same file. */
  sharedWith: string[];
};

const expand = (path: string) => resolve(path.replace(/^~\//, `${homedir()}/`));

function real(path: string): string | null {
  try { return realpathSync(expand(path)); } catch { return null; }
}

function read(path: string): { text: string; mtime: number } | null {
  try { return { text: readFileSync(path, 'utf8'), mtime: statSync(path).mtimeMs }; } catch { return null; }
}

type Source = { key: string; title: string; note: string; path: string };

/** The files behind one agent's instructions, in the order the agent reads them. */
function sources(agent: Agent): Source[] {
  const chatId = agent.home;
  const policy = sessionPolicy(chatId);
  const engine = agent.engine ?? '';
  const out: Source[] = [];
  const push = (key: string, title: string, note: string, path: string | null) => { if (path) out.push({ key, title, note, path }); };
  const excluded = new Set((policy.excludeInstructions ?? []).map(real).filter(Boolean));

  // Loaded by the engine itself, not by TARDIS: Claude Code reads its
  // profile's CLAUDE.md, Codex reads ~/.codex/AGENTS.md. Engines on other
  // profiles (OpenRouter, xAI, Muse) never see these files.
  if (engine === 'claude') push('global', 'Global rules', 'Every Claude agent. Claude Code loads this file itself.', real('~/.claude-tardis/CLAUDE.md'));
  if (engine === 'codex') push('global', 'Global rules', 'Every Codex agent. Codex loads this file itself.', real('~/.codex/AGENTS.md'));
  if (policy.directory && (engine === 'claude' || engine === 'codex')) {
    const name = engine === 'claude' ? 'CLAUDE.md' : 'AGENTS.md';
    const file = real(join(expand(policy.directory), name));
    if (file && !excluded.has(file)) push('project', 'Project rules', `The ${name} in this agent's working folder, loaded by the engine.`, file);
  }
  push('persona', 'Persona', 'Who this agent is and how it works. Only this agent.', real(join(PERSONAS_DIR, `${agent.id}.md`)));
  if (policy.houseRules) push('house', 'House rules', 'Added by TARDIS for every agent that has house rules set.', real(policy.houseRules));
  if (policy.notesCharacters) push('notes', 'Own notes', `The agent's own notes. It sees the start and the newest ${policy.notesCharacters} characters.`, real(join(STATE_DIR, 'agent-notes', agent.id, 'notes.md')));
  for (const brief of [...new Set(policy.briefs ?? [])]) push(`brief:${brief}`, `Team brief: ${brief.replace(/\.md$/, '')}`, 'Added by TARDIS for every agent on this team.', real(join(STATE_DIR, 'briefs', brief)));
  for (const id of SHARED_RULE_IDS) {
    if (id === 'desk' && !DESK_ROOM_ENABLED) continue;
    sharedRuleText(id); // seeds the file on a fresh install
    push(`rule:${id}`, SHARED_RULES[id].title, 'Shared rule added by TARDIS for every agent.', real(sharedRuleFile(id)));
  }
  return out;
}

export function instructionLayers(agentId: string): { agent: Agent; layers: InstructionLayer[]; assembled: string } | null {
  const agents = listAgents();
  const agent = agents.find(a => a.id === agentId);
  if (!agent) return null;
  const users = new Map<string, string[]>();
  for (const other of agents) {
    try { for (const s of sources(other)) users.set(s.path, [...(users.get(s.path) ?? []), other.id]); }
    catch { /* one broken policy never hides the others */ }
  }
  const layers = sources(agent).flatMap((s): InstructionLayer[] => {
    const file = read(s.path);
    if (!file) return [];
    return [{ ...s, text: file.text, bytes: Buffer.byteLength(file.text), mtime: file.mtime, sharedWith: users.get(s.path) ?? [agent.id] }];
  });
  // Exactly what TARDIS itself puts in front of the model, after the
  // engine-loaded files above.
  const assembled = [personaPromptFor(agent.home), transcriptGuidance()].filter(Boolean).join('\n\n');
  return { agent, layers, assembled };
}

export class InstructionEditError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** Saves one instruction file. Only files some agent actually loads can be
 *  written, and a stale mtime is refused so two editors never clobber. */
export function saveInstructionFile(path: string, text: string, mtime: number): { mtime: number; bytes: number } {
  const target = real(path);
  const allowed = new Set(listAgents().flatMap(a => { try { return sources(a).map(s => s.path); } catch { return []; } }));
  if (!target || !allowed.has(target)) throw new InstructionEditError('That file is not an agent instruction file.', 400);
  const current = statSync(target).mtimeMs;
  if (Math.abs(current - mtime) > 1) throw new InstructionEditError('This file changed since you opened it. Reload to see the latest.', 409);
  const body = text.endsWith('\n') ? text : `${text}\n`;
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, target);
  return { mtime: statSync(target).mtimeMs, bytes: Buffer.byteLength(body) };
}
