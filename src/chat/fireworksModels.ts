import { useSyncExternalStore } from 'react';

// Fireworks serverless model catalog, fetched from /api/fireworks/models (the
// server's live control-plane read). Mirrors codexModels.ts: a hand-verified
// fallback list until the catalog lands, an in-place swap so every importer
// sees the update, and a stored pick survives until the catalog can judge it.
// Thinking tiers are per model: each model's published tiers (models.dev
// reasoning_options, 2026-10-06), since Fireworks accepts any tier without
// saying which are real. Three models are thinking-only (they reject
// thinking:{type:'disabled'} with a 400) and are flagged so the UI can say so.

export type FireworksModelSpec = {
  /** Full Fireworks id — also the brain model the server spawns with. */
  id: string;
  label: string;
  efforts: string[];
  contextWindow: number;
  imageInput?: boolean;
  /** The endpoint rejects disabling thinking for this model. */
  thinkingOnly?: boolean;
};

export const DEFAULT_FIREWORKS_MODEL = 'accounts/fireworks/models/glm-5p3';
export const DEFAULT_FIREWORKS_EFFORT = 'high';
export const FIREWORKS_EFFORTS = ['low', 'medium', 'high'];
const LMHX = ['low', 'medium', 'high', 'max'];
const LHX = ['low', 'high', 'max'];
const LMH = ['low', 'medium', 'high'];
// On/off thinking toggle only: the tier is ignored, so offer one.
const TOGGLE = ['high'];

const FIREWORKS_MODEL_ID = /^accounts\/fireworks\/(models|routers)\/[a-z0-9][a-z0-9._-]{0,96}$/;
// glm-5p2 is still in the control-plane catalog but the inference endpoint
// 404s it (verified 2026-10-06), so a stored pin migrates to GLM 5.3.
const FIREWORKS_MODEL_ALIASES: Record<string, string> = {
  'accounts/fireworks/models/glm-5p2': DEFAULT_FIREWORKS_MODEL,
};

// Fallback only: the server's catalog answer replaces it. Verified against the
// live endpoint 2026-10-06 (context windows from the control plane).
const FALLBACK_FIREWORKS_MODELS: FireworksModelSpec[] = [
  { id: 'accounts/fireworks/models/deepseek-v4p1-flash', label: 'DeepSeek V4.1 Flash', efforts: LHX, contextWindow: 1_048_576, imageInput: true },
  { id: 'accounts/fireworks/models/ember-1', label: 'Ember 1', efforts: LMHX, contextWindow: 1_048_576, imageInput: true },
  { id: 'accounts/fireworks/models/glm-5p3', label: 'GLM 5.3', efforts: LHX, contextWindow: 1_048_576, thinkingOnly: true },
  { id: 'accounts/fireworks/models/glm-5p3-flash', label: 'GLM 5.3 Flash', efforts: LHX, contextWindow: 1_048_576, imageInput: true, thinkingOnly: true },
  { id: 'accounts/fireworks/models/gpt-oss-120b', label: 'GPT-OSS 120B', efforts: LMH, contextWindow: 131_072, thinkingOnly: true },
  { id: 'accounts/fireworks/models/inkling', label: 'Inkling', efforts: TOGGLE, contextWindow: 1_048_576, imageInput: true },
  { id: 'accounts/fireworks/models/kimi-k3', label: 'Kimi K3', efforts: LMHX, contextWindow: 1_048_576, imageInput: true },
  { id: 'accounts/fireworks/models/minimax-m3', label: 'MiniMax M3', efforts: LMH, contextWindow: 512_000 },
  { id: 'accounts/fireworks/models/nemotron-3-ultra-nvfp4', label: 'Nemotron 3 Ultra', efforts: TOGGLE, contextWindow: 262_144 },
  { id: 'accounts/fireworks/models/nemotron-lightning-3p5-30b-a3b', label: 'Nemotron Lightning 3.5', efforts: TOGGLE, contextWindow: 262_144 },
  { id: 'accounts/fireworks/models/qwen3p8-2p4t-a95b', label: 'Qwen 3.8 2.4T', efforts: ['low', 'medium', 'xhigh'], contextWindow: 262_144 },
  { id: 'accounts/fireworks/models/qwen3p8-max', label: 'Qwen 3.8 Max', efforts: TOGGLE, contextWindow: 262_144, imageInput: true },
  // Fireworks "fast" routers (the server always appends these; see fireworks-models.ts).
  { id: 'accounts/fireworks/routers/kimi-k3-fast', label: 'Kimi K3 Fast', efforts: LMHX, contextWindow: 1_048_576, imageInput: true },
  { id: 'accounts/fireworks/routers/glm-5p3-fast', label: 'GLM 5.3 Fast', efforts: LHX, contextWindow: 1_048_576, thinkingOnly: true },
];

/** The live list. Identity never changes; the catalog is swapped in place. */
export const FIREWORKS_MODELS: FireworksModelSpec[] = [...FALLBACK_FIREWORKS_MODELS];

let catalogLoaded = false;
let storeVersion = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Subscribe a component to catalog updates; returns the live list. */
export function useFireworksModels(): FireworksModelSpec[] {
  useSyncExternalStore(subscribe, () => storeVersion);
  return FIREWORKS_MODELS;
}

/** Catalog change counter, for effects that reconcile a stored pick when the
 *  live catalog lands (mirrors useCodexCatalogVersion). */
export function useFireworksCatalogVersion(): number {
  return useSyncExternalStore(subscribe, () => storeVersion);
}

export function isFireworksCatalogLoaded(): boolean {
  return catalogLoaded;
}

function cleanSpec(raw: unknown): FireworksModelSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== 'string' || !FIREWORKS_MODEL_ID.test(m.id) || typeof m.label !== 'string') return null;
  const efforts = Array.isArray(m.efforts) ? m.efforts.filter((e): e is string => typeof e === 'string' && /^[a-z]{2,12}$/.test(e)) : [];
  if (!efforts.length) return null;
  const contextWindow = typeof m.contextWindow === 'number' && m.contextWindow > 0 ? m.contextWindow : 200_000;
  return {
    id: m.id,
    label: m.label.slice(0, 60),
    efforts,
    contextWindow,
    ...(m.imageInput === true ? { imageInput: true } : {}),
    ...(m.thinkingOnly === true ? { thinkingOnly: true } : {}),
  };
}

/** Swap in what the server read from the Fireworks control plane. */
export function applyFireworksCatalog(payload: unknown): void {
  const body = payload && typeof payload === 'object' ? payload as { models?: unknown; source?: unknown } : null;
  if (!body || !Array.isArray(body.models)) return;
  const next = body.models.map(cleanSpec).filter((spec): spec is FireworksModelSpec => spec !== null);
  if (!next.length) return;
  FIREWORKS_MODELS.splice(0, FIREWORKS_MODELS.length, ...next);
  catalogLoaded = body.source === 'catalog';
  storeVersion++;
  for (const listener of listeners) listener();
}

let quickRetries = 0;
async function fetchFireworksCatalog(): Promise<void> {
  try {
    const response = await fetch('/api/fireworks/models');
    if (response.ok) applyFireworksCatalog(await response.json());
  } catch {
    // Offline or an older server: the fallback list stays in force.
  }
  if (!catalogLoaded && quickRetries++ < 12) setTimeout(() => void fetchFireworksCatalog(), 5_000);
}
if (typeof window !== 'undefined') {
  void fetchFireworksCatalog();
  setInterval(() => void fetchFireworksCatalog(), 30 * 60 * 1000);
}

export function fireworksModelSpec(model: string): FireworksModelSpec {
  return FIREWORKS_MODELS.find((entry) => entry.id === model)
    ?? FIREWORKS_MODELS.find((entry) => entry.id === DEFAULT_FIREWORKS_MODEL)
    ?? FIREWORKS_MODELS[0]!;
}

/** A well-formed unknown id is kept until the catalog can judge it, so a model
 *  picked right after Fireworks adds it survives a reload. */
export function normalizeFireworksModel(model: string | null | undefined): string {
  const aliased = model ? FIREWORKS_MODEL_ALIASES[model] ?? model : '';
  if (aliased && FIREWORKS_MODELS.some((entry) => entry.id === aliased)) return aliased;
  if (aliased && !catalogLoaded && FIREWORKS_MODEL_ID.test(aliased)) return aliased;
  return FIREWORKS_MODELS.some((entry) => entry.id === DEFAULT_FIREWORKS_MODEL) ? DEFAULT_FIREWORKS_MODEL : FIREWORKS_MODELS[0]!.id;
}

export function fireworksEffortsForModel(model: string): string[] {
  return fireworksModelSpec(normalizeFireworksModel(model)).efforts;
}

export function contextWindowForFireworksModel(model: string | undefined): number {
  return fireworksModelSpec(normalizeFireworksModel(model)).contextWindow;
}

export function normalizeFireworksEffort(model: string, effort: string | null | undefined): string {
  const spec = fireworksModelSpec(normalizeFireworksModel(model));
  if (spec.efforts.includes(effort as string)) return effort as string;
  // Same rule as the server: the lane default when the model has it, else its top tier.
  return spec.efforts.includes(DEFAULT_FIREWORKS_EFFORT) ? DEFAULT_FIREWORKS_EFFORT : spec.efforts[spec.efforts.length - 1] ?? DEFAULT_FIREWORKS_EFFORT;
}

export function readStoredFireworksModel(): string {
  if (typeof window === 'undefined') return DEFAULT_FIREWORKS_MODEL;
  const raw = localStorage.getItem('rivendell:fireworks-model');
  const model = normalizeFireworksModel(raw);
  if (raw !== model && catalogLoaded) {
    localStorage.setItem('rivendell:fireworks-model', model);
    localStorage.setItem('rivendell:fireworks-effort', normalizeFireworksEffort(model, localStorage.getItem('rivendell:fireworks-effort')));
  }
  return model;
}

export function readStoredFireworksEffort(model = readStoredFireworksModel()): string {
  if (typeof window === 'undefined') return DEFAULT_FIREWORKS_EFFORT;
  const raw = localStorage.getItem('rivendell:fireworks-effort');
  const effort = normalizeFireworksEffort(model, raw);
  if (raw !== effort && catalogLoaded) localStorage.setItem('rivendell:fireworks-effort', effort);
  return effort;
}
