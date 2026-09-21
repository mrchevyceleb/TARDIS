import { useCallback, useState } from 'react';
import type { CompanionId } from '../data/types';
import {
  normalizeCodexEffort,
  normalizeCodexModel,
  readStoredCodexEffort,
  readStoredCodexModel,
} from '../codexModels';
import { CLAUDE_EFFORTS, DEFAULT_CLAUDE_MODEL, normalizeClaudeModel } from '../components/CodexEnginePicker';

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
    default:                 return '';
  }
}

function readLS(key: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}

/** Legacy stamps remain readable; new selections use subscription engines only. */
export function normalizeCompanion(engine: string | undefined): 'claude' | 'codex' | 'xai' | 'zai' {
  if (engine === 'claude' || engine === 'assistant' || engine === 'claude-kim') return 'claude';
  if (engine === 'codex' || engine === 'codex-kim') return 'codex';
  if (engine === 'zai') return 'zai';
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
// redirected to https://api.x.ai). Grok 4.6 is the current coding-plan model.
export const DEFAULT_XAI_MODEL = 'grok-4.6';
// Grok's top thinking budget. TARDIS defaults the whole picker to xAI Grok
// 4.6 at max thinking, so this is the out-of-the-box reasoning level too.
export const DEFAULT_XAI_EFFORT = 'max';
export const XAI_MODELS: { id: string; label: string }[] = [
  { id: 'grok-4.6', label: 'Grok 4.6' },
  { id: 'grok-4.5', label: 'Grok 4.5' },
];
// xAI's Anthropic endpoint accepts Claude Code's complete effort range and
// maps it onto Grok's thinking budget. Keep every selectable tier visible;
// collapsing this to High/Max made Low, Medium, and XHigh unreachable even
// though the server already validates and forwards them.
export const XAI_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export function normalizeXaiModel(model: string): string {
  return XAI_MODELS.some((entry) => entry.id === model) ? model : DEFAULT_XAI_MODEL;
}

export function normalizeXaiEffort(effort: string): string {
  return XAI_EFFORTS.includes(effort) ? effort : DEFAULT_XAI_EFFORT;
}

export function readStoredXaiModel(): string {
  if (typeof window === 'undefined') return DEFAULT_XAI_MODEL;
  // One-time bump: everyone who was on the old default (4.5) moves to 4.6.
  // 4.5 stays in the picker if someone re-selects it after this migration.
  let raw = localStorage.getItem('rivendell:xai-model') || DEFAULT_XAI_MODEL;
  if (raw === 'grok-4.5') {
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
  const [xaiModel, setXaiModelState] = useState(readStoredXaiModel);
  const [xaiEffort, setXaiEffortState] = useState(readStoredXaiEffort);
  const [zaiModel, setZaiModelState] = useState(readStoredZaiModel);
  const [zaiEffort, setZaiEffortState] = useState(readStoredZaiEffort);
  // Process-local, intentionally not persisted. A new device starts at zero,
  // while every actual picker click advances only that lane's revision—even if
  // the clicked value matches what that device already displayed.
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
    }
  }, [storageKey]);

  const cli = entry.cli;
  const isClaude = cli === 'assistant' || cli === 'claude';
  const isCodex = cli === 'codex';
  const isXai = cli === 'xai';
  const isZai = cli === 'zai';
  const model = isZai ? zaiModel : isXai ? xaiModel : isCodex ? codexModel : claudeModel;
  const effort = isZai ? zaiEffort : isXai ? xaiEffort : isCodex ? codexEffort : claudeEffort;

  return {
    companion, setCompanion, applyAuthoritativeBrain,
    cli, account, model, effort, selectionRevision: selectionRevisions[companion] ?? 0,
    brainPending: false,
    isClaude, isCodex, isXai, isZai,
    claudeModel, setClaudeModel, claudeEffort, setClaudeEffort,
    codexModel, setCodexModel, codexEffort, setCodexEffort,
    xaiModel, setXaiModel, xaiEffort, setXaiEffort,
    zaiModel, setZaiModel, zaiEffort, setZaiEffort,
  };
}
