import { resolveAgyModel, resolveAgyEffort, agyModelLabel } from '../../server/src/shared/agyModels';

export {
  AGY_MODELS,
  DEFAULT_AGY_MODEL,
  DEFAULT_AGY_EFFORT,
  resolveAgyModel as normalizeAgyModel,
  resolveAgyEffort as normalizeAgyEffort,
  agyEffortsForModel,
  agyModelLabel,
  contextWindowForAgyModel,
} from '../../server/src/shared/agyModels';

/** Keep model changes honest when the previous thinking level is unavailable. */
export function agyModelChange(value: string, currentEffort?: string) {
  const model = resolveAgyModel(value);
  const effort = resolveAgyEffort(model, currentEffort);
  const notice = currentEffort && currentEffort !== effort
    ? `${agyModelLabel(model)} doesn't offer ${currentEffort} thinking. Switched to ${effort}.`
    : null;
  return { model, effort, notice };
}
