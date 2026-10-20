// OpenRouter model catalog: the list behind the `openrouter` engine lane
// (runner.ts), the /api/openrouter/models picker payload, and agent-brain
// validation. Limits come only from the live public catalog. A missing or
// never substitutes invented limits or another selected model.
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
import { queueFlagDigest } from '../lib/flagDigest.ts';
import { engineDefault } from '../lib/engineConfig.ts';
import { ALL_EFFORTS, nearestEffort } from './fireworks-models.ts';

export type OpenRouterModelInfo = {
  /** OpenRouter model id, also the `--model` value the claude binary sends. */
  id: string;
  label: string;
  /** Tiers the model really honors, lowest first. */
  efforts: string[];
  contextWindow: number;
  /** The provider's output ceiling; a quarter of tool models sit under 64K. */
  maxOutput: number;
  imageInput?: boolean;
  reasoningMandatory?: boolean;
};

/** A reasoning model priced on a token budget: OpenRouter maps each tier to a share of max_tokens (xhigh and max are the same 95%). */
const BUDGET = ['low', 'medium', 'high', 'max'];
/** Not a reasoning model: the effort is ignored, so offer one tier. */
const NO_REASONING = ['high'];
const CATALOG_URL = process.env.RIVENDELL_OPENROUTER_MODELS_URL?.trim() || 'https://openrouter.ai/api/v1/models';
const FETCH_TIMEOUT_MS = 15_000;
const REFRESH_MS = 4 * 60 * 60 * 1000;
const BOOT_RETRY_MS = 60 * 1000;
const OPENROUTER_MODEL_ID = /^~?[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._:-]{0,127}$/;

/** Operator-configurable lane default (~/samwise/.accounts/engines.json). */
export const { model: OPENROUTER_LANE_MODEL, effort: OPENROUTER_LANE_EFFORT } = engineDefault(
  'openrouter',
  'anthropic/claude-sonnet-5.5',
  'high',
);

/** The second OpenRouter account is the same engine family with a different
 *  credential and Claude config dir. It shares the model/efforts resolution
 *  so both accounts offer the identical OpenRouter model set. */
export const { model: OPENROUTER2_LANE_MODEL, effort: OPENROUTER2_LANE_EFFORT } = engineDefault(
  'openrouter2',
  OPENROUTER_LANE_MODEL,
  OPENROUTER_LANE_EFFORT,
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
  const maxOutput = Number(recordOf(rec.top_provider).max_completion_tokens);
  if (!Number.isSafeInteger(context) || context <= 0 || !Number.isSafeInteger(maxOutput) || maxOutput <= 0) return null;
  return {
    id,
    label: (typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim() : id).slice(0, 80),
    // A model publishing only minimal/none still takes thinking fields; one tier.
    efforts: efforts.length ? [...efforts] : NO_REASONING,
    contextWindow: context,
    maxOutput,
    ...(reasoning?.mandatory === true ? { reasoningMandatory: true } : {}),
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

let catalog: OpenRouterModelInfo[] = [];
let fetchedAt = 0;
let refreshTimer: NodeJS.Timeout | null = null;
let inFlight: Promise<void> | null = null;
let refreshFailedAt = 0;
let warnedAt = 0;

function catalogFresh(): boolean { return fetchedAt > 0 && Date.now() - fetchedAt < REFRESH_MS; }

async function refreshCatalog(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const response = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`OpenRouter catalog HTTP ${response.status}`);
    const rows = recordOf(await response.json()).data;
    const next = (Array.isArray(rows) ? rows : []).flatMap((row) => {
      const info = rowToInfo(row);
      return info ? [{ info, created: Number(recordOf(row).created) || 0 }] : [];
    });
    if (!next.length) throw new Error('OpenRouter catalog has no tool models with valid context and output limits');
    catalog = sortCatalog(next);
    fetchedAt = Date.now();
  })();
  try { await inFlight; refreshFailedAt = 0; } catch (error) { refreshFailedAt = Date.now(); throw error; } finally { inFlight = null; }
}

/** Boot refresh retries without inventing limits. Spawn validation below is
 * strict: a failed catalog fetch cannot silently select a different model. */
export async function startOpenRouterCatalog(): Promise<void> {
  try { if (!catalogFresh()) await refreshCatalog(); }
  catch (error) { console.warn(`[openrouter] ${(error as Error).message}`); }
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    if (!catalogFresh()) void refreshCatalog().catch(error => console.warn(`[openrouter] ${error.message}`));
  }, BOOT_RETRY_MS);
  refreshTimer.unref();
}

export async function requireOpenRouterModel(model: string): Promise<OpenRouterModelInfo> {
  if ((!catalogFresh() || !catalog.some(info => info.id === model)) && Date.now() - refreshFailedAt > BOOT_RETRY_MS) {
    try { await refreshCatalog(); }
    catch {
      if (catalog.some(info => info.id === model) && Date.now() - warnedAt > REFRESH_MS) {
        warnedAt = Date.now();
        queueFlagDigest('chief-of-staff', 'openrouter-catalog-refresh', 'OpenRouter catalog refresh failed. Existing model IDs keep their last verified limits; new IDs wait for a successful catalog read.', undefined, true);
      }
    }
  }
  const info = openRouterCapability(model);
  if (!info) throw new Error(`OpenRouter has no current context/output limits for ${model}; the selected session and queued messages are retained.`);
  return info;
}

export function openRouterModelList(): OpenRouterModelInfo[] {
  return catalog;
}

export function openRouterCapability(model: string): OpenRouterModelInfo | undefined {
  return openRouterModelList().find(info => info.id === model);
}

export function openRouterContextWindow(model: string): number {
  const info = openRouterCapability(model);
  if (!info) throw new Error(`Current OpenRouter context limit unavailable for ${model}`);
  return info.contextWindow;
}

export function openRouterMaxOutput(model: string): number {
  const info = openRouterCapability(model);
  if (!info) throw new Error(`Current OpenRouter output limit unavailable for ${model}`);
  return info.maxOutput;
}

export function openRouterCatalogPayload(): { models: OpenRouterModelInfo[]; source: 'catalog' | 'unavailable' } {
  return { models: openRouterModelList(), source: catalog.length ? 'catalog' : 'unavailable' };
}

/** Preserve the operator's selected ID. Live validation runs before spawn,
 * never falling back to another model because a catalog request failed. */
export function resolveOpenRouterModel(m: string | undefined, fallback = OPENROUTER_LANE_MODEL): string {
  const model = m?.trim() || fallback;
  if (!OPENROUTER_MODEL_ID.test(model)) throw new Error('Invalid OpenRouter model ID');
  return model;
}

/** Effort checked against the model's own tiers, stepping down (never up). */
export function resolveOpenRouterEffort(e: string | undefined, model?: string, fallback = OPENROUTER_LANE_EFFORT): string {
  return nearestEffort(openRouterEffortsFor(model), e?.trim(), fallback);
}

export function openRouterEffortsFor(model: string | undefined): string[] {
  return openRouterCapability(resolveOpenRouterModel(model))?.efforts ?? ALL_EFFORTS;
}

export function resolveOpenRouter2Model(m: string | undefined, fallback = OPENROUTER2_LANE_MODEL): string {
  return resolveOpenRouterModel(m, fallback);
}

export function resolveOpenRouter2Effort(e: string | undefined, model?: string, fallback = OPENROUTER2_LANE_EFFORT): string {
  return resolveOpenRouterEffort(e, model, fallback);
}
