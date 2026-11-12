// Browser-safe Antigravity catalog. Add a model here once: server validation,
// pickers, labels and context meters all consume this metadata.
export type AgyModelInfo = {
  id: string;
  label: string;
  efforts: string[];
  defaultEffort: string;
  contextWindow: number;
};

// IDs and efforts verified with agy 1.5.7 `agy models` on 2026-11-12.
// Hydrogen's default and 1M context window are published by Google:
// https://antigravity.google/docs/models
// https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-gemini-4-hydrogen/
// Existing models retain their previous metadata and defaults.
export const AGY_MODELS: AgyModelInfo[] = [
  { id: 'gemini-4-argon', label: 'Gemini 4 Argon', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', contextWindow: 1_000_000 },
  { id: 'gemini-4-carbon', label: 'Gemini 4 Carbon', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', contextWindow: 1_000_000 },
  { id: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', contextWindow: 1_000_000 },
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'], defaultEffort: 'high', contextWindow: 1_000_000 },
];
export const DEFAULT_AGY_MODEL = AGY_MODELS[0].id;
export const DEFAULT_AGY_EFFORT = AGY_MODELS[0].defaultEffort;

/** Keep legacy suffixed pins on their model, even if their old effort is no
 * longer offered. Effort validation is separate; unknown ids stay unknown. */
export function agyModelSpec(model: string | undefined): AgyModelInfo | undefined {
  const id = String(model ?? '').trim();
  return AGY_MODELS.find(info => id === info.id || (id.startsWith(`${info.id}-`) && /^-(low|medium|high|xhigh|max)$/.test(id.slice(info.id.length))));
}

/** The CLI takes a base id plus --effort; passing both a suffixed id and
 * --effort can conflict. Normalize legacy suffixed pins before launching. */
export function resolveAgyModel(model: string | undefined, fallback?: string): string {
  return agyModelSpec(model)?.id ?? agyModelSpec(fallback)?.id ?? DEFAULT_AGY_MODEL;
}

export function resolveAgyEffort(model: string, effort: string | undefined, fallback?: string): string {
  const info = agyModelSpec(model) ?? AGY_MODELS[0];
  const want = String(effort ?? '').trim().toLowerCase();
  if (info.efforts.includes(want)) return want;
  const fromFallback = String(fallback ?? '').trim().toLowerCase();
  return info.efforts.includes(fromFallback) ? fromFallback : info.defaultEffort;
}

export function agyEffortsForModel(model: string): string[] {
  return [...(agyModelSpec(model) ?? AGY_MODELS[0]).efforts];
}

export function agyModelLabel(model: string): string {
  return agyModelSpec(model)?.label ?? model;
}

export function contextWindowForAgyModel(model?: string): number {
  return (agyModelSpec(model) ?? AGY_MODELS[0]).contextWindow;
}
