import { engineDefault } from '../lib/engineConfig.ts';
import { AGY_MODELS, DEFAULT_AGY_MODEL, DEFAULT_AGY_EFFORT, type AgyModelInfo } from '../shared/agyModels.ts';

export { agyModelSpec, resolveAgyModel, resolveAgyEffort } from '../shared/agyModels.ts';
export type { AgyModelInfo } from '../shared/agyModels.ts';

/** Operator-configurable lane default; kept out of the browser-safe catalog. */
export const { model: AGY_LANE_MODEL, effort: AGY_LANE_EFFORT } = engineDefault('agy', DEFAULT_AGY_MODEL, DEFAULT_AGY_EFFORT);

/** Picker payload for /api/agy/models — the same catalog the UI uses. */
export function agyCatalogPayload(): { models: AgyModelInfo[] } {
  return { models: AGY_MODELS.map(m => ({ ...m, efforts: [...m.efforts] })) };
}
