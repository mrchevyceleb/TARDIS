import { engineDefault } from '../lib/engineConfig.ts';

type CodexModelCapability = {
  defaultEffort: string;
  efforts: ReadonlySet<string>;
};

const STANDARD_CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const CODEX_MODEL_CAPABILITIES: Record<string, CodexModelCapability> = {
  'gpt-6-astra': {
    defaultEffort: 'medium',
    efforts: new Set([...STANDARD_CODEX_EFFORTS, 'max', 'ultra']),
  },
  'gpt-6-sol': {
    defaultEffort: 'medium',
    efforts: new Set([...STANDARD_CODEX_EFFORTS, 'max', 'ultra']),
  },
  'gpt-6-luna': {
    defaultEffort: 'medium',
    efforts: new Set([...STANDARD_CODEX_EFFORTS, 'max']),
  },
  'gpt-5.6-sol': {
    defaultEffort: 'low',
    efforts: new Set([...STANDARD_CODEX_EFFORTS, 'max', 'ultra']),
  },
  'gpt-5.6-luna': {
    defaultEffort: 'medium',
    efforts: new Set([...STANDARD_CODEX_EFFORTS, 'max']),
  },
  'gpt-5.5': { defaultEffort: 'medium', efforts: new Set(STANDARD_CODEX_EFFORTS) },
  'gpt-5.3-codex': { defaultEffort: 'high', efforts: new Set(STANDARD_CODEX_EFFORTS) },
  'gpt-5.3-codex-spark': { defaultEffort: 'high', efforts: new Set(STANDARD_CODEX_EFFORTS) },
};

function codexCapability(model: string): CodexModelCapability | undefined {
  return Object.prototype.hasOwnProperty.call(CODEX_MODEL_CAPABILITIES, model)
    ? CODEX_MODEL_CAPABILITIES[model]
    : undefined;
}

const configuredCodex = engineDefault('codex', 'gpt-5.6-sol', 'low');
const CODEX_MODEL = codexCapability(configuredCodex.model)
  ? configuredCodex.model
  : 'gpt-5.6-sol';
const CODEX_EFFORT = codexCapability(CODEX_MODEL)!.efforts.has(configuredCodex.effort)
  ? configuredCodex.effort
  : codexCapability(CODEX_MODEL)!.defaultEffort;

/** Resolve browser-supplied values before they can reach Codex CLI arguments. */
export function resolveCodexSelection(
  requestedModel?: unknown,
  requestedEffort?: unknown,
): { model: string; effort: string } {
  const modelValue = typeof requestedModel === 'string' ? requestedModel : undefined;
  const effortValue = typeof requestedEffort === 'string' ? requestedEffort : undefined;
  const requestedCapability = modelValue ? codexCapability(modelValue) : undefined;
  const model = requestedCapability ? modelValue! : CODEX_MODEL;
  const capability = codexCapability(model)!;
  const fallbackEffort = model === CODEX_MODEL ? CODEX_EFFORT : capability.defaultEffort;
  const invalidRequestedModel = requestedModel !== undefined && !requestedCapability;
  const effort = !invalidRequestedModel && effortValue && capability.efforts.has(effortValue)
    ? effortValue
    : fallbackEffort;
  return { model, effort };
}
