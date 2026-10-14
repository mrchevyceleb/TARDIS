// Agy (Google Antigravity CLI) model catalog — the list behind the `agy`
// engine lane (agy-runner.ts), the /api/agy/models picker payload, and
// agent-brain validation. agy is a subscription CLI signed in on Matt's
// Google account, so this is a hand-verified list from live `agy models`
// output (2026-10-14): two base models, each taking low/medium/high as a
// separate --effort value. `agy models` also lists effort-suffixed ids
// (gemini-4-argon-medium); a suffixed id CONFLICTS with a separate --effort
// (verified: "invalid model selection ... conflicts with --effort=low"),
// so the lane always spawns a base id plus --effort and a stored suffixed
// pin migrates to its base id here.
//
// v1 keeps the hand list as the whole catalog: no live `agy models` poller
// is wired (the CLI read is local and cheap to add later; a stale hand list
// fails closed on spawn validation, never routes to a wrong model).
import { engineDefault } from '../lib/engineConfig.ts';

export type AgyModelInfo = {
  /** Base model id — the --model value the agy binary takes (with --effort). */
  id: string;
  label: string;
  efforts: string[];
  defaultEffort: string;
  /** Unmeasured: pinned to the expected Gemini 4 class; rotation errs early
   *  on the conservative side, so refine when measured. */
  contextWindow: number;
};

const LMH = ['low', 'medium', 'high'];

export const AGY_EFFORTS = ['low', 'medium', 'high'] as const;

const HAND_MODELS: AgyModelInfo[] = [
  { id: 'gemini-4-argon', label: 'Gemini 4 Argon', efforts: LMH, defaultEffort: 'medium', contextWindow: 1_000_000 },
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', efforts: LMH, defaultEffort: 'high', contextWindow: 1_000_000 },
];
const HAND_BY_ID = new Map(HAND_MODELS.map((m) => [m.id, m]));
const DEFAULT_MODEL = HAND_MODELS[0].id;

/** `agy models` lists effort-suffixed ids; one of ours with a known suffix
 *  maps back to its base id. */
const EFFORT_SUFFIX = /^-(low|medium|high|xhigh|max)$/;

function baseIdOf(model: string): string {
  for (const info of HAND_MODELS) {
    if (model === info.id) return info.id;
    if (model.startsWith(`${info.id}-`) && EFFORT_SUFFIX.test(model.slice(info.id.length))) return info.id;
  }
  return '';
}

/** Validate a brain model for the agy lane. A caller's fallback (the
 *  operator-configured lane default) is honored before the built-in default,
 *  so a configured Flash default survives normalization; unknown ids are
 *  never forwarded (a wrong id would 400 every turn). */
export function resolveAgyModel(model: string | undefined, fallback?: string): string {
  const base = baseIdOf(String(model ?? '').trim());
  if (base) return base;
  const fromFallback = baseIdOf(String(fallback ?? '').trim());
  return fromFallback || DEFAULT_MODEL;
}

export function resolveAgyEffort(model: string, effort: string | undefined): string {
  const info = HAND_BY_ID.get(resolveAgyModel(model)) ?? HAND_MODELS[0];
  const want = String(effort ?? '').trim().toLowerCase();
  return info.efforts.includes(want) ? want : info.defaultEffort;
}

export function agyModelSpec(model: string): AgyModelInfo | undefined {
  return HAND_BY_ID.get(resolveAgyModel(model));
}

/** Operator-configurable lane default (~/samwise/.accounts/engines.json). */
export const { model: AGY_LANE_MODEL, effort: AGY_LANE_EFFORT } = engineDefault('agy', DEFAULT_MODEL, 'medium');

/** Picker payload for /api/agy/models — the hand-verified list. */
export function agyCatalogPayload(): { models: AgyModelInfo[] } {
  return { models: HAND_MODELS.map((m) => ({ ...m, efforts: [...m.efforts] })) };
}
