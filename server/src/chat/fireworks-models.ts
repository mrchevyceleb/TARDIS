// Fireworks model catalog — the list behind the `fireworks` engine lane
// (runner.ts), the /api/fireworks/models picker payload, and agent-brain
// validation. Mirrors codex-models.ts: a hand-verified fallback list plus a
// live catalog (Fireworks' control-plane library, paged by banana-runner's
// fetchFireworksCatalog, which is the one source of truth for that API), with
// a sync capability lookup for spawn-time validation.
//
// Thinking settings were verified 2026-10-06 against the live
// Anthropic-compatible endpoint (https://api.fireworks.ai/inference/v1/messages):
// every serverless chat model accepts `thinking: {type:'enabled'}`; three
// (GLM 5.3, GLM 5.3 Flash, GPT-OSS 120B) REJECT `thinking: {type:'disabled'}`
// with a 400, so the lane always spawns with an effort and never disables
// thinking. `accounts/fireworks/models/glm-5p2` still appears in the
// control-plane catalog but 404s on the inference endpoint (verified twice),
// so it is excluded here and a stored brain pin migrates to GLM 5.3.
import { engineDefault } from '../lib/engineConfig.ts';
import { FIREWORKS_NON_CHAT_RE, fetchFireworksCatalog } from './banana-runner.ts';

export type FireworksModelInfo = {
  /** Full Fireworks id — also the `--model` value the claude binary sends. */
  id: string;
  label: string;
  /** Verified reasoning tiers. Every chat model accepts thinking; three cannot disable it. */
  efforts: string[];
  contextWindow: number;
  imageInput?: boolean;
  /** The endpoint rejects thinking:{type:'disabled'} for this model (400). */
  thinkingOnly?: true;
};

/** Verified against the live endpoint: low/medium/high budgets are accepted
 *  by every serverless chat model. Higher tiers (xhigh/max) are unverified, so
 *  they are not offered. */
export const FIREWORKS_EFFORTS = ['low', 'medium', 'high'] as const;

const HAND_MODELS: FireworksModelInfo[] = [
  { id: 'accounts/fireworks/models/deepseek-v4p1-flash', label: 'DeepSeek V4.1 Flash', efforts: [...FIREWORKS_EFFORTS], contextWindow: 1_048_576, imageInput: true },
  { id: 'accounts/fireworks/models/ember-1', label: 'Ember 1', efforts: [...FIREWORKS_EFFORTS], contextWindow: 1_048_576, imageInput: true },
  { id: 'accounts/fireworks/models/glm-5p3', label: 'GLM 5.3', efforts: [...FIREWORKS_EFFORTS], contextWindow: 1_048_576, thinkingOnly: true },
  { id: 'accounts/fireworks/models/glm-5p3-flash', label: 'GLM 5.3 Flash', efforts: [...FIREWORKS_EFFORTS], contextWindow: 1_048_576, imageInput: true, thinkingOnly: true },
  { id: 'accounts/fireworks/models/gpt-oss-120b', label: 'GPT-OSS 120B', efforts: [...FIREWORKS_EFFORTS], contextWindow: 131_072, thinkingOnly: true },
  { id: 'accounts/fireworks/models/inkling', label: 'Inkling', efforts: [...FIREWORKS_EFFORTS], contextWindow: 1_048_576, imageInput: true },
  { id: 'accounts/fireworks/models/kimi-k3', label: 'Kimi K3', efforts: [...FIREWORKS_EFFORTS], contextWindow: 1_048_576, imageInput: true },
  { id: 'accounts/fireworks/models/minimax-m3', label: 'MiniMax M3', efforts: [...FIREWORKS_EFFORTS], contextWindow: 512_000 },
  { id: 'accounts/fireworks/models/nemotron-3-ultra-nvfp4', label: 'Nemotron 3 Ultra', efforts: [...FIREWORKS_EFFORTS], contextWindow: 262_144 },
  { id: 'accounts/fireworks/models/nemotron-lightning-3p5-30b-a3b', label: 'Nemotron Lightning 3.5', efforts: [...FIREWORKS_EFFORTS], contextWindow: 262_144 },
  { id: 'accounts/fireworks/models/qwen3p8-2p4t-a95b', label: 'Qwen 3.8 2.4T', efforts: [...FIREWORKS_EFFORTS], contextWindow: 262_144 },
  // Control plane reports no context_length for this one; pinned to its sibling's.
  { id: 'accounts/fireworks/models/qwen3p8-max', label: 'Qwen 3.8 Max', efforts: [...FIREWORKS_EFFORTS], contextWindow: 262_144, imageInput: true },
];
const HAND_BY_ID = new Map(HAND_MODELS.map((model) => [model.id, model]));

/** Catalog rows the inference endpoint refuses today. Verified 2026-10-06:
 *  glm-5p2 404s ("Model not found, inaccessible, and/or not deployed") on the
 *  Anthropic-compatible endpoint while the control plane still lists it. */
const EXCLUDED_MODEL_IDS = new Set(['accounts/fireworks/models/glm-5p2']);
/** Stored brain pins for an excluded id migrate here (the zai alias pattern). */
const MODEL_ALIASES: Record<string, string> = {
  'accounts/fireworks/models/glm-5p2': 'accounts/fireworks/models/glm-5p3',
};

const DEFAULT_CONTEXT_WINDOW = 200_000;
const REFRESH_MS = 4 * 60 * 60 * 1000;
const FIREWORKS_MODEL_ID = /^accounts\/fireworks\/models\/[a-z0-9][a-z0-9._-]{0,96}$/;

/** Operator-configurable lane default (~/samwise/.accounts/engines.json). */
export const { model: FIREWORKS_LANE_MODEL, effort: FIREWORKS_LANE_EFFORT } = engineDefault(
  'fireworks',
  'accounts/fireworks/models/glm-5p3',
  'high',
);

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function contextFrom(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function rowToInfo(row: unknown): FireworksModelInfo | null {
  const rec = recordOf(row);
  const id = typeof rec.id === 'string' ? rec.id.trim() : '';
  if (!id || rec.supports_chat === false || FIREWORKS_NON_CHAT_RE.test(id)) return null;
  if (EXCLUDED_MODEL_IDS.has(id)) return null;
  const hand = HAND_BY_ID.get(id);
  const context = contextFrom(rec.context_length) ?? hand?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  return {
    id,
    label: hand?.label ?? (id.split('/').pop() || id),
    efforts: [...FIREWORKS_EFFORTS],
    contextWindow: context,
    ...(rec.supports_image_input === true || hand?.imageInput ? { imageInput: true } : {}),
    ...(hand?.thinkingOnly ? { thinkingOnly: true } : {}),
  };
}

let catalog: FireworksModelInfo[] | null = null;
let refreshTimer: NodeJS.Timeout | null = null;

async function refreshCatalog(): Promise<FireworksModelInfo[]> {
  try {
    const rows = await fetchFireworksCatalog();
    const next = rows.map(rowToInfo).filter((info): info is FireworksModelInfo => info !== null);
    // Keep the prior list on an empty/failed answer (fail-open, like codex).
    if (next.length > 0) catalog = next;
  } catch (error) {
    console.warn(`[fireworks] catalog refresh failed: ${(error as Error).message}`);
  }
  return catalog ?? HAND_MODELS;
}

/** Warm the catalog at boot and refresh it every few hours. Never throws. */
export async function startFireworksCatalog(): Promise<void> {
  await refreshCatalog();
  if (refreshTimer) return;
  refreshTimer = setInterval(() => { void refreshCatalog(); }, REFRESH_MS);
  refreshTimer.unref();
}

/** The live list for spawn-time validation. Falls back to the hand list until
 *  the first refresh lands. */
export function fireworksModelList(): FireworksModelInfo[] {
  return catalog ?? HAND_MODELS;
}

/** Sync capability lookup used by the runner, agent-brain normalization, and
 *  the recycle comparison (must resolve deterministically). */
export function fireworksCapability(model: string): FireworksModelInfo | undefined {
  return fireworksModelList().find((info) => info.id === model);
}

/** True context window for the spawn env (MAX_CONTEXT + AUTO_COMPACT). */
export function fireworksContextWindow(model: string): number {
  return fireworksCapability(model)?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
}

export function fireworksCatalogPayload(): { models: FireworksModelInfo[]; source: 'catalog' | 'hand' } {
  return { models: fireworksModelList(), source: catalog ? 'catalog' : 'hand' };
}

/** Normalize a model for the fireworks lane: a verified catalog id passes,
 *  a well-formed unknown id survives only while the hand list is all the
 *  server knows (before the first control-plane refresh, so a brand-new
 *  Fireworks model still spawns), anything else falls to the lane default.
 *  Once the live catalog is in force, an unknown id is a typo or a removed
 *  model and fails here at spawn instead of later at inference. Aliases
 *  migrate excluded pins. */
export function resolveFireworksModel(m: string | undefined, fallback = FIREWORKS_LANE_MODEL): string {
  const model = m?.trim();
  if (!model) return fallback;
  const aliased = MODEL_ALIASES[model] ?? model;
  if (fireworksCapability(aliased)) return aliased;
  if (catalog === null && FIREWORKS_MODEL_ID.test(aliased) && !EXCLUDED_MODEL_IDS.has(aliased)) return aliased;
  return fallback;
}

/** Effort tiers for the fireworks lane. Verified low/medium/high only. */
export function resolveFireworksEffort(e: string | undefined, fallback = FIREWORKS_LANE_EFFORT): string {
  const effort = e?.trim();
  return effort && (FIREWORKS_EFFORTS as readonly string[]).includes(effort) ? effort : fallback;
}
