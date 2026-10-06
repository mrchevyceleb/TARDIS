// OpenRouter model catalog — the list behind the `openrouter` engine lane
// (runner.ts), the /api/openrouter/models picker payload, and agent-brain
// validation. Same shape as fireworks-models.ts: a hand fallback list plus the
// live public catalog (GET https://openrouter.ai/api/v1/models, no key), with a
// sync capability lookup for spawn-time validation.
//
// Only models that support `tools` are offered (the claude binary is agentic),
// minus `:batch` variants and anything that outputs more than text.
//
// Effort tiers are per model and come from the catalog itself. The claude
// binary sends `--effort X` as `output_config: {effort: X}` with
// `thinking: {type: 'adaptive'}` (captured 2026-10-06). OpenRouter's Anthropic
// skin maps output_config.effort onto its own `reasoning.effort`, snapping an
// unsupported tier to the nearest one, and each catalog row publishes
// `reasoning.supported_efforts`. Probes on 2026-10-06 showed the tier is real
// (thinking tokens move with it on Claude, Kimi K3 and GLM 5.3). So a model
// offers its published tiers that the binary can send (minimal/none are not
// claude --effort values). A reasoning model with no published tiers is
// budget-based (OpenRouter turns the effort into a share of max_tokens), so it
// gets low/medium/high/max. A non-reasoning model accepts the thinking fields
// and ignores them (HTTP 200, no thinking), so it gets one tier.
import { engineDefault } from '../lib/engineConfig.ts';
import { ALL_EFFORTS, nearestEffort } from './fireworks-models.ts';

export type OpenRouterModelInfo = {
  /** OpenRouter model id — also the `--model` value the claude binary sends. */
  id: string;
  label: string;
  /** Tiers the model really honors, lowest first. */
  efforts: string[];
  contextWindow: number;
  imageInput?: boolean;
};

/** A reasoning model priced on a token budget: OpenRouter maps each tier to a share of max_tokens (xhigh and max are the same 95%). */
const BUDGET = ['low', 'medium', 'high', 'max'];
/** Not a reasoning model: the effort is ignored, so offer one tier. */
const NO_REASONING = ['high'];
const ALL = [...ALL_EFFORTS];
const LHX = ['low', 'high', 'max'];

// Fallback only, until the first catalog fetch lands. From the live catalog 2026-10-06.
const HAND_LIST: OpenRouterModelInfo[] = [
  { id: 'anthropic/claude-fable-5.1', label: 'Anthropic: Claude Fable 5.1', efforts: ALL, contextWindow: 1_000_000, imageInput: true },
  { id: 'anthropic/claude-opus-5.5', label: 'Anthropic: Claude Opus 5.5', efforts: ALL, contextWindow: 1_000_000, imageInput: true },
  { id: 'anthropic/claude-sonnet-5.5', label: 'Anthropic: Claude Sonnet 5.5', efforts: ALL, contextWindow: 1_000_000, imageInput: true },
  { id: 'deepseek/deepseek-v4.1-flash', label: 'DeepSeek: DeepSeek V4.1 Flash', efforts: LHX, contextWindow: 1_048_576, imageInput: true },
  { id: 'google/gemini-3.8-flash', label: 'Google: Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'], contextWindow: 1_048_576, imageInput: true },
  { id: 'minimax/minimax-m3', label: 'MiniMax: MiniMax M3', efforts: BUDGET, contextWindow: 1_048_576, imageInput: true },
  { id: 'moonshotai/kimi-k3', label: 'MoonshotAI: Kimi K3', efforts: LHX, contextWindow: 1_048_576, imageInput: true },
  { id: 'openai/gpt-5.6-sol', label: 'OpenAI: GPT-5.6 Sol', efforts: ALL, contextWindow: 1_050_000, imageInput: true },
  { id: 'openai/gpt-5.6-terra', label: 'OpenAI: GPT-5.6 Terra', efforts: ALL, contextWindow: 1_050_000, imageInput: true },
  { id: 'qwen/qwen3.8-max-prime', label: 'Qwen: Qwen3.8 Max Prime', efforts: ['low', 'medium', 'high', 'xhigh'], contextWindow: 1_000_000, imageInput: true },
  { id: 'x-ai/grok-4.7', label: 'xAI: Grok 4.7', efforts: ['low', 'medium', 'high', 'xhigh'], contextWindow: 500_000, imageInput: true },
  { id: 'z-ai/glm-5.3', label: 'Z.ai: GLM 5.3', efforts: LHX, contextWindow: 1_048_576 },
  { id: 'z-ai/glm-5.3-flash', label: 'Z.ai: GLM 5.3 Flash', efforts: LHX, contextWindow: 1_048_576, imageInput: true },
];

const CATALOG_URL = process.env.RIVENDELL_OPENROUTER_MODELS_URL?.trim() || 'https://openrouter.ai/api/v1/models';
const DEFAULT_CONTEXT_WINDOW = 200_000;
const FETCH_TIMEOUT_MS = 15_000;
const REFRESH_MS = 4 * 60 * 60 * 1000;
const BOOT_RETRY_MS = 60 * 1000;
const BOOT_RETRIES = 15;
const OPENROUTER_MODEL_ID = /^~?[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._:-]{0,127}$/;

/** Operator-configurable lane default (~/samwise/.accounts/engines.json). */
export const { model: OPENROUTER_LANE_MODEL, effort: OPENROUTER_LANE_EFFORT } = engineDefault(
  'openrouter',
  'anthropic/claude-sonnet-5.5',
  'high',
);

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function rowToInfo(row: unknown): OpenRouterModelInfo | null {
  const rec = recordOf(row);
  const id = typeof rec.id === 'string' ? rec.id.trim() : '';
  if (!OPENROUTER_MODEL_ID.test(id) || id.endsWith(':batch')) return null;
  if (!stringsOf(rec.supported_parameters).includes('tools')) return null;
  const arch = recordOf(rec.architecture);
  const outputs = stringsOf(arch.output_modalities);
  if (outputs.length > 0 && outputs.some((m) => m !== 'text')) return null;
  const reasoning = rec.reasoning && typeof rec.reasoning === 'object' ? recordOf(rec.reasoning) : null;
  const published = stringsOf(reasoning?.supported_efforts);
  const efforts = published.length
    ? ALL_EFFORTS.filter((tier) => published.includes(tier))
    : reasoning ? BUDGET : NO_REASONING;
  const context = Number(rec.context_length);
  return {
    id,
    label: (typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim() : id).slice(0, 80),
    // A model publishing only minimal/none still takes thinking fields; one tier.
    efforts: efforts.length ? [...efforts] : NO_REASONING,
    contextWindow: Number.isFinite(context) && context > 0 ? context : DEFAULT_CONTEXT_WINDOW,
    ...(stringsOf(arch.input_modalities).includes('image') ? { imageInput: true } : {}),
  };
}

/** Grouped by vendor, newest first inside a vendor. */
function sortCatalog(rows: Array<{ info: OpenRouterModelInfo; created: number }>): OpenRouterModelInfo[] {
  const vendor = (id: string) => id.replace(/^~/, '').split('/')[0]!;
  return rows
    .sort((a, b) => vendor(a.info.id).localeCompare(vendor(b.info.id)) || b.created - a.created || a.info.id.localeCompare(b.info.id))
    .map((row) => row.info);
}

let catalog: OpenRouterModelInfo[] | null = null;
let refreshTimer: NodeJS.Timeout | null = null;

async function refreshCatalog(): Promise<OpenRouterModelInfo[]> {
  try {
    const response = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const rows = recordOf(await response.json()).data;
    const next = (Array.isArray(rows) ? rows : []).flatMap((row) => {
      const info = rowToInfo(row);
      return info ? [{ info, created: Number(recordOf(row).created) || 0 }] : [];
    });
    // Keep the prior list on an empty answer (fail-open, like fireworks).
    if (next.length > 0) catalog = sortCatalog(next);
  } catch (error) {
    console.warn(`[openrouter] catalog refresh failed: ${(error as Error).message}`);
  }
  return catalog ?? HAND_LIST;
}

/** Warm the catalog at boot and refresh it every few hours; a failed boot
 *  fetch retries every minute for a while. Never throws. */
export async function startOpenRouterCatalog(): Promise<void> {
  await refreshCatalog();
  if (refreshTimer) return;
  refreshTimer = setInterval(() => { void refreshCatalog(); }, REFRESH_MS);
  refreshTimer.unref();
  let retries = 0;
  const retry = (): void => {
    if (catalog !== null || retries++ >= BOOT_RETRIES) return;
    setTimeout(() => { void refreshCatalog().then(retry); }, BOOT_RETRY_MS).unref();
  };
  retry();
}

export function openRouterModelList(): OpenRouterModelInfo[] {
  return catalog ?? HAND_LIST;
}

export function openRouterCapability(model: string): OpenRouterModelInfo | undefined {
  return openRouterModelList().find((info) => info.id === model);
}

/** True context window for the spawn env (MAX_CONTEXT + AUTO_COMPACT). */
export function openRouterContextWindow(model: string): number {
  return openRouterCapability(model)?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
}

export function openRouterCatalogPayload(): { models: OpenRouterModelInfo[]; source: 'catalog' | 'hand' } {
  return { models: openRouterModelList(), source: catalog ? 'catalog' : 'hand' };
}

/** Same rule as the fireworks lane: a catalog id passes, a well-formed unknown
 *  id survives only until the live catalog lands, anything else falls back. */
export function resolveOpenRouterModel(m: string | undefined, fallback = OPENROUTER_LANE_MODEL): string {
  const model = m?.trim();
  if (!model) return fallback;
  if (openRouterCapability(model)) return model;
  if (catalog === null && OPENROUTER_MODEL_ID.test(model)) return model;
  return fallback;
}

/** Effort checked against the model's own tiers, stepping down (never up). */
export function resolveOpenRouterEffort(e: string | undefined, model?: string, fallback = OPENROUTER_LANE_EFFORT): string {
  return nearestEffort(openRouterEffortsFor(model), e?.trim(), fallback);
}

export function openRouterEffortsFor(model: string | undefined): string[] {
  return openRouterCapability(resolveOpenRouterModel(model))?.efforts ?? ALL_EFFORTS;
}
