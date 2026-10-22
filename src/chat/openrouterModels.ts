import { useSyncExternalStore } from 'react';

// OpenRouter model catalog, fetched from /api/openrouter/models (the server's
// read of OpenRouter's public list, tool-capable models only). Same store as
// fireworksModels.ts: a hand fallback list until the catalog lands, an
// in-place swap so every importer sees the update. Discovery never rewrites
// a stored choice. Each model carries its own effort tiers,
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
const OPENROUTER_MODEL_ID = /^~?[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._:-]{0,127}$/;
/** Limits are supplied only by the server's current live catalog. */
export const OPENROUTER_MODELS: OpenRouterModelSpec[] = [];

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
  if (!efforts.length || typeof m.contextWindow !== 'number' || m.contextWindow <= 0) return null;
  return {
    id: m.id,
    label: m.label.slice(0, 80),
    efforts,
    contextWindow: m.contextWindow,
    ...(m.imageInput === true ? { imageInput: true } : {}),
  };
}

export function applyOpenRouterCatalog(payload: unknown): void {
  const body = payload && typeof payload === 'object' ? payload as { models?: unknown; source?: unknown } : null;
  if (!body || !Array.isArray(body.models)) return;
  const next = body.models.map(cleanSpec).filter((spec): spec is OpenRouterModelSpec => spec !== null);
  if (!next.length && body.source !== 'unavailable') return;
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
    // Offline: retain the selected ID; no invented model limits.
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
  return OPENROUTER_MODELS.find(entry => entry.id === model)
    ?? { id: model, label: model, efforts: ALL_EFFORTS, contextWindow: 0 };
}

export function normalizeOpenRouterModel(model: string | null | undefined): string {
  // Keep Matt's selected ID even while its catalog entry is unavailable.
  return model && OPENROUTER_MODEL_ID.test(model) ? model : DEFAULT_OPENROUTER_MODEL;
}

export function openRouterEffortsForModel(model: string): string[] {
  return openRouterModelSpec(normalizeOpenRouterModel(model)).efforts;
}

export function contextWindowForOpenRouterModel(model: string | undefined): number {
  return openRouterModelSpec(normalizeOpenRouterModel(model)).contextWindow;
}

/** Preserve an explicit tier; availability changes must fail visibly at save or run. */
export function normalizeOpenRouterEffort(model: string, effort: string | null | undefined): string {
  if (effort && /^[a-z]{2,12}$/.test(effort)) return effort;
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

export function readStoredOpenRouter2Model(): string {
  if (typeof window === 'undefined') return DEFAULT_OPENROUTER_MODEL;
  const raw = localStorage.getItem('rivendell:openrouter2-model');
  const model = normalizeOpenRouterModel(raw);
  if (raw !== model) {
    localStorage.setItem('rivendell:openrouter2-model', model);
    localStorage.setItem('rivendell:openrouter2-effort', normalizeOpenRouterEffort(model, localStorage.getItem('rivendell:openrouter2-effort')));
  }
  return model;
}

export function readStoredOpenRouter2Effort(model = readStoredOpenRouter2Model()): string {
  if (typeof window === 'undefined') return DEFAULT_OPENROUTER_EFFORT;
  const raw = localStorage.getItem('rivendell:openrouter2-effort');
  const effort = normalizeOpenRouterEffort(model, raw);
  if (raw !== effort && catalogLoaded) localStorage.setItem('rivendell:openrouter2-effort', effort);
  return effort;
}
