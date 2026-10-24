// Meta Model API catalog — the list behind the `meta` engine lane
// (runner.ts), the /api/meta/models picker payload, and agent-brain
// validation. Meta's own direct API (https://api.meta.ai/v1, key in
// MODEL_API_KEY) serves Muse Spark over an Anthropic-compatible Messages
// endpoint (https://api.meta.ai/v1/messages), so the lane runs the stock
// `claude` binary with ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN redirected,
// the same trick as Fireworks/OpenRouter.
//
// Hand-verified 2026-10-24 from Meta's docs (dev.meta.ai) and the live model
// list: muse-wonder-1.0 (Meta's pick for long-running agentic work in its
// coding-agent guides), muse-spark-1.3 and muse-spark-1.3-contributor (1,048,576-token
// context, 131,072 max output, text/image/video/PDF input, tool calling) and
// muse-spark-1.1 (same context/output class). No live catalog poller in v1:
// the model list is tiny and stable, and an unknown id fails closed here
// instead of spawning a model Meta would 400.
import { engineDefault } from '../lib/engineConfig.ts';
import { nearestEffort } from './fireworks-models.ts';

export type MetaModelInfo = {
  /** Meta model id — also the `--model` value the claude binary sends. */
  id: string;
  label: string;
  /** Reasoning tiers the lane offers. Meta accepts the claude binary's
   *  output_config.effort values on its Messages surface. */
  efforts: string[];
  contextWindow: number;
  maxOutput: number;
  imageInput?: boolean;
};

// Meta's Messages endpoint takes low..xhigh; 'max' is a 400 there.
const LMHX = ['low', 'medium', 'high', 'xhigh'];

const HAND_MODELS: MetaModelInfo[] = [
  { id: 'muse-wonder-1.0', label: 'Muse Wonder 1.0', efforts: LMHX, contextWindow: 1_048_576, maxOutput: 131_072, imageInput: true },
  { id: 'muse-spark-1.3', label: 'Muse Spark 1.3', efforts: LMHX, contextWindow: 1_048_576, maxOutput: 131_072, imageInput: true },
  { id: 'muse-spark-1.3-contributor', label: 'Muse Spark 1.3 Contributor', efforts: LMHX, contextWindow: 1_048_576, maxOutput: 131_072, imageInput: true },
  { id: 'muse-spark-1.2', label: 'Muse Spark 1.2', efforts: LMHX, contextWindow: 1_048_576, maxOutput: 131_072, imageInput: true },
  { id: 'muse-spark-1.2-contributor', label: 'Muse Spark 1.2 Contributor', efforts: LMHX, contextWindow: 1_048_576, maxOutput: 131_072, imageInput: true },
  { id: 'muse-spark-1.1', label: 'Muse Spark 1.1', efforts: LMHX, contextWindow: 1_048_576, maxOutput: 131_072, imageInput: true },
];
const HAND_BY_ID = new Map(HAND_MODELS.map((model) => [model.id, model]));

/** Operator-configurable lane default (~/samwise/.accounts/engines.json). */
export const { model: META_LANE_MODEL, effort: META_LANE_EFFORT } = engineDefault(
  'meta',
  'muse-wonder-1.0',
  'high',
);

export function metaModelList(): MetaModelInfo[] {
  return HAND_MODELS;
}

export function metaCapability(model: string): MetaModelInfo | undefined {
  return HAND_BY_ID.get(model);
}

export function metaContextWindow(model: string): number {
  return metaCapability(model)?.contextWindow ?? 1_048_576;
}

export function metaMaxOutput(model: string): number {
  return metaCapability(model)?.maxOutput ?? 131_072;
}

export function metaCatalogPayload(): { models: MetaModelInfo[]; source: 'hand' } {
  return { models: HAND_MODELS.map((model) => ({ ...model, efforts: [...model.efforts] })), source: 'hand' };
}

/** A verified Meta id passes; anything else falls to the lane default rather
 *  than forwarding a typo Meta would reject on every turn. */
export function resolveMetaModel(m: string | undefined, fallback = META_LANE_MODEL): string {
  const model = m?.trim();
  if (model && HAND_BY_ID.has(model)) return model;
  return HAND_BY_ID.has(fallback) ? fallback : HAND_MODELS[0].id;
}

export function metaEffortsFor(model: string | undefined): string[] {
  return metaCapability(resolveMetaModel(model))?.efforts ?? LMHX;
}

/** Effort checked against the model's own tiers, stepping down (never up). */
export function resolveMetaEffort(e: string | undefined, model?: string, fallback = META_LANE_EFFORT): string {
  return nearestEffort(metaEffortsFor(model), e?.trim(), fallback);
}
