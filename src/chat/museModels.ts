// Muse Code catalog for the picker. Hand-verified list (mirrors the server's
// muse-models.ts). Standard models only: the CLI's `-contributor` twins let
// Meta train on the conversation and are never offered; a stored one
// migrates to its standard model.

export type MuseModelSpec = {
  id: string;
  label: string;
  contextWindow: number;
};

export const DEFAULT_MUSE_MODEL = 'muse-wonder-1.0';
export const DEFAULT_MUSE_EFFORT = 'high';
export const MUSE_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export const MUSE_MODELS: MuseModelSpec[] = [
  { id: 'muse-wonder-1.0', label: 'Muse Wonder 1.0', contextWindow: 1_000_000 },
  { id: 'muse-wonder-full-1.0', label: 'Muse Wonder Full 1.0', contextWindow: 1_000_000 },
  { id: 'muse-spark-1.3', label: 'Muse Spark 1.3', contextWindow: 1_000_000 },
];

export function normalizeMuseModel(model: string | null | undefined): string {
  const id = String(model ?? '').trim().replace(/-contributor$/, '');
  return MUSE_MODELS.some((entry) => entry.id === id) ? id : DEFAULT_MUSE_MODEL;
}

export function normalizeMuseEffort(effort: string | null | undefined): string {
  return effort && MUSE_EFFORTS.includes(effort) ? effort : DEFAULT_MUSE_EFFORT;
}

export function contextWindowForMuseModel(model: string | undefined): number {
  return MUSE_MODELS.find((entry) => entry.id === normalizeMuseModel(model))?.contextWindow ?? 1_000_000;
}

export function readStoredMuseModel(): string {
  if (typeof window === 'undefined') return DEFAULT_MUSE_MODEL;
  try {
    const raw = localStorage.getItem('rivendell:muse-model');
    const model = normalizeMuseModel(raw);
    if (raw !== model) localStorage.setItem('rivendell:muse-model', model);
    return model;
  } catch { return DEFAULT_MUSE_MODEL; }
}

export function readStoredMuseEffort(): string {
  if (typeof window === 'undefined') return DEFAULT_MUSE_EFFORT;
  try {
    const raw = localStorage.getItem('rivendell:muse-effort');
    const effort = normalizeMuseEffort(raw);
    if (raw !== effort) localStorage.setItem('rivendell:muse-effort', effort);
    return effort;
  } catch { return DEFAULT_MUSE_EFFORT; }
}
