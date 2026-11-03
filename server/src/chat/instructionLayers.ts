// Every instruction an agent gets, layer by layer, from the real files
// (Matt, Nov 3 2026: "i want to be able to easily directly manage ALL CONTEXT
// and instructions ALL agents in tardis get"). The Instructions room reads
// this to show each agent's whole prompt and edits the files in place.

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { STATE_DIR } from './config.ts';
import { agentForChatId, cliForAgentEngine, listAgents, type Agent } from './agents.ts';
import { PERSONAS_DIR, engineRule, personaPromptFor } from './personaPrompts.ts';
import { sessionDirectory, sessionPolicy } from './sessionPolicy.ts';
import { plainEnglishWritingSystemBlockFor } from './plain-english-guidance.ts';
import { SHARED_RULES, SHARED_RULE_IDS, sharedRule, sharedRuleFile, sharedRuleText, transcriptGuidance, type SharedRuleId } from './sharedRules.ts';
import { DESK_ROOM_ENABLED, ELROND_WORKSPACE_PATH } from '../config.ts';

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

const shortHome = (path: string) => path.replace(homedir(), '~');

/** Engine rules reach only agents whose runner adds them. */
function ruleApplies(id: SharedRuleId, agent: Agent): boolean {
  const engine = SHARED_RULES[id].engine;
  if (!engine) return true;
  const cli = cliForAgentEngine(agent.engine ?? '');
  if (engine === 'gemini') return Boolean(plainEnglishWritingSystemBlockFor({ cli, model: agent.model ?? '' }));
  return cli === engine;
}

/** What TARDIS itself puts in front of the model for an agent's home thread,
 *  assembled the same way each runner does (voice-only additions aside). */
function assembledFor(agent: Agent): string {
  const cli = cliForAgentEngine(agent.engine ?? '');
  const persona = personaPromptFor(agent.home);
  if (cli === 'codex') return [persona, sharedRule('engine-codex')].filter(Boolean).join('\n\n');
  if (cli === 'muse' || cli === 'agy' || cli === 'pi') return [persona, engineRule(`engine-${cli}`, agent.home), transcriptGuidance()].filter(Boolean).join('\n\n');
  return [persona, plainEnglishWritingSystemBlockFor({ cli, model: agent.model ?? '' }), transcriptGuidance()].filter(Boolean).join('\n\n');
}

/** The files behind one agent's instructions, in the order the agent reads them. */
function sources(agent: Agent): Source[] {
  const chatId = agent.home;
  const policy = sessionPolicy(chatId);
  const cli = cliForAgentEngine(agent.engine ?? '');
  const out: Source[] = [];
  const push = (key: string, title: string, note: string, path: string | null) => { if (path) out.push({ key, title, note, path }); };
  // TARDIS adds the house rules itself and tells Claude Code to skip that
  // same file, so it is never also a project layer.
  const house = policy.houseRules ? real(policy.houseRules) : null;
  const excluded = new Set([...(policy.excludeInstructions ?? []).map(real), house].filter(Boolean));

  // Loaded by the engine itself, not by TARDIS. Claude Code reads its
  // profile's CLAUDE.md plus every CLAUDE.md from the working folder up to
  // the root; Codex reads ~/.codex/AGENTS.md plus every AGENTS.md from the
  // repository root down to the working folder. Engines on other profiles
  // (OpenRouter, xAI, Muse) never see these files.
  if (cli === 'claude') push('global', 'Global rules', 'Every Claude agent. Claude Code loads this file itself.', real('~/.claude-tardis/CLAUDE.md'));
  if (cli === 'codex') push('global', 'Global rules', 'Every Codex agent. Codex loads this file itself.', real('~/.codex/AGENTS.md'));
  if (cli === 'claude' || cli === 'codex') {
    const name = cli === 'claude' ? 'CLAUDE.md' : 'AGENTS.md';
    const cwd = sessionDirectory(chatId, ELROND_WORKSPACE_PATH);
    const folders: string[] = [];
    for (let dir = cwd; ; dir = dirname(dir)) {
      folders.unshift(dir);
      if (dirname(dir) === dir) break;
    }
    // Codex stops at the nearest repository root; Claude Code walks to the top.
    const hasGit = (dir: string) => { try { statSync(join(dir, '.git')); return true; } catch { return false; } };
    const root = cli === 'codex' ? folders.map(hasGit).lastIndexOf(true) : -1;
    for (const dir of root > 0 ? folders.slice(root) : folders) {
      const file = real(join(dir, name));
      if (file && !excluded.has(file) && !out.some(s => s.path === file)) {
        push(`project:${file}`, 'Project rules', `The ${name} in ${dir === cwd ? "this agent's working folder" : shortHome(dir)}, loaded by the engine.`, file);
      }
    }
  }
  push('persona', 'Persona', 'Who this agent is and how it works. Only this agent.', real(join(PERSONAS_DIR, `${agent.id}.md`)));
  push('house', 'House rules', 'Added by TARDIS for every agent that has house rules set.', house);
  if (policy.notesCharacters) push('notes', 'Own notes', `The agent's own notes. It sees the start and the newest ${policy.notesCharacters} characters.`, real(join(STATE_DIR, 'agent-notes', agent.id, 'notes.md')));
  for (const brief of [...new Set(policy.briefs ?? [])]) push(`brief:${brief}`, `Team brief: ${brief.replace(/\.md$/, '')}`, 'Added by TARDIS for every agent on this team.', real(join(STATE_DIR, 'briefs', brief)));
  for (const id of SHARED_RULE_IDS) {
    if (id === 'desk' && !DESK_ROOM_ENABLED) continue;
    if (!ruleApplies(id, agent)) continue;
    sharedRuleText(id); // seeds the file on a fresh install
    push(`rule:${id}`, SHARED_RULES[id].title, 'Shared rule added by TARDIS for every agent.', real(sharedRuleFile(id)));
  }
  return out;
}

/** Changes whenever the text of a file behind this thread's instructions
 *  changes, so a warm engine process that read them at spawn can be replaced
 *  at its next idle turn. Content, not mtime: saving unchanged text restarts
 *  nobody. The agent's own notes are left out: it writes them itself all
 *  day, and they are a running excerpt, not instructions. `profile` is the
 *  Claude profile folder the process actually runs on, whose CLAUDE.md the
 *  engine loads (the global rules); no other profile's file counts. */
export function instructionsStamp(chatId: string, profile?: string | null): string {
  const agent = agentForChatId(chatId);
  if (!agent) return '';
  try {
    const paths = sources(agent).filter(s => s.key !== 'notes' && s.key !== 'global').map(s => s.path);
    const global = profile ? real(join(profile, 'CLAUDE.md')) ?? real('~/.claude/CLAUDE.md') : null;
    if (global && !paths.includes(global)) paths.push(global);
    else if (!profile) for (const s of sources(agent)) if (s.key === 'global' && !paths.includes(s.path)) paths.push(s.path);
    const hash = createHash('sha256');
    for (const path of paths) {
      hash.update(path).update('\0');
      try { hash.update(readFileSync(path)); } catch { hash.update('-'); }
      hash.update('\0');
    }
    return hash.digest('hex');
  } catch { return ''; }
}

export function instructionLayers(agentId: string): { agent: Agent; layers: InstructionLayer[]; assembled: string } | null {
  const agents = listAgents();
  const agent = agents.find(a => a.id === agentId);
  if (!agent) return null;
  const users = new Map<string, string[]>();
  for (const other of agents) {
    try { for (const s of sources(other)) users.set(s.path, [...new Set([...(users.get(s.path) ?? []), other.id])]); }
    catch { /* one broken policy never hides the others */ }
  }
  const layers = sources(agent).flatMap((s): InstructionLayer[] => {
    const file = read(s.path);
    if (!file) return [];
    return [{ ...s, text: file.text, bytes: Buffer.byteLength(file.text), mtime: file.mtime, sharedWith: users.get(s.path) ?? [agent.id] }];
  });
  // Exactly what TARDIS itself puts in front of the model, after the
  // engine-loaded files above.
  const assembled = assembledFor(agent);
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
