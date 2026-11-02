import type { ChatBlock } from './data/types';
import { useSyncExternalStore } from 'react';

// Efforts come from the Codex CLI's own catalog, so a new level needs no code change.
export type CodexEffort = string;


export type CodexModelSpec = {
  id: string;
  label: string;
  defaultEffort: CodexEffort;
  efforts: CodexEffort[];
  contextWindow: number;
  serviceTiers?: { id: string; label: string; description: string }[];
  defaultServiceTier?: string;
};

const STANDARD_EFFORTS: CodexEffort[] = ['low', 'medium', 'high', 'xhigh'];
const MAX_EFFORTS: CodexEffort[] = [...STANDARD_EFFORTS, 'max'];
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const DEFAULT_CODEX_MODEL = 'gpt-5.6-sol';

// Only the fallback: the server reads the Codex CLI's own model catalog
// (/api/codex/models) and this list is replaced by it, so a new model needs no
// edit here. These are metadata defaults, not proof an account offers them.
const FALLBACK_CODEX_MODELS: CodexModelSpec[] = [
  {
    id: 'gpt-6.1-sol',
    label: 'GPT-6.1 Sol',
    defaultEffort: 'low',
    efforts: [...MAX_EFFORTS, 'ultra'],
    contextWindow: 272_000,
  },
  {
    id: 'gpt-6-astra',
    label: 'GPT-6-Astra',
    defaultEffort: 'medium',
    efforts: [...MAX_EFFORTS, 'ultra'],
    contextWindow: 272_000,
  },
  {
    id: 'gpt-6-sol',
    label: 'GPT-6 Sol',
    defaultEffort: 'medium',
    efforts: [...MAX_EFFORTS, 'ultra'],
    contextWindow: 272_000,
  },
  {
    id: 'gpt-6-luna',
    label: 'GPT-6 Luna',
    defaultEffort: 'medium',
    efforts: MAX_EFFORTS,
    contextWindow: 272_000,
  },
  {
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    defaultEffort: 'low',
    efforts: [...MAX_EFFORTS, 'ultra'],
    contextWindow: 372_000,
  },
  {
    id: 'gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    defaultEffort: 'medium',
    efforts: MAX_EFFORTS,
    contextWindow: 372_000,
  },
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    defaultEffort: 'medium',
    efforts: STANDARD_EFFORTS,
    contextWindow: 272_000,
  },
  {
    id: 'gpt-5.3-codex',
    label: 'Codex 5.3',
    defaultEffort: 'high',
    efforts: STANDARD_EFFORTS,
    contextWindow: 272_000,
  },
  {
    id: 'gpt-5.3-codex-spark',
    label: 'Spark 5.3',
    defaultEffort: 'high',
    efforts: STANDARD_EFFORTS,
    contextWindow: 128_000,
  },
];

/** The live list. Its identity never changes: the catalog is swapped in place
 *  so every importer sees it, and components that render it subscribe with
 *  useCodexModels() to repaint when it changes. */
export const CODEX_MODELS: CodexModelSpec[] = [...FALLBACK_CODEX_MODELS];

export type CodexCliStatus = { version: string | null; latest: string | null; outdated: boolean };

let catalogLoaded = false;
let cliStatus: CodexCliStatus = { version: null, latest: null, outdated: false };
let storeVersion = 0;
const listeners = new Set<() => void>();
const SAVED_MODELS_KEY = 'rivendell:codex-saved-models';
const savedModels = new Set<string>();
try {
  const stored: unknown = JSON.parse(localStorage.getItem(SAVED_MODELS_KEY) ?? '[]');
  if (Array.isArray(stored)) for (const id of stored.slice(-40)) {
    if (typeof id === 'string' && MODEL_ID.test(id)) savedModels.add(id);
  }
} catch { /* browser storage can be unavailable */ }

/** Keep actual saved choices reachable, separately from catalog availability. */
export function rememberCodexModel(model: string): void {
  if (!MODEL_ID.test(model) || savedModels.has(model)) return;
  savedModels.add(model);
  if (savedModels.size > 40) savedModels.delete(savedModels.values().next().value!);
  try { localStorage.setItem(SAVED_MODELS_KEY, JSON.stringify([...savedModels])); } catch { /* memory still works */ }
  storeVersion++;
  for (const listener of listeners) listener();
}

export function codexModelLabel(model: string): string {
  return CODEX_MODELS.find((entry) => entry.id === model)?.label
    ?? FALLBACK_CODEX_MODELS.find((entry) => entry.id === model)?.label ?? model;
}

export function isCodexModelUnlisted(model: string): boolean {
  return !CODEX_MODELS.some((entry) => entry.id === model);
}

export function codexPickerModels(): Array<{ id: string; label: string }> {
  const offered = catalogLoaded ? CODEX_MODELS : [];
  const offeredIds = new Set(offered.map((model) => model.id));
  return [...offered, ...[...savedModels].filter((id) => !offeredIds.has(id))
    .map((id) => ({ id, label: `${codexModelLabel(id)} · saved choice` }))];
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function isCodexCatalogLoaded(): boolean {
  return catalogLoaded;
}

/** Subscribe a component to catalog updates; returns the live list. */
export function useCodexModels(): Array<{ id: string; label: string }> {
  useSyncExternalStore(subscribe, () => storeVersion);
  return codexPickerModels();
}

/** Bumps whenever the live list changes, for effects that must re-normalize. */
export function useCodexCatalogVersion(): number {
  return useSyncExternalStore(subscribe, () => storeVersion);
}

export function useCodexCliStatus(): CodexCliStatus {
  useSyncExternalStore(subscribe, () => storeVersion);
  return cliStatus;
}

function cleanSpec(raw: unknown): CodexModelSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== 'string' || !MODEL_ID.test(m.id) || typeof m.label !== 'string') return null;
  const efforts = Array.isArray(m.efforts) ? m.efforts.filter((e): e is string => typeof e === 'string' && /^[a-z]{2,12}$/.test(e)) : [];
  if (!efforts.length) return null;
  const defaultEffort = typeof m.defaultEffort === 'string' && efforts.includes(m.defaultEffort) ? m.defaultEffort : efforts[0]!;
  const contextWindow = typeof m.contextWindow === 'number' && m.contextWindow > 0 ? m.contextWindow : 272_000;
  const serviceTiers: NonNullable<CodexModelSpec['serviceTiers']> = [];
  if (Array.isArray(m.serviceTiers)) for (const value of m.serviceTiers) {
    if (!value || typeof value !== 'object') continue;
    const tier = value as Record<string, unknown>;
    if (typeof tier.id !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(tier.id) || tier.id === 'default') continue;
    serviceTiers.push({ id: tier.id, label: typeof tier.label === 'string' ? tier.label.slice(0, 60) : tier.id,
      description: typeof tier.description === 'string' ? tier.description.slice(0, 240) : '' });
  }
  const defaultServiceTier = typeof m.defaultServiceTier === 'string' && serviceTiers.some(tier => tier.id === m.defaultServiceTier) ? m.defaultServiceTier : 'default';
  return { id: m.id, label: m.label.slice(0, 60), defaultEffort, efforts, contextWindow, serviceTiers, defaultServiceTier };
}

/** Swap in what the server read from the Codex CLI. */
export function applyCodexCatalog(payload: unknown): void {
  const body = payload && typeof payload === 'object' ? payload as { models?: unknown; source?: unknown; cli?: unknown } : null;
  if (!body || !Array.isArray(body.models)) return;
  const next = body.models.map(cleanSpec).filter((spec): spec is CodexModelSpec => spec !== null);
  if (!next.length) return;
  const cli = body.cli && typeof body.cli === 'object' ? body.cli as Record<string, unknown> : {};
  cliStatus = {
    version: typeof cli.version === 'string' ? cli.version : null,
    latest: typeof cli.latest === 'string' ? cli.latest : null,
    outdated: cli.outdated === true,
  };
  CODEX_MODELS.splice(0, CODEX_MODELS.length, ...next);
  // Only the CLI's own catalog is authoritative for what the login offers; the
  // server's fallback answer must not make us drop a stored choice.
  catalogLoaded = body.source === 'catalog';
  storeVersion++;
  for (const listener of listeners) listener();
}

let quickRetries = 0;
async function fetchCodexCatalog(): Promise<void> {
  try {
    const response = await fetch('/api/codex/models');
    if (response.ok) applyCodexCatalog(await response.json());
  } catch {
    // Offline or an older server: keep explicit saved choices available.
  }
  // The server reads the CLI's catalog in the background after it starts, so
  // an early answer can still be the fallback: ask again soon, a few times.
  if ((!catalogLoaded || cliStatus.latest === null || cliStatus.version === null) && quickRetries++ < 12) setTimeout(() => void fetchCodexCatalog(), 5_000);
}
if (typeof window !== 'undefined') {
  void fetchCodexCatalog();
  setInterval(() => void fetchCodexCatalog(), 30 * 60_000);
}

export function codexModelSpec(model: string): CodexModelSpec {
  return CODEX_MODELS.find((entry) => entry.id === model)
    ?? FALLBACK_CODEX_MODELS.find((entry) => entry.id === model)
    ?? CODEX_MODELS.find((entry) => entry.id === DEFAULT_CODEX_MODEL)
    ?? CODEX_MODELS[0]!;
}

/** A catalog is discovery, never permission to replace a saved selection. */
export function normalizeCodexModel(model: string | null | undefined): string {
  if (model && CODEX_MODELS.some((entry) => entry.id === model)) return model;
  if (model && MODEL_ID.test(model)) return model;
  return CODEX_MODELS.some((entry) => entry.id === DEFAULT_CODEX_MODEL) ? DEFAULT_CODEX_MODEL : CODEX_MODELS[0]!.id;
}

/** Unknown/saved models must never borrow another model's speed choices. */
export function codexServiceTiers(model: string): NonNullable<CodexModelSpec['serviceTiers']> {
  const spec = CODEX_MODELS.find(entry => entry.id === model);
  return spec?.serviceTiers?.length ? [{ id: 'default', label: 'Standard', description: 'Standard speed and usage' }, ...spec.serviceTiers] : [];
}

/** Reads preserve explicit saved intent, just like model and effort. */
export function savedCodexServiceTier(model: string, value?: string | null): string {
  const tier = value === 'fast' ? 'priority' : value;
  if (tier && /^[a-z][a-z0-9_-]{0,31}$/.test(tier)) return tier;
  return CODEX_MODELS.find(entry => entry.id === model)?.defaultServiceTier ?? 'default';
}

export function normalizeCodexServiceTier(model: string, value?: string | null): string {
  const tier = value === 'fast' ? 'priority' : value;
  const spec = CODEX_MODELS.find(entry => entry.id === model);
  return tier === 'default' || codexServiceTiers(model).some(entry => entry.id === tier)
    ? tier! : spec?.defaultServiceTier ?? 'default';
}

export function codexEffortsForModel(model: string): CodexEffort[] {
  return codexModelSpec(model).efforts;
}

/** An explicit model switch uses the nearest supported effort, with a notice. */
export function codexModelChange(model: string, current: string, currentSpeed?: string): { effort: string; serviceTier: string; notice: string | null } {
  const spec = codexModelSpec(model);
  const order = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  const index = order.indexOf(current);
  const lower = order.slice(0, index).reverse().find((tier) => spec.efforts.includes(tier));
  const effort = spec.efforts.includes(current) ? current : index < 0 ? spec.defaultEffort : lower ?? spec.efforts[0]!;
  const serviceTier = normalizeCodexServiceTier(model, currentSpeed);
  const notices: string[] = [];
  if (effort !== current) notices.push(`${codexModelLabel(model)} doesn’t offer ${current}. Effort changed to ${effort}, the closest supported level.`);
  const savedSpeed = savedCodexServiceTier(model, currentSpeed);
  if (currentSpeed && serviceTier !== savedSpeed) {
    const label = (tier: string) => codexServiceTiers(model).find(entry => entry.id === tier)?.label ?? (tier === 'default' ? 'Standard' : tier === 'priority' ? 'Fast' : tier === 'ultrafast' ? 'Ultrafast' : tier);
    notices.push(`${codexModelLabel(model)} doesn’t offer ${label(savedSpeed)}. Speed changed to ${label(serviceTier)}.`);
  }
  return { effort, serviceTier, notice: notices.join(' ') || null };
}

export function contextWindowForCodexModel(model: string | undefined): number {
  return codexModelSpec(normalizeCodexModel(model)).contextWindow;
}

export function normalizeCodexEffort(model: string, effort: string | null | undefined): CodexEffort {
  // Saved effort survives refreshes too. Explicit updates are checked by the
  // server; the CLI reports availability without substituting another tier.
  if (effort && /^[a-z]{2,12}$/.test(effort)) return effort;
  const spec = codexModelSpec(normalizeCodexModel(model));
  return spec.efforts.includes(effort as CodexEffort)
    ? effort as CodexEffort
    : spec.defaultEffort;
}

export function readStoredCodexModel(): string {
  if (typeof window === 'undefined') return DEFAULT_CODEX_MODEL;
  const raw = localStorage.getItem('rivendell:codex-model');
  const model = normalizeCodexModel(raw);
  if (raw !== model && catalogLoaded) {
    // Treat the persisted model + effort as one selection. When the model is
    // stale or missing, retaining an otherwise valid effort would create a
    // hybrid state (for example a removed model silently becoming Sol/xhigh).
    localStorage.setItem('rivendell:codex-model', model);
    localStorage.setItem('rivendell:codex-effort', codexModelSpec(model).defaultEffort);
  }
  return model;
}

export function readStoredCodexEffort(model = readStoredCodexModel()): CodexEffort {
  if (typeof window === 'undefined') return codexModelSpec(model).defaultEffort;
  const raw = localStorage.getItem('rivendell:codex-effort');
  const effort = normalizeCodexEffort(model, raw);
  if (raw !== effort && catalogLoaded) localStorage.setItem('rivendell:codex-effort', effort);
  return effort;
}

/** A rejection belongs to this conversation, not every account's catalog. */
export function lastRejectedCodexModel(blocks: ChatBlock[]): string | undefined {
  const failure = [...blocks].reverse().find(block => block.kind === 'terminal-error'
    && block.code === 'CODEX_MODEL_UNAVAILABLE' && block.model);
  return failure?.kind === 'terminal-error' ? failure.model : undefined;
}
