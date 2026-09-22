export type CodexEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

export type CodexModelSpec = {
  id: string;
  label: string;
  defaultEffort: CodexEffort;
  efforts: CodexEffort[];
  contextWindow: number;
};

const STANDARD_EFFORTS: CodexEffort[] = ['low', 'medium', 'high', 'xhigh'];
const MAX_EFFORTS: CodexEffort[] = [...STANDARD_EFFORTS, 'max'];

export const DEFAULT_CODEX_MODEL = 'gpt-5.6-sol';

// Synced with Codex CLI 0.155.1's model catalog on 2026-09-22.
export const CODEX_MODELS: CodexModelSpec[] = [
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

export function codexModelSpec(model: string): CodexModelSpec {
  return CODEX_MODELS.find((entry) => entry.id === model)
    ?? CODEX_MODELS.find((entry) => entry.id === DEFAULT_CODEX_MODEL)!;
}

export function normalizeCodexModel(model: string | null | undefined): string {
  return CODEX_MODELS.some((entry) => entry.id === model) ? model! : DEFAULT_CODEX_MODEL;
}

export function codexEffortsForModel(model: string): CodexEffort[] {
  return codexModelSpec(model).efforts;
}

export function contextWindowForCodexModel(model: string | undefined): number {
  return codexModelSpec(normalizeCodexModel(model)).contextWindow;
}

export function normalizeCodexEffort(model: string, effort: string | null | undefined): CodexEffort {
  const spec = codexModelSpec(normalizeCodexModel(model));
  return spec.efforts.includes(effort as CodexEffort)
    ? effort as CodexEffort
    : spec.defaultEffort;
}

export function readStoredCodexModel(): string {
  if (typeof window === 'undefined') return DEFAULT_CODEX_MODEL;
  const raw = localStorage.getItem('rivendell:codex-model');
  const model = normalizeCodexModel(raw);
  if (raw !== model) {
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
  if (raw !== effort) localStorage.setItem('rivendell:codex-effort', effort);
  return effort;
}
