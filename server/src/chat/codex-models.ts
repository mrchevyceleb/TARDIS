import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { engineDefault } from '../lib/engineConfig.ts';

export type CodexModelInfo = {
  id: string;
  label: string;
  defaultEffort: string;
  efforts: string[];
  contextWindow: number;
};

const STANDARD_CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const MAX_CODEX_EFFORTS = [...STANDARD_CODEX_EFFORTS, 'max'];

// The Codex CLI's own catalog (`codex debug models`, read at startup and every
// few hours) decides WHICH models exist for this login and which efforts they
// take, so a new model shows up by itself and one the login does not offer never
// does. This hand list is only the fallback when the CLI cannot be read, plus
// what the catalog does not carry: nicer labels and the context windows we
// measured. Default efforts come from the catalog.
const HAND_MODELS: CodexModelInfo[] = [
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', defaultEffort: 'low', efforts: [...MAX_CODEX_EFFORTS, 'ultra'], contextWindow: 272_000 },
  { id: 'gpt-6-astra', label: 'GPT-6-Astra', defaultEffort: 'medium', efforts: [...MAX_CODEX_EFFORTS, 'ultra'], contextWindow: 272_000 },
  { id: 'gpt-6-sol', label: 'GPT-6 Sol', defaultEffort: 'medium', efforts: [...MAX_CODEX_EFFORTS, 'ultra'], contextWindow: 272_000 },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna', defaultEffort: 'medium', efforts: MAX_CODEX_EFFORTS, contextWindow: 272_000 },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', defaultEffort: 'low', efforts: [...MAX_CODEX_EFFORTS, 'ultra'], contextWindow: 372_000 },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', defaultEffort: 'medium', efforts: MAX_CODEX_EFFORTS, contextWindow: 372_000 },
  { id: 'gpt-5.5', label: 'GPT-5.5', defaultEffort: 'medium', efforts: STANDARD_CODEX_EFFORTS, contextWindow: 272_000 },
  { id: 'gpt-5.3-codex', label: 'Codex 5.3', defaultEffort: 'high', efforts: STANDARD_CODEX_EFFORTS, contextWindow: 272_000 },
  { id: 'gpt-5.3-codex-spark', label: 'Spark 5.3', defaultEffort: 'high', efforts: STANDARD_CODEX_EFFORTS, contextWindow: 128_000 },
];
const HAND_BY_ID = new Map(HAND_MODELS.map((model) => [model.id, model]));

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EFFORT = /^[a-z]{2,12}$/;
const DEFAULT_CONTEXT_WINDOW = 272_000;
const REFRESH_MS = 4 * 60 * 60_000;

/** Which codex binary to run.
 *
 *  Do NOT rely on bare 'codex' resolving through PATH here. TARDIS is started
 *  by npm, which prepends every ancestor node_modules/.bin, so a stale
 *  @openai/codex in ~/node_modules shadows the real install and every turn fails
 *  with a 400 the transcript never shows. Prefer the standalone install, allow an
 *  explicit override, and only then fall back to PATH. */
export function resolveCodexBin(): string {
  const explicit = process.env.RIVENDELL_CODEX_BIN;
  if (explicit) return explicit;
  const standalone = join(homedir(), '.local', 'bin', 'codex');
  return existsSync(standalone) ? standalone : 'codex';
}

/** Turn the CLI's catalog JSON into the models this login lists, best first.
 *  Hidden entries (visibility other than "list") are never offered. */
export function parseCodexCatalog(raw: unknown): CodexModelInfo[] | null {
  const list = raw && typeof raw === 'object' ? (raw as { models?: unknown }).models : undefined;
  if (!Array.isArray(list)) return null;
  const rows: Array<CodexModelInfo & { priority: number }> = [];
  const seen = new Set<string>();
  list.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const item = entry as Record<string, unknown>;
    const id = item.slug;
    if (item.visibility !== 'list' || typeof id !== 'string' || !SLUG.test(id) || seen.has(id)) return;
    const efforts: string[] = [];
    if (Array.isArray(item.supported_reasoning_levels)) {
      for (const level of item.supported_reasoning_levels) {
        const effort = level && typeof level === 'object' ? (level as { effort?: unknown }).effort : undefined;
        if (typeof effort === 'string' && EFFORT.test(effort) && !efforts.includes(effort)) efforts.push(effort);
      }
    }
    if (!efforts.length) return;
    seen.add(id);
    const hand = HAND_BY_ID.get(id);
    const catalogDefault = typeof item.default_reasoning_level === 'string' && efforts.includes(item.default_reasoning_level)
      ? item.default_reasoning_level
      : efforts[0]!;
    const window = typeof item.context_window === 'number' && Number.isInteger(item.context_window) && item.context_window > 0
      ? item.context_window
      : DEFAULT_CONTEXT_WINDOW;
    const name = typeof item.display_name === 'string' ? item.display_name.trim().slice(0, 60) : '';
    rows.push({
      id,
      label: hand?.label ?? (name || id),
      defaultEffort: catalogDefault,
      efforts,
      contextWindow: hand?.contextWindow ?? window,
      priority: typeof item.priority === 'number' && Number.isFinite(item.priority) ? item.priority : 1000 + index,
    });
  });
  rows.sort((a, b) => a.priority - b.priority);
  return rows.length ? rows.map(({ priority: _priority, ...model }) => model) : null;
}

let catalog: { models: CodexModelInfo[]; fetchedAt: number } | null = null;
let cliVersions: { version: string | null; latest: string | null } = { version: null, latest: null };
let refreshTimer: NodeJS.Timeout | undefined;
let firstRead: Promise<void> | undefined;

function versionParts(value: string | null): number[] | null {
  const match = value ? /(\d+)\.(\d+)\.(\d+)/.exec(value) : null;
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** True when the installed CLI is behind the newest release. A CLI that is too
 *  old does not know the newer models, so its catalog can hide ones the account
 *  already offers. */
function cliIsOutdated(): boolean {
  const installed = versionParts(cliVersions.version);
  const latest = versionParts(cliVersions.latest);
  if (!installed || !latest) return false;
  for (let i = 0; i < 3; i++) {
    if (installed[i]! !== latest[i]!) return installed[i]! < latest[i]!;
  }
  return false;
}

function runText(bin: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (error, out) => {
      if (error) reject(error); else resolve(out);
    });
  });
}

/** Models this login offers: the CLI's catalog once read, the hand list until then. */
export function codexModelList(): CodexModelInfo[] {
  return catalog?.models ?? HAND_MODELS;
}

export function codexCapability(model: string): CodexModelInfo | undefined {
  return codexModelList().find((entry) => entry.id === model);
}

export function codexCatalogPayload(): {
  models: CodexModelInfo[];
  source: 'catalog' | 'fallback';
  fetchedAt: number | null;
  cli: { version: string | null; latest: string | null; outdated: boolean };
} {
  return {
    models: codexModelList(),
    source: catalog ? 'catalog' : 'fallback',
    fetchedAt: catalog?.fetchedAt ?? null,
    cli: { ...cliVersions, outdated: cliIsOutdated() },
  };
}

async function refreshCliVersions(bin: string): Promise<void> {
  const [installed, latest] = await Promise.allSettled([
    runText(bin, ['--version'], 10_000),
    fetch('https://registry.npmjs.org/@openai%2fcodex/latest', { signal: AbortSignal.timeout(8_000) })
      .then((response) => (response.ok ? response.json() as Promise<{ version?: unknown }> : null)),
  ]);
  const wasOutdated = cliIsOutdated();
  const installedParts = installed.status === 'fulfilled' ? versionParts(installed.value) : null;
  const latestVersion = latest.status === 'fulfilled' && typeof latest.value?.version === 'string' ? latest.value.version : null;
  cliVersions = {
    version: installedParts ? installedParts.join('.') : cliVersions.version,
    latest: versionParts(latestVersion) ? latestVersion : cliVersions.latest,
  };
  if (cliIsOutdated() && !wasOutdated) {
    console.warn(`[chat codex] Codex CLI ${cliVersions.version} is behind ${cliVersions.latest}: models this account offers may be hidden until the standalone install is updated.`);
  }
}

const RETRY_DELAYS_MS = [15_000, 60_000, 5 * 60_000];
let failures = 0;

async function refreshCodexCatalog(bin: string): Promise<void> {
  void refreshCliVersions(bin).catch(() => {});
  let retryIn: number | null = null;
  try {
    const stdout = await runText(bin, ['debug', 'models'], 20_000);
    const models = parseCodexCatalog(JSON.parse(stdout));
    if (!models) throw new Error('the catalog listed no models');
    const before = catalog?.models.map((model) => model.id).join(',');
    catalog = { models, fetchedAt: Date.now() };
    failures = 0;
    const after = models.map((model) => model.id).join(',');
    if (before !== after) console.log(`[chat codex] model catalog: ${after}`);
  } catch (error) {
    // Keep whatever we already had (the previous catalog, else the hand list),
    // and try again soon instead of waiting out the whole refresh interval.
    console.warn('[chat codex] model catalog refresh failed:', error instanceof Error ? error.message : error);
    retryIn = RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length - 1)]!;
    failures++;
  }
  if (retryIn !== null) setTimeout(() => void refreshCodexCatalog(bin), retryIn).unref();
}

/** Read the CLI's model catalog now and every few hours. Never throws. The
 *  returned promise settles once the first read is done, or after a few seconds,
 *  so startup can wait for it briefly and turns rarely see the fallback list. */
export function startCodexCatalog(bin = resolveCodexBin()): Promise<void> {
  if (!refreshTimer) {
    refreshTimer = setInterval(() => void refreshCodexCatalog(bin), REFRESH_MS);
    refreshTimer.unref();
    firstRead = refreshCodexCatalog(bin);
  }
  return Promise.race([firstRead ?? Promise.resolve(), new Promise<void>((resolve) => setTimeout(resolve, 4_000).unref())]);
}

function configuredCodexSelection(): { model: string; effort: string } {
  const configured = engineDefault('codex', 'gpt-5.6-sol', 'low');
  const capability = codexCapability(configured.model) ?? codexCapability('gpt-5.6-sol') ?? codexModelList()[0]!;
  return {
    model: capability.id,
    effort: capability.efforts.includes(configured.effort) ? configured.effort : capability.defaultEffort,
  };
}

/** Resolve browser-supplied values before they can reach Codex CLI arguments. */
export function resolveCodexSelection(
  requestedModel?: unknown,
  requestedEffort?: unknown,
): { model: string; effort: string } {
  const modelValue = typeof requestedModel === 'string' ? requestedModel : undefined;
  const effortValue = typeof requestedEffort === 'string' ? requestedEffort : undefined;
  const requestedCapability = modelValue ? codexCapability(modelValue) : undefined;
  const configured = configuredCodexSelection();
  const model = requestedCapability ? modelValue! : configured.model;
  const capability = codexCapability(model)!;
  const fallbackEffort = model === configured.model ? configured.effort : capability.defaultEffort;
  const invalidRequestedModel = requestedModel !== undefined && !requestedCapability;
  const effort = !invalidRequestedModel && effortValue && capability.efforts.includes(effortValue)
    ? effortValue
    : fallbackEffort;
  return { model, effort };
}
