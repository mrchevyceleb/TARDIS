// Muse Code catalog — the list behind the `muse` engine lane (muse-runner.ts),
// the /api/muse/models picker payload, and agent-brain validation. Muse Code
// is Meta's own coding CLI (`muse`), signed in on Matt's Muse Code
// subscription (~/.config/muse/auth.json). The subscription covers ONLY the
// CLI's own signed-in credential, so this lane always drives the CLI and
// never calls api.meta.ai with a key (that is the separate, metered `meta`
// lane in meta-models.ts).
//
// Hand-verified 2026-10-24 from the CLI's own catalog cache and live
// `muse exec` probes on this plan: muse-wonder-1.0, muse-wonder-full-1.0 and
// muse-spark-1.3, each 1,007,997-token context, taking --reasoning-effort
// minimal|low|medium|high|xhigh|max. The catalog also lists `-contributor`
// twins (and marks one as the CLI default): those let Meta train on the
// conversation, and client code goes through this lane, so they are never
// offered, a stored contributor pin migrates to its standard twin, and every
// spawn pins `--contributor-mode off` on top.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { engineDefault } from '../lib/engineConfig.ts';

export type MuseModelInfo = {
  /** The --model value `muse exec` takes. */
  id: string;
  label: string;
  efforts: string[];
  defaultEffort: string;
  contextWindow: number;
};

export const MUSE_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const ALL = [...MUSE_EFFORTS];

const HAND_MODELS: MuseModelInfo[] = [
  { id: 'muse-wonder-1.0', label: 'Muse Wonder 1.0', efforts: ALL, defaultEffort: 'high', contextWindow: 1_000_000 },
  { id: 'muse-wonder-full-1.0', label: 'Muse Wonder Full 1.0', efforts: ALL, defaultEffort: 'high', contextWindow: 1_000_000 },
  { id: 'muse-spark-1.3', label: 'Muse Spark 1.3', efforts: ALL, defaultEffort: 'high', contextWindow: 1_000_000 },
];
const HAND_BY_ID = new Map(HAND_MODELS.map((m) => [m.id, m]));
const DEFAULT_MODEL = HAND_MODELS[0].id;

/** A known id, or a `-contributor` twin mapped to its standard model. */
function standardIdOf(model: string): string {
  const id = model.trim().replace(/-contributor$/, '');
  return HAND_BY_ID.has(id) ? id : '';
}

/** Validate a brain model for the muse lane. Unknown ids are never forwarded,
 *  and a contributor id can never come out of here. */
export function resolveMuseModel(model: string | undefined, fallback?: string): string {
  return standardIdOf(String(model ?? '')) || standardIdOf(String(fallback ?? '')) || DEFAULT_MODEL;
}

export function resolveMuseEffort(model: string, effort: string | undefined, fallback?: string): string {
  const info = HAND_BY_ID.get(resolveMuseModel(model)) ?? HAND_MODELS[0];
  const want = String(effort ?? '').trim().toLowerCase();
  if (info.efforts.includes(want)) return want;
  const fromFallback = String(fallback ?? '').trim().toLowerCase();
  return info.efforts.includes(fromFallback) ? fromFallback : info.defaultEffort;
}

export function museModelSpec(model: string): MuseModelInfo | undefined {
  return HAND_BY_ID.get(resolveMuseModel(model));
}

/** Operator-configurable lane default (~/samwise/.accounts/engines.json). */
const configured = engineDefault('muse', DEFAULT_MODEL, 'high');
export const MUSE_LANE_MODEL = resolveMuseModel(configured.model);
export const MUSE_LANE_EFFORT = resolveMuseEffort(MUSE_LANE_MODEL, configured.effort);

/** Picker payload for /api/muse/models — the hand-verified list. */
export function museCatalogPayload(): { models: MuseModelInfo[] } {
  return { models: HAND_MODELS.map((m) => ({ ...m, efforts: [...m.efforts] })) };
}

/** The muse launcher. Same rule as the codex/agy resolvers: an explicit
 *  override, then the standalone install, then PATH. */
export function resolveMuseBin(): string {
  const explicit = process.env.RIVENDELL_MUSE_BIN?.trim();
  if (explicit) return explicit;
  const standalone = join(homedir(), '.local', 'bin', 'muse');
  return existsSync(standalone) ? standalone : 'muse';
}

/** True when this host has a Muse Code install or sign-in to report on. */
export function museInstalled(): boolean {
  return Boolean(process.env.RIVENDELL_MUSE_BIN?.trim())
    || existsSync(join(homedir(), '.local', 'bin', 'muse'))
    || existsSync(join(homedir(), '.config', 'muse', 'auth.json'));
}

export type MuseAllowance = {
  tier: string | null;
  window: { usedPercent: number; resetsAtMs: number | null } | null;
  weekly: { usedPercent: number; resetsAtMs: number | null } | null;
  asOfMs: number;
};

let lastAllowance: MuseAllowance | null = null;

const pct = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
const ms = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/** Normalize an allowance from either shape the CLI prints: the exec stream's
 *  snake_case `run.usage` payload or `muse usage --json`'s camelCase. */
export function parseMuseAllowance(raw: unknown): MuseAllowance | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, any>;
  const bucket = (b: any) => {
    if (!b || typeof b !== 'object') return null;
    const used = pct(b.used_percent ?? b.usedPercent);
    return used === undefined ? null : { usedPercent: used, resetsAtMs: ms(b.resets_at_ms ?? b.resetsAtMs) };
  };
  const window = bucket(a.window);
  const weekly = bucket(a.weekly);
  if (!window && !weekly) return null;
  return { tier: typeof a.tier === 'string' && a.tier ? a.tier : null, window, weekly, asOfMs: ms(a.as_of_ms ?? a.asOfMs) ?? Date.now() };
}

/** The freshest plan reading any lane has seen (every turn's `run.usage`
 *  carries one); the Usage room falls back to it when `muse usage` cannot run. */
export function noteMuseAllowance(raw: unknown): void {
  const parsed = parseMuseAllowance(raw);
  if (!parsed) return;
  if (!parsed.tier && lastAllowance?.tier) parsed.tier = lastAllowance.tier;
  if (!lastAllowance || parsed.asOfMs >= lastAllowance.asOfMs) lastAllowance = parsed;
}

export function latestMuseAllowance(): MuseAllowance | null {
  return lastAllowance;
}
