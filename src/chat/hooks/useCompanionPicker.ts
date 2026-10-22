import { useCallback, useEffect, useState } from 'react';
import type { CompanionId } from '../data/types';
import {
  codexModelSpec,
  normalizeCodexEffort,
  normalizeCodexModel,
  readStoredCodexEffort,
  readStoredCodexModel,
  isCodexCatalogLoaded,
  useCodexCatalogVersion,
} from '../codexModels';
import { CLAUDE_EFFORTS, DEFAULT_CLAUDE_MODEL, normalizeClaudeModel } from '../components/CodexEnginePicker';
import {
  isFireworksCatalogLoaded,
  normalizeFireworksEffort,
  normalizeFireworksModel,
  readStoredFireworksEffort,
  readStoredFireworksModel,
  useFireworksCatalogVersion,
} from '../fireworksModels';
import {
  isOpenRouterCatalogLoaded,
  normalizeOpenRouterEffort,
  normalizeOpenRouterModel,
  readStoredOpenRouterEffort,
  readStoredOpenRouterModel,
  readStoredOpenRouter2Effort,
  readStoredOpenRouter2Model,
  useOpenRouterCatalogVersion,
} from '../openrouterModels';

// Companion + model/effort selection for an embedded chat (the Workspace room).
// The subscription engines share one flat list.
// Claude Code and Codex use their normal local CLI profiles unless the server
// operator explicitly configures an account map.
//
// Model/effort choices share localStorage keys with Hall so a model pick in one
// place carries to the other; only the companion choice is panel-scoped.

// One entry per picker lane. `id` is the (string) selection key; `cli` is the
// engine the server runs; `account`, when set by a custom integration, pins a
// named profile. Public defaults do not select a machine-specific account.
export const WORKSPACE_COMPANIONS: {
  id: string;
  cli: CompanionId;
  account?: RepoAccount;
  label: string;
}[] = [
  { id: 'claude', cli: 'claude', label: 'Claude Code' },
  { id: 'codex', cli: 'codex', label: 'Codex' },
  { id: 'xai', cli: 'xai', label: 'Grok' },
  { id: 'zai', cli: 'zai', label: 'GLM' },
  { id: 'fireworks', cli: 'fireworks', label: 'Fireworks' },
  { id: 'openrouter', cli: 'openrouter', label: 'OpenRouter' },
  { id: 'openrouter2', cli: 'openrouter2', label: 'Personal' },
  { id: 'agy', cli: 'agy', label: 'Gemini' },
];

// Optional named profile for custom/private picker extensions. Public entries
// intentionally leave this unset and use the CLI's normal local profile.
export type RepoAccount = string;

// Plain-words, one-line explanation of the ACTIVE lane's auth, shown under the
// picker so "which account is this?" is never a mystery.
export function companionAuthBlurb(cli: CompanionId, account: RepoAccount | null): string {
  const who = account ? 'the configured subscription login' : 'your local subscription login';
  switch (cli) {
    case 'assistant':      return `TARDIS on Claude Code, signed in as ${who}.`;
    case 'claude':         return `Claude Code, signed in as ${who}.`;
    case 'codex':           return `Codex, signed in as ${who}.`;
    case 'xai':              return 'Grok via your configured coding subscription.';
    case 'zai':              return 'GLM via your Z.ai coding plan.';
    case 'fireworks':        return 'Any serverless Fireworks model via your Fireworks API key.';
    case 'openrouter':       return 'Any tool-capable OpenRouter model via your OpenRouter API key.';
    case 'openrouter2':      return 'Any tool-capable OpenRouter model via PERSONAL_OPENROUTER_API_KEY.';
    case 'agy':               return 'Gemini via your Google AI subscription (Antigravity CLI login).';
    default:                 return '';
  }
}

function readLS(key: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}

/** Legacy stamps remain readable; new selections use subscription engines only.
 *  `fireworks` is the API-key provider lane (any serverless Fireworks model);
 *  the retired `banana-fireworks` engine maps onto it. `openrouter` and
 *  `openrouter2` are the same kind of lane for tool-capable OpenRouter models,
 *  backed by separate accounts. */
export function normalizeCompanion(engine: string | undefined): 'claude' | 'codex' | 'xai' | 'zai' | 'fireworks' | 'openrouter' | 'openrouter2' | 'agy' {
  if (engine === 'claude' || engine === 'assistant' || engine === 'claude-kim') return 'claude';
  if (engine === 'codex' || engine === 'codex-kim') return 'codex';
  if (engine === 'zai') return 'zai';
  if (engine === 'fireworks' || engine === 'banana-fireworks') return 'fireworks';
  if (engine === 'openrouter') return 'openrouter';
  if (engine === 'openrouter2') return 'openrouter2';
  if (engine === 'agy') return 'agy';
  return 'xai';
}

// Z.ai coding-plan models (Anthropic-compatible, run through the claude CLI).
// GLM 5.3 / 5.2 ids MUST carry the `[1m]` suffix to get the 1M context window;
// the bare ids serve the 200K variant and compact far too early.
export const DEFAULT_ZAI_MODEL = 'glm-5.3[1m]';
export const DEFAULT_ZAI_EFFORT = 'high';
export const ZAI_MODELS: { id: string; label: string }[] = [
  { id: DEFAULT_ZAI_MODEL, label: 'GLM 5.3' },
  { id: 'glm-5.3-flash[1m]', label: 'GLM 5.3 Flash' },
  { id: 'glm-5.2[1m]', label: 'GLM 5.2' },
  { id: 'glm-5.1', label: 'GLM 5.1' },
];
export const ZAI_EFFORTS = ['high', 'max'];

export function normalizeZaiModel(model: string): string {
  const normalized =
    model === 'glm-5.3' ? DEFAULT_ZAI_MODEL
    : model === 'glm-5.3-flash' ? 'glm-5.3-flash[1m]'
    : model === 'glm-5.2' ? 'glm-5.2[1m]'
    : model;
  return ZAI_MODELS.some((entry) => entry.id === normalized) ? normalized : DEFAULT_ZAI_MODEL;
}

export function normalizeZaiEffort(effort: string): string {
  return ZAI_EFFORTS.includes(effort) ? effort : DEFAULT_ZAI_EFFORT;
}

export function readStoredZaiModel(): string {
  if (typeof window === 'undefined') return DEFAULT_ZAI_MODEL;
  const raw = localStorage.getItem('rivendell:zai-model') || DEFAULT_ZAI_MODEL;
  const model = normalizeZaiModel(raw);
  if (model !== raw) localStorage.setItem('rivendell:zai-model', model);
  return model;
}

export function readStoredZaiEffort(): string {
  if (typeof window === 'undefined') return DEFAULT_ZAI_EFFORT;
  const raw = localStorage.getItem('rivendell:zai-effort') || DEFAULT_ZAI_EFFORT;
  const effort = normalizeZaiEffort(raw);
  if (effort !== raw) localStorage.setItem('rivendell:zai-effort', effort);
  return effort;
}

// xAI coding-plan models (Anthropic-compatible, run through the claude CLI
// redirected to https://api.x.ai). Grok 4.7 (500K context, May 2026 cutoff)
// is the current coding-plan model; 4.6 and 4.5 stay selectable.
export const DEFAULT_XAI_MODEL = 'grok-4.7';
// Grok's top real tier. xAI's 4.6/4.7 accept minimal|low|medium|high|xhigh
// and reject `max` (verified 2026-09-21); `max` used to be offered here and
// was silently clamped. Stored `max` migrates to xhigh below.
export const DEFAULT_XAI_EFFORT = 'xhigh';
export const XAI_MODELS: { id: string; label: string }[] = [
  { id: 'grok-4.7', label: 'Grok 4.7' },
  { id: 'grok-4.6', label: 'Grok 4.6' },
  { id: 'grok-4.5', label: 'Grok 4.5' },
];
// xAI's Anthropic endpoint accepts Claude Code's complete effort range and
// maps it onto Grok's thinking budget. Keep every selectable tier visible;
// collapsing this to High/Max made Low, Medium, and XHigh unreachable even
// though the server already validates and forwards them.
export const XAI_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];

export function normalizeXaiModel(model: string): string {
  return XAI_MODELS.some((entry) => entry.id === model) ? model : DEFAULT_XAI_MODEL;
}

export function normalizeXaiEffort(effort: string): string {
  if (effort === 'max') return 'xhigh';
  return XAI_EFFORTS.includes(effort) ? effort : DEFAULT_XAI_EFFORT;
}

export function readStoredXaiModel(): string {
  if (typeof window === 'undefined') return DEFAULT_XAI_MODEL;
  // One-time bump: anyone still on an older default (4.5 or 4.6) moves to
  // 4.7. Both stay in the picker if someone re-selects them afterwards.
  let raw = localStorage.getItem('rivendell:xai-model') || DEFAULT_XAI_MODEL;
  if (raw === 'grok-4.5' || raw === 'grok-4.6') {
    raw = DEFAULT_XAI_MODEL;
    localStorage.setItem('rivendell:xai-model', raw);
  }
  const model = normalizeXaiModel(raw);
  if (model !== raw) localStorage.setItem('rivendell:xai-model', model);
  return model;
}

export function readStoredXaiEffort(): string {
  if (typeof window === 'undefined') return DEFAULT_XAI_EFFORT;
  const raw = localStorage.getItem('rivendell:xai-effort') || DEFAULT_XAI_EFFORT;
  const effort = normalizeXaiEffort(raw);
  if (effort !== raw) localStorage.setItem('rivendell:xai-effort', effort);
  return effort;
}

// Gemini on Matt's Google subscription (the agy CLI lane). Two base models,
// each taking low/medium/high as the lane's effort value; the server resolves
// the pair into the agy binary's --model/--effort spawn args.
export const DEFAULT_AGY_MODEL = 'gemini-4-argon';
export const DEFAULT_AGY_EFFORT = 'medium';
export const AGY_MODELS: { id: string; label: string }[] = [
  { id: 'gemini-4-argon', label: 'Gemini 4 Argon' },
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
];
export const AGY_EFFORTS = ['low', 'medium', 'high'];

export function normalizeAgyModel(model: string): string {
  return AGY_MODELS.some((entry) => entry.id === model) ? model : DEFAULT_AGY_MODEL;
}

export function normalizeAgyEffort(effort: string): string {
  return AGY_EFFORTS.includes(effort) ? effort : DEFAULT_AGY_EFFORT;
}

export function readStoredAgyModel(): string {
  if (typeof window === 'undefined') return DEFAULT_AGY_MODEL;
  const raw = localStorage.getItem('rivendell:agy-model') || DEFAULT_AGY_MODEL;
  const model = normalizeAgyModel(raw);
  if (model !== raw) localStorage.setItem('rivendell:agy-model', model);
  return model;
}

export function readStoredAgyEffort(): string {
  if (typeof window === 'undefined') return DEFAULT_AGY_EFFORT;
  const raw = localStorage.getItem('rivendell:agy-effort') || DEFAULT_AGY_EFFORT;
  const effort = normalizeAgyEffort(raw);
  if (effort !== raw) localStorage.setItem('rivendell:agy-effort', effort);
  return effort;
}

function normalizeClaudeEffort(value?: string): string {
  return value && CLAUDE_EFFORTS.includes(value) ? value : 'xhigh';
}

export type CompanionPicker = ReturnType<typeof useCompanionPicker>;

export function useCompanionPicker(storageKey: string) {
  const [companion, setCompanionState] = useState<string>(() => {
    // Retired providers migrate to Grok; legacy Claude/Codex aliases retain
    // their subscription family without changing the durable conversation id.
    const stored = readLS(storageKey, 'xai');
    const raw = normalizeCompanion(stored);
    if (raw !== stored && typeof window !== 'undefined') localStorage.setItem(storageKey, raw);
    return raw;
  });
  const setCompanion = (value: string) => {
    const c = normalizeCompanion(value);
    setCompanionState(c);
    if (typeof window !== 'undefined') localStorage.setItem(storageKey, c);
  };
  // Resolve the selected lane to its engine + optional explicitly pinned account.
  const entry = WORKSPACE_COMPANIONS.find((c) => c.id === companion) ?? WORKSPACE_COMPANIONS[0];
  const account = entry.account ?? null;

  const [claudeModel, setClaudeModelState] = useState(() => normalizeClaudeModel(readLS('rivendell:claude-model', DEFAULT_CLAUDE_MODEL)));
  const [claudeEffort, setClaudeEffortState] = useState(() => normalizeClaudeEffort(readLS('rivendell:claude-effort', 'xhigh')));
  const [codexModel, setCodexModelState] = useState(readStoredCodexModel);
  const [codexEffort, setCodexEffortState] = useState(() => readStoredCodexEffort(codexModel));
  // When the CLI's catalog lands, a stored model it does not offer gives way to
  // one it does (and an effort the model lacks to its default).
  const codexCatalogVersion = useCodexCatalogVersion();
  useEffect(() => {
    if (!isCodexCatalogLoaded()) return;
    const model = normalizeCodexModel(codexModel);
    // A replaced model starts on its own default effort; the old effort belonged
    // to the model that is gone.
    const effort = model === codexModel ? normalizeCodexEffort(model, codexEffort) : codexModelSpec(model).defaultEffort;
    if (model === codexModel && effort === codexEffort) return;
    setCodexModelState(model);
    setCodexEffortState(effort);
    if (typeof window !== 'undefined') {
      localStorage.setItem('rivendell:codex-model', model);
      localStorage.setItem('rivendell:codex-effort', effort);
    }
  }, [codexCatalogVersion]);
  const [xaiModel, setXaiModelState] = useState(readStoredXaiModel);
  const [xaiEffort, setXaiEffortState] = useState(readStoredXaiEffort);
  const [zaiModel, setZaiModelState] = useState(readStoredZaiModel);
  const [zaiEffort, setZaiEffortState] = useState(readStoredZaiEffort);
  const [agyModel, setAgyModelState] = useState(readStoredAgyModel);
  const [agyEffort, setAgyEffortState] = useState(readStoredAgyEffort);
  const [fireworksModel, setFireworksModelState] = useState(readStoredFireworksModel);
  const [fireworksEffort, setFireworksEffortState] = useState(readStoredFireworksEffort);
  // Mirror the Codex reconciliation: when the live catalog lands, a stored
  // model it no longer offers gives way to one it does, and a stale effort
  // falls to the replacement's tiers. Without this, a removed pin renders a
  // blank selector and keeps being sent to the server.
  const fireworksCatalogVersion = useFireworksCatalogVersion();
  useEffect(() => {
    if (!isFireworksCatalogLoaded()) return;
    const model = normalizeFireworksModel(fireworksModel);
    // A replaced model starts on its own default effort; the old effort
    // belonged to the model that is gone.
    const effort = model === fireworksModel
      ? normalizeFireworksEffort(model, fireworksEffort)
      : normalizeFireworksEffort(model, undefined);
    if (model === fireworksModel && effort === fireworksEffort) return;
    setFireworksModelState(model);
    setFireworksEffortState(effort);
    if (typeof window !== 'undefined') {
      localStorage.setItem('rivendell:fireworks-model', model);
      localStorage.setItem('rivendell:fireworks-effort', effort);
    }
  }, [fireworksCatalogVersion]);
  const [openRouterModel, setOpenRouterModelState] = useState(readStoredOpenRouterModel);
  const [openRouterEffort, setOpenRouterEffortState] = useState(readStoredOpenRouterEffort);
  const [openRouter2Model, setOpenRouter2ModelState] = useState(readStoredOpenRouter2Model);
  const [openRouter2Effort, setOpenRouter2EffortState] = useState(readStoredOpenRouter2Effort);
  // Same reconciliation as Fireworks when OpenRouter's live catalog lands.
  const openRouterCatalogVersion = useOpenRouterCatalogVersion();
  useEffect(() => {
    if (!isOpenRouterCatalogLoaded()) return;
    const model = normalizeOpenRouterModel(openRouterModel);
    const effort = model === openRouterModel
      ? normalizeOpenRouterEffort(model, openRouterEffort)
      : normalizeOpenRouterEffort(model, undefined);
    if (model === openRouterModel && effort === openRouterEffort) return;
    setOpenRouterModelState(model);
    setOpenRouterEffortState(effort);
    if (typeof window !== 'undefined') {
      localStorage.setItem('rivendell:openrouter-model', model);
      localStorage.setItem('rivendell:openrouter-effort', effort);
    }
  }, [openRouterCatalogVersion]);
  // Process-local, intentionally not persisted. A new device starts at zero,
  // while every actual picker click advances only that lane's revision—even if
  // the clicked value matches what that device already displayed.
  useEffect(() => {
    if (!isOpenRouterCatalogLoaded()) return;
    const model = normalizeOpenRouterModel(openRouter2Model);
    const effort = model === openRouter2Model
      ? normalizeOpenRouterEffort(model, openRouter2Effort)
      : normalizeOpenRouterEffort(model, undefined);
    if (model === openRouter2Model && effort === openRouter2Effort) return;
    setOpenRouter2ModelState(model);
    setOpenRouter2EffortState(effort);
    if (typeof window !== 'undefined') {
      localStorage.setItem('rivendell:openrouter2-model', model);
      localStorage.setItem('rivendell:openrouter2-effort', effort);
    }
  }, [openRouterCatalogVersion]);
  const [selectionRevisions, setSelectionRevisions] = useState<Record<string, number>>({});
  const markSelectionChanged = (lane: string) => {
    setSelectionRevisions((revisions) => ({
      ...revisions,
      [lane]: (revisions[lane] ?? 0) + 1,
    }));
  };

  const persist = (key: string, set: (v: string) => void, lane?: string) => (v: string) => {
    if (lane) markSelectionChanged(lane);
    set(v);
    if (typeof window !== 'undefined') localStorage.setItem(key, v);
  };
  const setClaudeModel = (value: string) => {
    markSelectionChanged('claude');
    const model = normalizeClaudeModel(value);
    setClaudeModelState(model);
    if (typeof window !== 'undefined') localStorage.setItem('rivendell:claude-model', model);
  };
  const setClaudeEffort = (value: string) => persist('rivendell:claude-effort', setClaudeEffortState, 'claude')(normalizeClaudeEffort(value));
  const setCodexModel = (value: string) => {
    const model = normalizeCodexModel(value);
    const effort = normalizeCodexEffort(model, codexEffort);
    setCodexModelState(model);
    setCodexEffortState(effort);
    if (typeof window !== 'undefined') {
      localStorage.setItem('rivendell:codex-model', model);
      localStorage.setItem('rivendell:codex-effort', effort);
    }
  };
  const setCodexEffort = (value: string) => {
    const effort = normalizeCodexEffort(codexModel, value);
    setCodexEffortState(effort);
    if (typeof window !== 'undefined') {
      localStorage.setItem('rivendell:codex-effort', effort);
    }
  };
  const setXaiModel = (v: string) => {
    markSelectionChanged('xai');
    const model = normalizeXaiModel(v);
    setXaiModelState(model);
    if (typeof window !== 'undefined') localStorage.setItem('rivendell:xai-model', model);
  };
  const setXaiEffort = (v: string) => {
    markSelectionChanged('xai');
    const effort = normalizeXaiEffort(v);
    setXaiEffortState(effort);
    if (typeof window !== 'undefined') localStorage.setItem('rivendell:xai-effort', effort);
  };
  const setZaiModel = (v: string) => {
    markSelectionChanged('zai');
    const model = normalizeZaiModel(v);
    setZaiModelState(model);
    if (typeof window !== 'undefined') localStorage.setItem('rivendell:zai-model', model);
  };
  const setZaiEffort = (v: string) => {
    markSelectionChanged('zai');
    const effort = normalizeZaiEffort(v);
    setZaiEffortState(effort);
    if (typeof window !== 'undefined') localStorage.setItem('rivendell:zai-effort', effort);
  };
  const setAgyModel = (v: string) => {
    markSelectionChanged('agy');
    const model = normalizeAgyModel(v);
    setAgyModelState(model);
    if (typeof window !== 'undefined') localStorage.setItem('rivendell:agy-model', model);
  };
  const setAgyEffort = (v: string) => {
    markSelectionChanged('agy');
    const effort = normalizeAgyEffort(v);
    setAgyEffortState(effort);
    if (typeof window !== 'undefined') localStorage.setItem('rivendell:agy-effort', effort);
  };
  const setFireworksModel = (v: string) => {
    markSelectionChanged('fireworks');
    const model = normalizeFireworksModel(v);
    setFireworksModelState(model);
    // A model change re-derives the effort from the new model's tiers.
    const effort = normalizeFireworksEffort(model, fireworksEffort);
    setFireworksEffortState(effort);
    if (typeof window !== 'undefined') {
      localStorage.setItem('rivendell:fireworks-model', model);
      localStorage.setItem('rivendell:fireworks-effort', effort);
    }
  };
  const setFireworksEffort = (v: string) => {
    markSelectionChanged('fireworks');
    const effort = normalizeFireworksEffort(fireworksModel, v);
    setFireworksEffortState(effort);
    if (typeof window !== 'undefined') localStorage.setItem('rivendell:fireworks-effort', effort);
  };
  const setOpenRouterModel = (v: string) => {
    markSelectionChanged('openrouter');
    const model = normalizeOpenRouterModel(v);
    setOpenRouterModelState(model);
    const effort = normalizeOpenRouterEffort(model, openRouterEffort);
    setOpenRouterEffortState(effort);
    if (typeof window !== 'undefined') {
      localStorage.setItem('rivendell:openrouter-model', model);
      localStorage.setItem('rivendell:openrouter-effort', effort);
    }
  };
  const setOpenRouterEffort = (v: string) => {
    markSelectionChanged('openrouter');
    const effort = normalizeOpenRouterEffort(openRouterModel, v);
    setOpenRouterEffortState(effort);
    if (typeof window !== 'undefined') localStorage.setItem('rivendell:openrouter-effort', effort);
  };
  const setOpenRouter2Model = (v: string) => {
    markSelectionChanged('openrouter2');
    const model = normalizeOpenRouterModel(v);
    setOpenRouter2ModelState(model);
    const effort = normalizeOpenRouterEffort(model, openRouter2Effort);
    setOpenRouter2EffortState(effort);
    if (typeof window !== 'undefined') {
      localStorage.setItem('rivendell:openrouter2-model', model);
      localStorage.setItem('rivendell:openrouter2-effort', effort);
    }
  };
  const setOpenRouter2Effort = (v: string) => {
    markSelectionChanged('openrouter2');
    const effort = normalizeOpenRouterEffort(openRouter2Model, v);
    setOpenRouter2EffortState(effort);
    if (typeof window !== 'undefined') localStorage.setItem('rivendell:openrouter2-effort', effort);
  };

  /** Apply the server-owned brain without marking it as a device-local picker
   * action. Used by agent chats so cross-device updates converge without
   * remounting the conversation or erasing a draft. */
  const applyAuthoritativeBrain = useCallback((engine: string, model?: string, effort?: string) => {
    const lane = normalizeCompanion(engine);
    if (lane !== engine && engine !== 'assistant') { model = undefined; effort = undefined; }
    setCompanionState(lane);
    if (typeof window !== 'undefined') localStorage.setItem(storageKey, lane);

    if (lane === 'claude') {
      const nextModel = normalizeClaudeModel(model);
      setClaudeModelState(nextModel);
      const nextEffort = normalizeClaudeEffort(effort);
      setClaudeEffortState(nextEffort);
      if (typeof window !== 'undefined') {
        localStorage.setItem('rivendell:claude-model', nextModel);
        localStorage.setItem('rivendell:claude-effort', nextEffort);
      }
    } else if (lane === 'codex') {
      const nextModel = normalizeCodexModel(model ?? '');
      const nextEffort = normalizeCodexEffort(nextModel, effort ?? '');
      setCodexModelState(nextModel);
      setCodexEffortState(nextEffort);
      if (typeof window !== 'undefined') {
        localStorage.setItem('rivendell:codex-model', nextModel);
        localStorage.setItem('rivendell:codex-effort', nextEffort);
      }
    } else if (lane === 'xai') {
      const nextModel = normalizeXaiModel(model ?? '');
      const nextEffort = normalizeXaiEffort(effort ?? '');
      setXaiModelState(nextModel);
      setXaiEffortState(nextEffort);
      if (typeof window !== 'undefined') {
        localStorage.setItem('rivendell:xai-model', nextModel);
        localStorage.setItem('rivendell:xai-effort', nextEffort);
      }
    } else if (lane === 'zai') {
      const nextModel = normalizeZaiModel(model ?? '');
      const nextEffort = normalizeZaiEffort(effort ?? '');
      setZaiModelState(nextModel);
      setZaiEffortState(nextEffort);
      if (typeof window !== 'undefined') {
        localStorage.setItem('rivendell:zai-model', nextModel);
        localStorage.setItem('rivendell:zai-effort', nextEffort);
      }
    } else if (lane === 'agy') {
      const nextModel = normalizeAgyModel(model ?? '');
      const nextEffort = normalizeAgyEffort(effort ?? '');
      setAgyModelState(nextModel);
      setAgyEffortState(nextEffort);
      if (typeof window !== 'undefined') {
        localStorage.setItem('rivendell:agy-model', nextModel);
        localStorage.setItem('rivendell:agy-effort', nextEffort);
      }
    } else if (lane === 'fireworks') {
      const nextModel = normalizeFireworksModel(model ?? '');
      const nextEffort = normalizeFireworksEffort(nextModel, effort ?? '');
      setFireworksModelState(nextModel);
      setFireworksEffortState(nextEffort);
      if (typeof window !== 'undefined') {
        localStorage.setItem('rivendell:fireworks-model', nextModel);
        localStorage.setItem('rivendell:fireworks-effort', nextEffort);
      }
    } else if (lane === 'openrouter') {
      const nextModel = normalizeOpenRouterModel(model ?? '');
      const nextEffort = normalizeOpenRouterEffort(nextModel, effort ?? '');
      setOpenRouterModelState(nextModel);
      setOpenRouterEffortState(nextEffort);
      if (typeof window !== 'undefined') {
        localStorage.setItem('rivendell:openrouter-model', nextModel);
        localStorage.setItem('rivendell:openrouter-effort', nextEffort);
      }
    } else if (lane === 'openrouter2') {
      const nextModel = normalizeOpenRouterModel(model ?? '');
      const nextEffort = normalizeOpenRouterEffort(nextModel, effort ?? '');
      setOpenRouter2ModelState(nextModel);
      setOpenRouter2EffortState(nextEffort);
      if (typeof window !== 'undefined') {
        localStorage.setItem('rivendell:openrouter2-model', nextModel);
        localStorage.setItem('rivendell:openrouter2-effort', nextEffort);
      }
    }
  }, [storageKey]);

  const cli = entry.cli;
  const isClaude = cli === 'assistant' || cli === 'claude';
  const isCodex = cli === 'codex';
  const isXai = cli === 'xai';
  const isZai = cli === 'zai';
  const isFireworks = cli === 'fireworks';
  const isOpenRouter = cli === 'openrouter';
  const isOpenRouter2 = cli === 'openrouter2';
  const isAgy = cli === 'agy';
  const model = isZai ? zaiModel : isFireworks ? fireworksModel : isOpenRouter2 ? openRouter2Model : isOpenRouter ? openRouterModel : isAgy ? agyModel : isXai ? xaiModel : isCodex ? codexModel : claudeModel;
  const effort = isZai ? zaiEffort : isFireworks ? fireworksEffort : isOpenRouter2 ? openRouter2Effort : isOpenRouter ? openRouterEffort : isAgy ? agyEffort : isXai ? xaiEffort : isCodex ? codexEffort : claudeEffort;

  return {
    companion, setCompanion, applyAuthoritativeBrain,
    cli, account, model, effort, selectionRevision: selectionRevisions[companion] ?? 0,
    brainPending: false,
    isClaude, isCodex, isXai, isZai, isFireworks, isOpenRouter, isOpenRouter2, isAgy,
    claudeModel, setClaudeModel, claudeEffort, setClaudeEffort,
    codexModel, setCodexModel, codexEffort, setCodexEffort,
    xaiModel, setXaiModel, xaiEffort, setXaiEffort,
    zaiModel, setZaiModel, zaiEffort, setZaiEffort,
    agyModel, setAgyModel, agyEffort, setAgyEffort,
    fireworksModel, setFireworksModel, fireworksEffort, setFireworksEffort,
    openRouterModel, setOpenRouterModel, openRouterEffort, setOpenRouterEffort,
    openRouter2Model, setOpenRouter2Model, openRouter2Effort, setOpenRouter2Effort,
  };
}
