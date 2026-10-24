// Meta Model API catalog for the picker. Hand-verified list (mirrors the
// server's meta-models.ts); discovery never rewrites a stored choice.

export type MetaModelSpec = {
  id: string;
  label: string;
  efforts: string[];
  contextWindow: number;
  imageInput?: boolean;
};

export const DEFAULT_META_MODEL = 'muse-wonder-1.0';
export const DEFAULT_META_EFFORT = 'high';
const ALL_META_EFFORTS = ['low', 'medium', 'high', 'xhigh'];

export const META_MODELS: MetaModelSpec[] = [
  { id: 'muse-wonder-1.0', label: 'Muse Wonder 1.0', efforts: ALL_META_EFFORTS, contextWindow: 1_048_576, imageInput: true },
  { id: 'muse-spark-1.3', label: 'Muse Spark 1.3', efforts: ALL_META_EFFORTS, contextWindow: 1_048_576, imageInput: true },
  { id: 'muse-spark-1.3-contributor', label: 'Muse Spark 1.3 Contributor', efforts: ALL_META_EFFORTS, contextWindow: 1_048_576, imageInput: true },
  { id: 'muse-spark-1.2', label: 'Muse Spark 1.2', efforts: ALL_META_EFFORTS, contextWindow: 1_048_576, imageInput: true },
  { id: 'muse-spark-1.2-contributor', label: 'Muse Spark 1.2 Contributor', efforts: ALL_META_EFFORTS, contextWindow: 1_048_576, imageInput: true },
  { id: 'muse-spark-1.1', label: 'Muse Spark 1.1', efforts: ALL_META_EFFORTS, contextWindow: 1_048_576, imageInput: true },
];

export function metaModelSpec(model: string): MetaModelSpec {
  return META_MODELS.find((entry) => entry.id === model)
    ?? { id: model, label: model, efforts: ALL_META_EFFORTS, contextWindow: 1_048_576 };
}

export function normalizeMetaModel(model: string | null | undefined): string {
  return model && META_MODELS.some((entry) => entry.id === model) ? model : DEFAULT_META_MODEL;
}

export function metaEffortsForModel(model: string): string[] {
  return metaModelSpec(normalizeMetaModel(model)).efforts;
}

export function contextWindowForMetaModel(model: string | undefined): number {
  return metaModelSpec(normalizeMetaModel(model ?? '')).contextWindow;
}

export function normalizeMetaEffort(model: string, effort: string | null | undefined): string {
  const spec = metaModelSpec(normalizeMetaModel(model));
  if (effort && spec.efforts.includes(effort)) return effort;
  const target = ALL_META_EFFORTS.indexOf(effort && ALL_META_EFFORTS.includes(effort) ? effort : DEFAULT_META_EFFORT);
  const below = spec.efforts.filter((tier) => ALL_META_EFFORTS.indexOf(tier) <= target);
  return below[below.length - 1] ?? spec.efforts[0] ?? DEFAULT_META_EFFORT;
}

export function readStoredMetaModel(): string {
  if (typeof window === 'undefined') return DEFAULT_META_MODEL;
  const raw = localStorage.getItem('rivendell:meta-model');
  const model = normalizeMetaModel(raw);
  if (raw !== model) localStorage.setItem('rivendell:meta-model', model);
  return model;
}

export function readStoredMetaEffort(model = readStoredMetaModel()): string {
  if (typeof window === 'undefined') return DEFAULT_META_EFFORT;
  const raw = localStorage.getItem('rivendell:meta-effort');
  const effort = normalizeMetaEffort(model, raw);
  if (raw !== effort) localStorage.setItem('rivendell:meta-effort', effort);
  return effort;
}
