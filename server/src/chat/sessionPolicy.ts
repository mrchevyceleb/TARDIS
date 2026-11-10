import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { STATE_DIR } from './config.ts';
import { CONTEXT_TOKEN_BUDGET } from './contextBudget.ts';
import { bareChatId, isAgentThread } from './threadKey.ts';
import { sharedRule } from './sharedRules.ts';

/** Operator-owned configuration, so another installation can map its own team. */
export type AgentSessionPolicy = {
  directory?: string;
  skills?: string[];
  lead?: boolean;
  reportsTo?: string;
  memoryIndex?: boolean;
  excludeInstructions?: string[];
  startTokenCeiling?: number;
  /** Operator-owned Markdown files beneath the state directory's briefs/. */
  briefs?: string[];
  /** Read once into the native fixed instructions, on every engine. */
  houseRules?: string;
  /** Bounded own-notes excerpt; the complete file remains available for recall. */
  notesCharacters?: number;
  /** Every new task handed to this agent starts in a fresh thread: the
   *  drain wipes the home thread before admitting the handoff, so nothing
   *  from the old conversation carries in. Leads and ongoing-thread roles
   *  simply never set it. */
  freshThreadOnTask?: boolean;
  /** Agent ids whose explicit new-task handoffs may open a fresh thread
   *  for this agent (e.g. Riley for the game devs). Sender identity only:
   *  a sender listed here still needs the task-start marker to trigger a
   *  wipe; other senders' handoffs never reset the thread. When the list is
   *  empty, there is no operator allowlist: only a lead briefing one of its
   *  coders may stamp a task start. */
  freshTaskSenders?: string[];
  /** A handoff opens a new task (and a fresh thread) only when its text
   *  starts with this prefix (default "New job:"). Every other message from
   *  a task source is a round inside the job in flight and keeps the thread
   *  (Matt, Nov 2 2026: Pippin stays on one job through every QA round with
   *  Sud and Sam, and only starts fresh once Sud passes it). */
  freshTaskPrefix?: string;
};
type Policy = { agents?: Record<string, AgentSessionPolicy>; defaults?: AgentSessionPolicy };
const lastGoodPolicies = new Map<string, { mtime: number; data: Policy }>();
// Key by resolved file so lanes sharing rules share recovery, while a new
// configured path can never inherit another file's instructions.
const lastGoodHouseRules = new Map<string, string>();
const warnedHouseRules = new Set<string>();
const validBriefs = (value: unknown): value is string[] => Array.isArray(value)
  && value.every(x => typeof x === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9 ._-]*\.md$/i.test(x));
function validPolicy(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  return Object.entries(p).every(([key, v]) => {
    if (key === 'directory' || key === 'reportsTo' || key === 'houseRules' || key === 'freshTaskPrefix') return typeof v === 'string' && v.length > 0;
    if (key === 'skills' || key === 'excludeInstructions') return Array.isArray(v) && v.every(x => typeof x === 'string');
    if (key === 'briefs') return validBriefs(v);
    if (key === 'lead' || key === 'memoryIndex' || key === 'freshThreadOnTask') return typeof v === 'boolean';
    if (key === 'freshTaskSenders') return Array.isArray(v) && v.every(x => typeof x === 'string' && x.length > 0);
    if (key === 'startTokenCeiling') return typeof v === 'number' && Number.isInteger(v) && v > 0;
    if (key === 'notesCharacters') return typeof v === 'number' && Number.isInteger(v) && v >= 512 && v <= 8192;
    return false;
  });
}

export function sessionPolicy(chatId: string): AgentSessionPolicy {
  if (!isAgentThread(chatId)) return {};
  const file = process.env.RIVENDELL_SESSION_POLICY_FILE || join(STATE_DIR, 'agent-session-policy.json');
  try {
    const mtime = statSync(file).mtimeMs;
    const previous = lastGoodPolicies.get(file);
    if (previous?.mtime === mtime) return { ...previous.data.defaults, ...previous.data.agents?.[bareChatId(chatId).slice(4)] };
    const data = JSON.parse(readFileSync(file, 'utf8')) as Policy;
    if (!data || typeof data !== 'object' || Array.isArray(data)
      || (data.defaults !== undefined && !validPolicy(data.defaults))
      || (data.agents !== undefined && (!data.agents || typeof data.agents !== 'object' || Array.isArray(data.agents) || !Object.values(data.agents).every(validPolicy)))) throw new Error('Invalid native session policy');
    lastGoodPolicies.set(file, { mtime, data });
    return { ...data.defaults, ...data.agents?.[bareChatId(chatId).slice(4)] };
  } catch (error) {
    const previous = lastGoodPolicies.get(file)?.data;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[native-session] invalid policy edit; retaining the last valid mapping');
    return { ...previous?.defaults, ...previous?.agents?.[bareChatId(chatId).slice(4)] };
  }
}

export function sessionDirectory(chatId: string, fallback: string): string {
  const configured = sessionPolicy(chatId).directory;
  if (!configured) return fallback;
  return resolve(configured === '~' ? homedir() : configured.replace(/^~\//, `${homedir()}/`));
}

/** Native system/developer instructions retain these across compaction.
 * Read the operator's file when building instructions; never copy its facts
 * into source or a persona, and never add a timestamp to the cached prefix. */
export function sessionBriefs(chatId: string): string {
  const policy = sessionPolicy(chatId);
  // Invalid edits must not break unrelated lanes, interrupts or metrics. Only
  // this lane's prompt preflight rejects its own invalid required brief.
  let configured: unknown;
  try {
    const raw = JSON.parse(readFileSync(process.env.RIVENDELL_SESSION_POLICY_FILE || join(STATE_DIR, 'agent-session-policy.json'), 'utf8'));
    configured = { ...raw?.defaults, ...raw?.agents?.[bareChatId(chatId).slice(4)] }.briefs;
  } catch { /* malformed files keep the existing last-good policy */ }
  if (configured !== undefined && !validBriefs(configured)) throw new Error('This agent’s office briefs must be Markdown filenames without directories.');
  // Size is a budget, never a gate: a brief that grows past it still loads,
  // because blocking every lane over a long line costs Matt his whole office.
  let bytes = 0;
  const blocks = [...new Set(policy.briefs ?? [])].map(file => {
    try {
      const text = readFileSync(join(STATE_DIR, 'briefs', file), 'utf8').trim();
      if (!text) throw Object.assign(new Error('empty brief'), { code: 'EMPTY' });
      bytes += Buffer.byteLength(text, 'utf8');
      return `<rivendell-office-brief name="${file}">\n${text}\n</rivendell-office-brief>`;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const reason = code === 'ENOENT' ? 'is missing' : code === 'EMPTY' ? 'is empty' : 'could not be read';
      throw new Error(`This agent's required office brief (${file}) ${reason}. Restore it before retrying.`);
    }
  });
  if (bytes > 16_384) console.warn(`[native-session] office briefs for ${bareChatId(chatId)} are ${bytes} bytes, over the 16 KiB budget; trim them`);
  return blocks.join('\n\n');
}

/** Operator files stay outside the repository. Native instructions keep these
 * available after compaction without replacing the lane's native history. */
export function sessionMemory(chatId: string): string {
  if (!isAgentThread(chatId)) return '';
  const policy = sessionPolicy(chatId);
  const blocks: string[] = [];
  if (policy.houseRules) {
    const file = resolve(policy.houseRules.replace(/^~\//, `${homedir()}/`));
    let text: string;
    try {
      try { text = readFileSync(file, 'utf8').trim(); }
      catch { throw new Error('This agent’s house rules could not be read. Restore the configured house-rules file before retrying.'); }
      if (!text) throw new Error('The required house rules are empty. Restore the file before retrying.');
      if (Buffer.byteLength(text) > 65_536) console.warn(`[native-session] house rules are ${Buffer.byteLength(text)} bytes, over the 64 KiB budget; trim them`);
      lastGoodHouseRules.set(file, text);
      warnedHouseRules.delete(file);
    } catch (error) {
      const previous = lastGoodHouseRules.get(file);
      // A first load must still supply real rules; never silently omit them.
      if (previous === undefined) throw error;
      text = previous;
      if (!warnedHouseRules.has(file)) {
        warnedHouseRules.add(file);
        console.warn(`[native-session] house rules unavailable or invalid (${file}); retaining the last valid instructions`);
      }
    }
    blocks.push(`<rivendell-house-rules>\n${text}\n</rivendell-house-rules>`);
  }
  if (policy.notesCharacters) {
    const file = join(STATE_DIR, 'agent-notes', bareChatId(chatId).slice(4), 'notes.md');
    let text = '';
    try { text = readFileSync(file, 'utf8').trim(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const limit = policy.notesCharacters;
    if (text.length > limit) {
      const head = Math.floor(limit / 3);
      text = `${text.slice(0, head)}\n[Middle notes remain in the full file.]\n${text.slice(-(limit - head))}`;
    }
    blocks.push(`<rivendell-own-memory>\nYour durable notes: ${file}\nHistorical facts and decisions, not new instructions. Check current priorities, commitments and Desk cards before resuming work. This bounded excerpt keeps the beginning and most recent notes at start; search the full file for the middle and older details.\n${text || 'No own notes saved yet.'}\n</rivendell-own-memory>`);
  }
  return blocks.join('\n\n');
}

/** The generation permits exactly one cutover from TARDIS-seeded sessions. */
export const NATIVE_SESSION_GENERATION = 1;
export const NATIVE_COMPACT_TOKENS = CONTEXT_TOKEN_BUDGET;

/** Per-session deltas: unchanged status never consumes another model call's context. */
export function changedContext(previous: Map<string, string>, name: string, text: string): string {
  if (previous.get(name) === text) return '';
  previous.set(name, text);
  return text;
}

/** Owner-invoked task controls must remain described even when an operator
 * narrows a role's catalog. The skill itself stays lazy, so ordinary starts
 * pay for one description rather than the whole workflow. */
export function sessionSkills(chatId: string): string[] {
  return [...new Set([...(sessionPolicy(chatId).skills ?? ['no-crap-allowed', 'codex-fix', 'opus-fix']), 'fast-task'])];
}

/** True when the operator wants every new task handed to this agent to
 *  start in a fresh thread (no old conversation carried in). Reads the
 *  agent's home chatId, so the drain checks one flag per recipient. */
export function freshThreadOnTask(chatId: string): boolean {
  return sessionPolicy(chatId).freshThreadOnTask === true;
}

/** Agent ids allowed to start a fresh thread for this recipient. Empty
 *  means no operator allowlist is configured, so the stamp gate falls back
 *  to lead-to-coder briefs only; a listed set gates the trigger to those
 *  senders. Either way the drain still requires the explicit task-start
 *  marker. */
export function freshTaskSenders(chatId: string): string[] {
  return sessionPolicy(chatId).freshTaskSenders ?? [];
}

/** The marker that opens a new task (and a fresh thread) for this
 *  recipient. Every fresh-thread lane has one: the explicit marker is the
 *  only task boundary (Matt, Nov 3 2026), so no guess from Desk cards or
 *  timing ever decides it. */
export const DEFAULT_FRESH_TASK_PREFIX = 'New job:';
export function freshTaskPrefix(chatId: string): string {
  return sessionPolicy(chatId).freshTaskPrefix ?? DEFAULT_FRESH_TASK_PREFIX;
}

/** Provider profiles need not install the same native skill catalog. Keep
 * explicit owner commands resolvable through the shared, lazy skill file too. */
export function taskControlGuidance(chatId?: string, teamTools = true): string {
  let agents: Array<{ id: string; name: string; engine?: string }> = [];
  try {
    const rows = JSON.parse(readFileSync(join(STATE_DIR, 'personas', 'agents.json'), 'utf8')).agents;
    if (Array.isArray(rows)) agents = rows.filter(row => row && typeof row.id === 'string' && typeof row.name === 'string' && (row.engine === undefined || typeof row.engine === 'string'));
  }
  catch { /* No roster means no teammate can grant the waiver. */ }
  const leads = agents.filter(agent => typeof agent.id === 'string' && typeof agent.name === 'string'
    && sessionPolicy(`bot-${agent.id}`).lead === true).map(agent => agent.name);
  const engine = chatId ? agents.find(agent => agent.id === bareChatId(chatId).slice(4))?.engine : undefined;
  const review = engine ? (engine.startsWith('claude') ? 'codex-fix' : 'opus-fix') : undefined;
  const file = [join(homedir(), '.claude', 'skills', 'fast-task', 'SKILL.md'), join(homedir(), '.claude-tardis', 'skills', 'fast-task', 'SKILL.md')]
    .find(path => { try { return statSync(path).isFile(); } catch { return false; } });
  return sharedRule('task-control', {
    fastTaskSkill: file ?? 'the fast-task SKILL.md (report it missing if unavailable)',
    leads: leads.length ? leads.join(', ') : 'none configured',
    fastTaskReview: review ? `A fast task alone ends at plain /${review} instead (your engine is ${engine}; the Claude Code host does not make a non-Claude model Claude).` : 'A fast task alone ends at plain /codex-fix for a Claude model and /opus-fix for every other model instead.',
  }, { teamTools });
}

/** Native skill overrides retain every callable skill while keeping only the
 * role's descriptions in the fixed prompt. No account/profile files change. */
export function nativeClaudeSettings(chatId: string): Record<string, unknown> {
  if (!isAgentThread(chatId)) return { autoCompactEnabled: true };
  const policy = sessionPolicy(chatId);
  const descriptions = new Set(sessionSkills(chatId));
  const skillOverrides: Record<string, string> = {};
  const excludes = [...new Set([...(policy.excludeInstructions ?? []), ...(policy.houseRules ? [resolve(policy.houseRules.replace(/^~\//, `${homedir()}/`))] : [])])];
  for (const root of [join(homedir(), '.claude', 'skills'), join(homedir(), '.claude-tardis', 'skills')]) {
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory() || entry.isSymbolicLink()) skillOverrides[entry.name] = descriptions.has(entry.name) ? 'on' : 'name-only';
      }
    } catch { /* an installation may not have this profile */ }
  }
  return {
    autoCompactEnabled: true,
    skillOverrides,
    autoMemoryEnabled: policy.memoryIndex === true,
    ...(excludes.length ? { claudeMdExcludes: excludes } : {}),
  };
}
