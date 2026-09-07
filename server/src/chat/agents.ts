// User-defined agents — the team an operator curates. One agent = one persistent
// forever-thread + a scope document, running on any engine lane.
//
// Records live in ~/.rivendell/personas/agents.json; scopes in <id>.md
// beside them (same hot-reload mtime cache as always). Seeded with exactly
// ONE agent (Chief of Staff) on first boot — everything else is created by
// the user through the UI.

import { readFileSync, writeFileSync, mkdirSync, statSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SESSIONS_FILE, STATE_DIR } from './config.ts';
import { deleteRoutinesForAgent } from './routines.ts';
import { deleteMessagePinsForAgent } from '../lib/messagePinStore.ts';

const AGENTS_DIR = join(STATE_DIR, 'personas');
const AGENTS_FILE = join(AGENTS_DIR, 'agents.json');
const AVATARS_DIR = join(AGENTS_DIR, 'avatars');

const AVATAR_EXTS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export type Agent = {
  /** slug id — also the scope filename (<id>.md). */
  id: string;
  name: string;
  role: string;
  /** Server-authoritative brain used by every device, voice call, routine, and
   * teammate handoff. */
  engine: string;
  model?: string;
  effort?: string;
  brainRevision?: number;
  brainUpdatedAt?: number;
  /** home thread chatId (bot-<id>). */
  home: string;
  createdAt: number;
  /** Avatar version stamp (epoch ms) — also the cache-buster in avatar URLs. */
  avatar?: number;
  /** Historical lane stamp retained for migration/diagnostics only. Routing
   * always derives from the canonical engine/model/effort brain above. */
  cli?: string;
  /** Manual sidebar position (drag-and-drop). Order is FIXED unless the user
   *  moves a row — never activity-sorted. */
  order?: number;
  /** xAI realtime voice id for calls ('ara', 'rex', …). */
  voice?: string;
  /** Pinned to the top bubble strip (user choice, not activity). */
  pinned?: boolean;
  /** Hide unread badges — for companions that work with the crew, not the user. */
  muted?: boolean;
};

export type AgentBrain = { engine: string; model?: string; effort?: string; revision: number; updatedAt?: number };

const VALID_ENGINES = new Set([
  'claude', 'codex', 'banana', 'banana-local', 'banana-fireworks', 'zai', 'xai',
]);

export function cliForAgentEngine(engine: string): string {
  if (engine.startsWith('claude')) return 'claude';
  if (engine.startsWith('banana')) return engine;
  if (engine.startsWith('codex')) return 'codex';
  if (engine === 'zai') return 'zai';
  if (engine === 'xai') return 'xai';
  return 'xai';
}

export function defaultAgentBrain(engine: string): Omit<AgentBrain, 'revision' | 'updatedAt'> {
  switch (cliForAgentEngine(engine)) {
    case 'claude': return { engine: 'claude', model: 'claude-opus-5', effort: 'xhigh' };
    case 'codex': return { engine: 'codex', model: 'gpt-5.6-sol', effort: 'low' };
    case 'banana': return { engine: 'banana', model: 'openrouter/anthropic/claude-sonnet-5', effort: 'medium' };
    case 'banana-fireworks': return { engine: 'banana-fireworks', model: 'fireworks/accounts/fireworks/models/glm-5p2', effort: 'medium' };
    case 'banana-local': return { engine: 'banana-local', effort: 'medium' };
    case 'zai': return { engine: 'zai', model: 'glm-5.3[1m]', effort: 'high' };
    case 'xai':
    default: return { engine: 'xai', model: 'grok-4.6', effort: 'max' };
  }
}

function cleanBrainValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.trim().slice(0, 180) || undefined;
}

const CLAUDE_BRAIN_MODELS = new Set(['claude-opus-5', 'claude-fable-5-1', 'claude-fable-5']);
const ZAI_BRAIN_MODELS = new Set(['glm-5.3[1m]', 'glm-5.3-flash[1m]', 'glm-5.2[1m]', 'glm-5.1']);
const CODEX_BRAIN_EFFORTS: Record<string, ReadonlySet<string>> = {
  'gpt-6-astra': new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
  'gpt-5.6-sol': new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
  'gpt-5.6-luna': new Set(['low', 'medium', 'high', 'xhigh', 'max']),
  'gpt-5.5': new Set(['low', 'medium', 'high', 'xhigh']),
  'gpt-5.3-codex': new Set(['low', 'medium', 'high', 'xhigh']),
  'gpt-5.3-codex-spark': new Set(['low', 'medium', 'high', 'xhigh']),
};
const CODEX_DEFAULT_EFFORT: Record<string, string> = {
  'gpt-6-astra': 'medium',
  'gpt-5.6-sol': 'low',
  'gpt-5.6-luna': 'medium',
  'gpt-5.5': 'medium',
  'gpt-5.3-codex': 'high',
  'gpt-5.3-codex-spark': 'high',
};
const STANDARD_BRAIN_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const BANANA_BRAIN_EFFORTS = new Set(['low', 'medium', 'high']);
const ZAI_MODEL_ALIASES: Record<string, string> = {
  'glm-5.3': 'glm-5.3[1m]',
  'glm-5.3-flash': 'glm-5.3-flash[1m]',
  'glm-5.2': 'glm-5.2[1m]',
};

function normalizeBrainModel(engine: string, value: unknown, fallback?: string): string | undefined {
  let model = cleanBrainValue(value);
  if (!model) return fallback;
  if (engine === 'zai') model = ZAI_MODEL_ALIASES[model] ?? model;
  const valid = engine === 'claude' ? CLAUDE_BRAIN_MODELS.has(model)
    : engine === 'codex' ? Object.prototype.hasOwnProperty.call(CODEX_BRAIN_EFFORTS, model)
    : engine === 'xai' ? model === 'grok-4.6' || model === 'grok-4.5'
    : engine === 'zai' ? ZAI_BRAIN_MODELS.has(model)
    : engine === 'banana' ? model.startsWith('openrouter/')
    : engine === 'banana-fireworks' ? model.startsWith('fireworks/')
    : engine === 'banana-local' ? model.startsWith('local/')
    : false;
  return valid ? model : fallback;
}

function normalizeBrainEffort(engine: string, model: string | undefined, value: unknown, fallback?: string): string | undefined {
  const effort = cleanBrainValue(value);
  const allowed = engine === 'codex' && model ? CODEX_BRAIN_EFFORTS[model]
    : engine === 'zai' ? new Set(['high', 'max'])
    : engine.startsWith('banana') ? BANANA_BRAIN_EFFORTS
    : STANDARD_BRAIN_EFFORTS;
  const canonicalFallback = engine === 'codex' && model
    ? CODEX_DEFAULT_EFFORT[model] ?? fallback
    : fallback;
  return effort && allowed?.has(effort) ? effort : canonicalFallback;
}

function lastPersistedSelection(agent: Agent, engine: string): { model?: string; effort?: string } {
  try {
    const records = JSON.parse(readFileSync(SESSIONS_FILE, 'utf8')) as Record<
      string,
      { model?: unknown; effort?: unknown; updatedAt?: unknown }
    >;
    const cli = cliForAgentEngine(engine);
    const suffix = `|${agent.home}`;
    const candidates = Object.entries(records)
      .filter(([key]) => (
        key.startsWith(`${cli}|`)
        && (key.endsWith(suffix) || key.includes(`${suffix}__acct__`))
      ))
      .sort(([, a], [, b]) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0));
    const latest = candidates[0]?.[1];
    return {
      model: cleanBrainValue(latest?.model),
      effort: cleanBrainValue(latest?.effort),
    };
  } catch {
    return {};
  }
}

function normalizeAgentBrain(agent: Agent): Agent {
  const engine = VALID_ENGINES.has(agent.engine) ? agent.engine : 'xai';
  const defaults = defaultAgentBrain(engine);
  const persisted = !agent.model || !agent.effort ? lastPersistedSelection(agent, engine) : {};
  const model = normalizeBrainModel(engine, agent.model ?? persisted.model, defaults.model);
  const effort = normalizeBrainEffort(engine, model, agent.effort ?? persisted.effort, defaults.effort);
  return {
    ...agent,
    engine,
    model,
    effort,
    brainRevision: Number.isSafeInteger(agent.brainRevision) && (agent.brainRevision ?? 0) > 0
      ? agent.brainRevision
      : 1,
  };
}

export function brainForAgent(agent: Agent): AgentBrain {
  const normalized = normalizeAgentBrain(agent);
  return {
    engine: normalized.engine,
    model: normalized.model,
    effort: normalized.effort,
    revision: normalized.brainRevision ?? 1,
    updatedAt: normalized.brainUpdatedAt,
  };
}

const DEFAULT_SCOPE = `# Chief of Staff

You are the Chief of Staff aboard the TARDIS — the user's always-on AI companion.

## Who you are
- The coordinator. You think in plans, owners, and next actions. You keep the whole ship's work coherent.
- Calm, thorough, honest about risks. You flag what's blocked before it's late.

## What you do
- Break work into owned steps and route them to the right companion as the crew grows.
- Track open threads; when asked "where are we?", answer per workstream with state + owner + next action.
- Write things worth keeping: briefs, decisions, replies to people outside the ship.

## Style
- Structured markdown, short sections, explicit owners and dates. End with the single next action.
- Ship rules: never invent data; say what's missing instead.
`;

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agent';
}

export function listAgents(): Agent[] {
  try {
    const data = JSON.parse(readFileSync(AGENTS_FILE, 'utf8')) as { agents?: Agent[] };
    const rawAgents = Array.isArray(data.agents) ? data.agents : [];
    const agents = rawAgents.map(normalizeAgentBrain);
    // One-time in-place migration makes the central brain explicit instead of
    // recomputing hidden defaults independently on every device and worker.
    if (JSON.stringify(agents) !== JSON.stringify(rawAgents)) saveAgents(agents);
    // Fixed manual order first; unordered legacy/new agents append by age.
    return agents.sort((a, b) =>
      (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER)
      || a.createdAt - b.createdAt);
  } catch {
    return [];
  }
}

function saveAgents(agents: Agent[]): void {
  mkdirSync(AGENTS_DIR, { recursive: true });
  writeFileSync(AGENTS_FILE, JSON.stringify({ agents }, null, 2));
}

/** Seed exactly one agent (Chief of Staff) when the store is empty. */
export function ensureAgents(): void {
  try {
    mkdirSync(AGENTS_DIR, { recursive: true });
    let agents = listAgents();
    if (agents.length === 0) {
      const id = 'chief-of-staff';
      const scopePath = join(AGENTS_DIR, `${id}.md`);
      try { statSync(scopePath); } catch { writeFileSync(scopePath, DEFAULT_SCOPE); }
      agents = [{
        id,
        name: 'Chief of Staff',
        role: 'Coordination, plans, delegation',
        engine: 'claude',
        home: `bot-${id}`,
        createdAt: Date.now(),
      }];
      saveAgents(agents);
      console.log('[agents] seeded Chief of Staff');
    }
  } catch (err) {
    console.warn('[agents] seed failed:', (err as Error).message);
  }
}

export type AgentInput = { name: string; role?: string; engine?: string; model?: string; effort?: string; voice?: string; pinned?: boolean; muted?: boolean; scope?: string };

export function createAgent(input: AgentInput): Agent {
  const agents = listAgents();
  const base = slugify(input.name);
  let id = base;
  let n = 2;
  while (agents.some((a) => a.id === id) || id === 'chief-of-staff' && false) id = `${base}-${n++}`;
  const engine = input.engine && VALID_ENGINES.has(input.engine) ? input.engine : 'xai';
  const defaults = defaultAgentBrain(engine);
  const now = Date.now();
  const agent: Agent = {
    id,
    name: input.name.trim().slice(0, 60),
    role: (input.role ?? '').trim().slice(0, 120) || 'Companion',
    engine,
    model: normalizeBrainModel(engine, input.model, defaults.model),
    effort: normalizeBrainEffort(
      engine,
      normalizeBrainModel(engine, input.model, defaults.model),
      input.effort,
      defaults.effort,
    ),
    brainRevision: 1,
    brainUpdatedAt: now,
    voice: input.voice ?? 'ara',
    home: `bot-${id}`,
    createdAt: now,
    order: Math.max(0, ...agents.map((a) => a.order ?? 0)) + 1,
  };
  if (input.muted) agent.muted = true;
  if (input.scope && input.scope.trim()) {
    writeFileSync(join(AGENTS_DIR, `${id}.md`), input.scope);
  }
  agents.push(agent);
  saveAgents(agents);
  return agent;
}

export class AgentBrainConflictError extends Error {
  constructor(readonly current: Agent) {
    super('agent brain changed on another device');
    this.name = 'AgentBrainConflictError';
  }
}

export class AgentBrainRevisionRequiredError extends Error {
  constructor(readonly current: Agent) {
    super('agent brain updates require the current brain revision');
    this.name = 'AgentBrainRevisionRequiredError';
  }
}

export function updateAgent(
  id: string,
  patch: Partial<AgentInput>,
  expectedBrainRevision?: number,
): Agent | null {
  const agents = listAgents();
  const idx = agents.findIndex((a) => a.id === id);
  if (idx < 0) return null;
  const cur = normalizeAgentBrain(agents[idx]);
  const changesBrain = patch.engine !== undefined || patch.model !== undefined || patch.effort !== undefined;
  if (changesBrain && expectedBrainRevision === undefined) {
    throw new AgentBrainRevisionRequiredError(cur);
  }
  if (changesBrain && expectedBrainRevision !== (cur.brainRevision ?? 1)) {
    throw new AgentBrainConflictError(cur);
  }
  const engine = patch.engine && VALID_ENGINES.has(patch.engine) ? patch.engine : cur.engine;
  const engineChanged = engine !== cur.engine;
  const defaults = defaultAgentBrain(engine);
  const model = patch.model !== undefined
    ? normalizeBrainModel(engine, patch.model, defaults.model)
    : engineChanged ? defaults.model : cur.model;
  const effortInput = patch.effort !== undefined
    ? patch.effort
    : engineChanged ? defaults.effort : cur.effort;
  const effort = normalizeBrainEffort(engine, model, effortInput, defaults.effort);
  const brainChanged = engineChanged || model !== cur.model || effort !== cur.effort;
  const next: Agent = {
    ...cur,
    name: patch.name !== undefined ? (patch.name.trim().slice(0, 60) || cur.name) : cur.name,
    role: patch.role !== undefined ? (patch.role.trim().slice(0, 120) || cur.role) : cur.role,
    engine,
    model,
    effort,
    brainRevision: brainChanged ? (cur.brainRevision ?? 1) + 1 : cur.brainRevision,
    brainUpdatedAt: brainChanged ? Date.now() : cur.brainUpdatedAt,
    voice: patch.voice !== undefined ? (patch.voice || cur.voice) : cur.voice,
    pinned: patch.pinned !== undefined ? patch.pinned : cur.pinned,
  };
  if (patch.muted !== undefined) {
    if (patch.muted) next.muted = true;
    else delete next.muted;
  }
  // Any deliberate brain change makes the prior live-lane stamp historical.
  if (brainChanged) delete next.cli;
  agents[idx] = next;
  saveAgents(agents);
  if (patch.scope !== undefined && patch.scope.trim()) {
    writeFileSync(join(AGENTS_DIR, `${id}.md`), patch.scope);
  }
  return next;
}

export function deleteAgent(id: string): boolean {
  const agents = listAgents();
  const next = agents.filter((a) => a.id !== id);
  if (next.length === agents.length) return false;
  saveAgents(next);
  deleteRoutinesForAgent(id);
  try { deleteMessagePinsForAgent(id); } catch { /* pin pocket is ancillary to the agent record */ }
  clearAvatarFiles(id);
  try { unlinkSync(join(AGENTS_DIR, `${id}.md`)); } catch { /* scope file optional */ }
  return true;
}

function clearAvatarFiles(id: string): void {
  try {
    for (const f of readdirSync(AVATARS_DIR)) {
      if (f.startsWith(`${id}.`)) unlinkSync(join(AVATARS_DIR, f));
    }
  } catch { /* no avatars dir yet */ }
}

/** Persist an uploaded avatar for an agent; bumps the version stamp. */
export function setAgentAvatar(id: string, mime: string, bytes: Buffer): Agent | null {
  const ext = AVATAR_EXTS[mime];
  if (!ext) throw new Error(`unsupported avatar type: ${mime}`);
  if (!bytes?.length) throw new Error('empty avatar payload');
  const agents = listAgents();
  const idx = agents.findIndex((a) => a.id === id);
  if (idx < 0) return null;
  mkdirSync(AVATARS_DIR, { recursive: true });
  clearAvatarFiles(id); // drop any stale-format previous upload
  writeFileSync(join(AVATARS_DIR, `${id}.${ext}`), bytes);
  const next: Agent = { ...agents[idx], avatar: Date.now() };
  agents[idx] = next;
  saveAgents(agents);
  return next;
}

/** Remove an agent's avatar (back to the initial disc). */
export function clearAgentAvatar(id: string): Agent | null {
  const agents = listAgents();
  const idx = agents.findIndex((a) => a.id === id);
  if (idx < 0) return null;
  clearAvatarFiles(id);
  if (agents[idx].avatar === undefined) return agents[idx];
  const next: Agent = { ...agents[idx] };
  delete next.avatar;
  agents[idx] = next;
  saveAgents(agents);
  return next;
}

/** Absolute path of an agent's stored avatar file, if any. */
export function agentAvatarPath(id: string): string | null {
  try {
    for (const f of readdirSync(AVATARS_DIR)) {
      if (f === `${id}.png` || f === `${id}.jpg` || f === `${id}.webp` || f === `${id}.gif`) {
        return join(AVATARS_DIR, f);
      }
    }
  } catch { /* dir absent */ }
  return null;
}

/** Persist a manual sidebar order (ids in drop sequence). */
export function reorderAgents(ids: string[]): Agent[] {
  const agents = listAgents();
  const rank = new Map(ids.map((id, i) => [id, i]));
  const next = agents.map((a) => ({ ...a, order: rank.has(a.id) ? rank.get(a.id)! : (a.order ?? Number.MAX_SAFE_INTEGER) }));
  next.sort((a, b) =>
    (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER)
    || a.createdAt - b.createdAt);
  next.forEach((a, i) => { a.order = i; });
  saveAgents(next);
  return next;
}

export function agentForChatId(chatId: string): Agent | undefined {
  const bare = chatId.replace(/__acct__[a-z0-9-]+$/i, '');
  return listAgents().find((a) => a.home === bare);
}

const laneStamps = new Map<string, string>();

/** Record which session cli most recently accepted a USER turn. Canonical
 * routing ignores this stamp; it remains useful for legacy migration and
 * diagnostics. Throttled write: at most one save/min/agent. */
const laneLastWrite = new Map<string, number>();
export function noteAgentLane(chatId: string, cli: string): void {
  const bare = chatId.replace(/__acct__[a-z0-9-]+$/i, '');
  if (laneStamps.get(bare) === cli) return;
  const now = Date.now();
  // Do not stamp an unsaved change as complete. The old code updated
  // laneStamps before this throttle and then returned forever on later turns,
  // leaving agents.json permanently pointed at the previous brain.
  if (now - (laneLastWrite.get(bare) ?? 0) < 60_000) return;
  try {
    const agents = listAgents();
    const idx = agents.findIndex((a) => a.home === bare);
    if (idx < 0) return;
    if (agents[idx].cli !== cli) {
      agents[idx] = { ...agents[idx], cli };
      saveAgents(agents);
    }
    laneStamps.set(bare, cli);
    laneLastWrite.set(bare, now);
  } catch { /* best-effort stamp; leave unstamped so a later turn retries */ }
}
