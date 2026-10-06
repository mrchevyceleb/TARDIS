import { useSyncExternalStore } from 'react';

// OpenRouter model catalog, fetched from /api/openrouter/models (the server's
// read of OpenRouter's public list, tool-capable models only). Same store as
// fireworksModels.ts: a hand fallback list until the catalog lands, an
// in-place swap so every importer sees the update, and a stored pick survives
// until the catalog can judge it. Each model carries its own effort tiers,
// taken from the catalog's published reasoning efforts (see the server's
// openrouter-models.ts).

export type OpenRouterModelSpec = {
  /** OpenRouter model id, also the brain model the server spawns with. */
  id: string;
  label: string;
  efforts: string[];
  contextWindow: number;
  imageInput?: boolean;
};

export const DEFAULT_OPENROUTER_MODEL = 'anthropic/claude-sonnet-5.5';
export const DEFAULT_OPENROUTER_EFFORT = 'high';
const ALL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const LHX = ['low', 'high', 'max'];

const OPENROUTER_MODEL_ID = /^~?[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._:-]{0,127}$/;

// Fallback only: the server's catalog answer replaces it (live catalog 2026-10-06).
const FALLBACK_OPENROUTER_MODELS: OpenRouterModelSpec[] = [
  { id: 'anthropic/claude-fable-5.1', label: 'Anthropic: Claude Fable 5.1', efforts: ALL_EFFORTS, contextWindow: 1_000_000, imageInput: true },
  { id: 'anthropic/claude-opus-5.5', label: 'Anthropic: Claude Opus 5.5', efforts: ALL_EFFORTS, contextWindow: 1_000_000, imageInput: true },
  { id: 'anthropic/claude-sonnet-5.5', label: 'Anthropic: Claude Sonnet 5.5', efforts: ALL_EFFORTS, contextWindow: 1_000_000, imageInput: true },
  { id: 'deepseek/deepseek-v4.1-flash', label: 'DeepSeek: DeepSeek V4.1 Flash', efforts: LHX, contextWindow: 1_048_576, imageInput: true },
  { id: 'google/gemini-3.8-flash', label: 'Google: Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'], contextWindow: 1_048_576, imageInput: true },
  { id: 'minimax/minimax-m3', label: 'MiniMax: MiniMax M3', efforts: ['low', 'medium', 'high', 'max'], contextWindow: 1_048_576, imageInput: true },
  { id: 'moonshotai/kimi-k3', label: 'MoonshotAI: Kimi K3', efforts: LHX, contextWindow: 1_048_576, imageInput: true },
  { id: 'openai/gpt-5.6-sol', label: 'OpenAI: GPT-5.6 Sol', efforts: ALL_EFFORTS, contextWindow: 1_050_000, imageInput: true },
  { id: 'openai/gpt-5.6-terra', label: 'OpenAI: GPT-5.6 Terra', efforts: ALL_EFFORTS, contextWindow: 1_050_000, imageInput: true },
  { id: 'qwen/qwen3.8-max-prime', label: 'Qwen: Qwen3.8 Max Prime', efforts: ['low', 'medium', 'high', 'xhigh'], contextWindow: 1_000_000, imageInput: true },
  { id: 'x-ai/grok-4.7', label: 'xAI: Grok 4.7', efforts: ['low', 'medium', 'high', 'xhigh'], contextWindow: 500_000, imageInput: true },
  { id: 'z-ai/glm-5.3', label: 'Z.ai: GLM 5.3', efforts: LHX, contextWindow: 1_048_576 },
  { id: 'z-ai/glm-5.3-flash', label: 'Z.ai: GLM 5.3 Flash', efforts: LHX, contextWindow: 1_048_576, imageInput: true },
];

/** The live list. Identity never changes; the catalog is swapped in place. */
export const OPENROUTER_MODELS: OpenRouterModelSpec[] = [...FALLBACK_OPENROUTER_MODELS];

let catalogLoaded = false;
let storeVersion = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useOpenRouterModels(): OpenRouterModelSpec[] {
  useSyncExternalStore(subscribe, () => storeVersion);
  return OPENROUTER_MODELS;
}

export function useOpenRouterCatalogVersion(): number {
  return useSyncExternalStore(subscribe, () => storeVersion);
}

export function isOpenRouterCatalogLoaded(): boolean {
  return catalogLoaded;
}

function cleanSpec(raw: unknown): OpenRouterModelSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== 'string' || !OPENROUTER_MODEL_ID.test(m.id) || typeof m.label !== 'string') return null;
  const efforts = Array.isArray(m.efforts) ? m.efforts.filter((e): e is string => typeof e === 'string' && ALL_EFFORTS.includes(e)) : [];
  if (!efforts.length) return null;
  return {
    id: m.id,
    label: m.label.slice(0, 80),
    efforts,
    contextWindow: typeof m.contextWindow === 'number' && m.contextWindow > 0 ? m.contextWindow : 200_000,
    ...(m.imageInput === true ? { imageInput: true } : {}),
  };
}

export function applyOpenRouterCatalog(payload: unknown): void {
  const body = payload && typeof payload === 'object' ? payload as { models?: unknown; source?: unknown } : null;
  if (!body || !Array.isArray(body.models)) return;
  const next = body.models.map(cleanSpec).filter((spec): spec is OpenRouterModelSpec => spec !== null);
  if (!next.length) return;
  OPENROUTER_MODELS.splice(0, OPENROUTER_MODELS.length, ...next);
  catalogLoaded = body.source === 'catalog';
  storeVersion++;
  for (const listener of listeners) listener();
}

let quickRetries = 0;
async function fetchOpenRouterCatalog(): Promise<void> {
  try {
    const response = await fetch('/api/openrouter/models');
    if (response.ok) applyOpenRouterCatalog(await response.json());
  } catch {
    // Offline or an older server: the fallback list stays in force.
  }
  // Same cadence as Fireworks: quick polls, then every 30s while the server
  // keeps retrying its own boot fetch (15 minutes).
  if (!catalogLoaded && quickRetries++ < 44) setTimeout(() => void fetchOpenRouterCatalog(), quickRetries <= 12 ? 5_000 : 30_000);
}
if (typeof window !== 'undefined') {
  void fetchOpenRouterCatalog();
  setInterval(() => void fetchOpenRouterCatalog(), 30 * 60 * 1000);
}

export function openRouterModelSpec(model: string): OpenRouterModelSpec {
  return OPENROUTER_MODELS.find((entry) => entry.id === model)
    ?? OPENROUTER_MODELS.find((entry) => entry.id === DEFAULT_OPENROUTER_MODEL)
    ?? OPENROUTER_MODELS[0]!;
}

/** A well-formed unknown id is kept until the catalog can judge it. */
export function normalizeOpenRouterModel(model: string | null | undefined): string {
  if (model && OPENROUTER_MODELS.some((entry) => entry.id === model)) return model;
  if (model && !catalogLoaded && OPENROUTER_MODEL_ID.test(model)) return model;
  return OPENROUTER_MODELS.some((entry) => entry.id === DEFAULT_OPENROUTER_MODEL) ? DEFAULT_OPENROUTER_MODEL : OPENROUTER_MODELS[0]!.id;
}

export function openRouterEffortsForModel(model: string): string[] {
  return openRouterModelSpec(normalizeOpenRouterModel(model)).efforts;
}

export function contextWindowForOpenRouterModel(model: string | undefined): number {
  return openRouterModelSpec(normalizeOpenRouterModel(model)).contextWindow;
}

/** Same rule as the server: step down to the nearest tier the model has. */
export function normalizeOpenRouterEffort(model: string, effort: string | null | undefined): string {
  const spec = openRouterModelSpec(normalizeOpenRouterModel(model));
  if (spec.efforts.includes(effort as string)) return effort as string;
  const target = ALL_EFFORTS.indexOf(effort && ALL_EFFORTS.includes(effort) ? effort : DEFAULT_OPENROUTER_EFFORT);
  const below = spec.efforts.filter((tier) => ALL_EFFORTS.indexOf(tier) <= target);
  return below[below.length - 1] ?? spec.efforts[0] ?? DEFAULT_OPENROUTER_EFFORT;
}

export function readStoredOpenRouterModel(): string {
  if (typeof window === 'undefined') return DEFAULT_OPENROUTER_MODEL;
  const raw = localStorage.getItem('rivendell:openrouter-model');
  const model = normalizeOpenRouterModel(raw);
  if (raw !== model && catalogLoaded) {
    localStorage.setItem('rivendell:openrouter-model', model);
    localStorage.setItem('rivendell:openrouter-effort', normalizeOpenRouterEffort(model, localStorage.getItem('rivendell:openrouter-effort')));
  }
  return model;
}

export function readStoredOpenRouterEffort(model = readStoredOpenRouterModel()): string {
  if (typeof window === 'undefined') return DEFAULT_OPENROUTER_EFFORT;
  const raw = localStorage.getItem('rivendell:openrouter-effort');
  const effort = normalizeOpenRouterEffort(model, raw);
  if (raw !== effort && catalogLoaded) localStorage.setItem('rivendell:openrouter-effort', effort);
  return effort;
}
