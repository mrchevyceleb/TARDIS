// Choose a companion — the reimagined companion + model + effort picker
// (§3.10). Reskins CompanionControls.tsx into a single "model chip" that opens
// either a desktop popover ("Counsel of the house") or a mobile bottom sheet
// ("The Counsel"). Browsing another provider is local to this open picker;
// only its explicit Use action persists an engine change.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CompanionPicker } from '../../hooks/useCompanionPicker';
import {
  AGY_EFFORTS,
  AGY_MODELS,
  WORKSPACE_COMPANIONS,
  XAI_MODELS,
  XAI_EFFORTS,
  ZAI_MODELS,
  ZAI_EFFORTS,
  companionAuthBlurb,
} from '../../hooks/useCompanionPicker';
import { CLAUDE_MODELS, CLAUDE_EFFORTS } from '../CodexEnginePicker';
import { codexModelLabel, codexModelChange, isCodexModelUnlisted, codexEffortsForModel, useCodexModels } from '../../codexModels';
import { FIREWORKS_MODELS, fireworksEffortsForModel, normalizeFireworksEffort, useFireworksModels } from '../../fireworksModels';
import { OPENROUTER_MODELS, openRouterEffortsForModel, normalizeOpenRouterEffort, useOpenRouterModels, type OpenRouterModelSpec } from '../../openrouterModels';
import { StarSigil } from './icons';
import { AccountControl, type AccountControlProps } from '../../../grok/AccountControl';

type AccountContext = Omit<AccountControlProps, 'engine'>;

type LaneMeta = { ring: string; short: string; word: string };

const LANE_META: Record<string, LaneMeta> = {
  claude: { ring: 'C', short: 'Claude Code subscription', word: 'effort' },
  codex: { ring: 'X', short: 'Codex subscription', word: 'effort' },
  xai: { ring: 'G', short: 'Grok coding subscription', word: 'thinking' },
  zai: { ring: 'Z', short: 'Z.ai coding plan', word: 'effort' },
  fireworks: { ring: 'F', short: 'Fireworks API models', word: 'thinking' },
  openrouter: { ring: 'O', short: 'OpenRouter API models', word: 'thinking' },
  openrouter2: { ring: 'P', short: 'Personal OpenRouter API models', word: 'thinking' },
  // 'G' is taken by Grok; Gemini takes the M of GeMini.
  agy: { ring: 'M', short: 'Google AI subscription', word: 'thinking' },
};

function labelFor(id: string, list: Array<{ id: string; label: string }>): string {
  return list.find((m) => m.id === id)?.label ?? id;
}

// Resolve the active lane to the chip's display values (ring, model label,
// effort label, auth blurb).
export function counselChipInfo(picker: CompanionPicker) {
  const meta = LANE_META[picker.companion] ?? { ring: '•', short: '', word: 'effort' };
  let name = picker.companion;
  const effort = picker.effort ?? '';
  if (picker.isClaude) name = labelFor(picker.claudeModel, CLAUDE_MODELS);
  else if (picker.isCodex) name = codexModelLabel(picker.codexModel);
  else if (picker.isXai) name = labelFor(picker.xaiModel, XAI_MODELS);
  else if (picker.isZai) name = labelFor(picker.zaiModel, ZAI_MODELS);
  else if (picker.isFireworks) name = labelFor(picker.fireworksModel, FIREWORKS_MODELS);
  else if (picker.isOpenRouter2) name = labelFor(picker.openRouter2Model, OPENROUTER_MODELS);
  else if (picker.isOpenRouter) name = labelFor(picker.openRouterModel, OPENROUTER_MODELS);
  else if (picker.isAgy) name = labelFor(picker.agyModel, AGY_MODELS);
  const lane = WORKSPACE_COMPANIONS.find((c) => c.id === picker.companion);
  const blurb = companionAuthBlurb(picker.cli, picker.account);
  return { ring: meta.ring, name, effort, word: meta.word, short: meta.short, blurb, laneLabel: lane?.label ?? name };
}

// ── model chip (composer row + sidebar footer) ────────────────────────────
export function ModelChip({
  picker,
  onClick,
  ariaLabel,
}: {
  picker: CompanionPicker;
  onClick: () => void;
  ariaLabel?: string;
}) {
  const { ring, name, effort } = counselChipInfo(picker);
  return (
    <button
      type="button"
      className={`model-chip${picker.brainPending ? ' pending' : ''}`}
      onClick={onClick}
      aria-label={ariaLabel ?? `Choose companion and model${picker.brainPending ? '; change applies after the active turn' : ''}`}
      title={picker.brainPending ? 'This brain is saved globally and will take over after the active turn.' : undefined}
    >
      <span className="ring">{ring}</span>
      <span>{name}</span>
      <span className="eff">· {effort}{picker.brainPending ? ' · pending' : ''}</span>
    </button>
  );
}

// ── effort pills for a lane ────────────────────────────────────────────────
function EffortPills({
  options,
  current,
  onPick,
}: {
  options: string[];
  current: string;
  onPick: (v: string) => void;
}) {
  return (
    <>
      {(options.includes(current) ? options : [...options, current]).map((v) => (
        <button
          key={v}
          type="button"
          className={`mini${current === v ? ' on' : ''}`}
          onClick={() => onPick(v)}
        >
          {v}
        </button>
      ))}
    </>
  );
}

// ── the expandable lane list (shared by popover + sheet) ───────────────────
type LaneChoice = { model: string; effort: string };

function choiceModelLabel(lane: string, model: string): string {
  if (lane === 'codex') return codexModelLabel(model);
  const models = lane === 'claude' ? CLAUDE_MODELS : lane === 'xai' ? XAI_MODELS
    : lane === 'zai' ? ZAI_MODELS : lane === 'agy' ? AGY_MODELS
    : lane === 'fireworks' ? FIREWORKS_MODELS : OPENROUTER_MODELS;
  return labelFor(model, models);
}

function LaneList({ picker, accountContext, rejectedCodexModel }: { picker: CompanionPicker; accountContext?: AccountContext; rejectedCodexModel?: string }) {
  const [expanded, setExpanded] = useState(picker.companion);
  const [draft, setDraft] = useState<LaneChoice | null>(null);
  const [switchSaving, setSwitchSaving] = useState(false);
  const saving = switchSaving || picker.engineSwitchSaving;
  const [error, setError] = useState('');
  const [draftNotice, setDraftNotice] = useState<string | null>(null);
  const laneButtons = useRef<Record<string, HTMLButtonElement | null>>({});
  const focusAfterSwitch = useRef<string | null>(null);
  useEffect(() => {
    if (saving || !focusAfterSwitch.current) return;
    const button = laneButtons.current[focusAfterSwitch.current];
    focusAfterSwitch.current = null;
    button?.focus();
  }, [saving, picker.companion]);
  // A confirmed switch (including another device's) follows the saved engine.
  useEffect(() => { setExpanded(picker.companion); setDraft(null); }, [picker.companion]);
  const choices: Record<string, LaneChoice & { onModel: (v: string) => void; onEffort: (v: string) => void }> = {
    claude: { model: picker.claudeModel, effort: picker.claudeEffort, onModel: picker.setClaudeModel, onEffort: picker.setClaudeEffort },
    codex: { model: picker.codexModel, effort: picker.codexEffort, onModel: picker.setCodexModel, onEffort: picker.setCodexEffort },
    xai: { model: picker.xaiModel, effort: picker.xaiEffort, onModel: picker.setXaiModel, onEffort: picker.setXaiEffort },
    zai: { model: picker.zaiModel, effort: picker.zaiEffort, onModel: picker.setZaiModel, onEffort: picker.setZaiEffort },
    fireworks: { model: picker.fireworksModel, effort: picker.fireworksEffort, onModel: picker.setFireworksModel, onEffort: picker.setFireworksEffort },
    openrouter: { model: picker.openRouterModel, effort: picker.openRouterEffort, onModel: picker.setOpenRouterModel, onEffort: picker.setOpenRouterEffort },
    openrouter2: { model: picker.openRouter2Model, effort: picker.openRouter2Effort, onModel: picker.setOpenRouter2Model, onEffort: picker.setOpenRouter2Effort },
    agy: { model: picker.agyModel, effort: picker.agyEffort, onModel: picker.setAgyModel, onEffort: picker.setAgyEffort },
  };
  return (
    <>
      {WORKSPACE_COMPANIONS.map((lane) => {
        const meta = LANE_META[lane.id] ?? { ring: '•', short: '', word: 'effort' };
        const on = picker.companion === lane.id;
        const open = expanded === lane.id;
        const saved = choices[lane.id];
        const choice = open && !on && draft ? draft : saved;
        const pickModel = (model: string) => {
          if (on) { saved.onModel(model); return; }
          const codex = lane.id === 'codex' ? codexModelChange(model, choice.effort) : null;
          const effort = codex ? codex.effort
            : lane.id === 'fireworks' ? normalizeFireworksEffort(model, choice.effort)
            : lane.id.startsWith('openrouter') ? normalizeOpenRouterEffort(model, choice.effort) : choice.effort;
          setDraft({ model, effort });
          setDraftNotice(codex?.notice ?? (effort !== choice.effort ? `Effort adjusted to ${effort} for this model.` : null));
        };
        return (
          <div key={lane.id}>
            <button
              type="button"
              className={`lane${on ? ' on' : ''}`}
              ref={(button) => { laneButtons.current[lane.id] = button; }}
              aria-expanded={open}
              aria-label={`Browse ${lane.label} models and accounts${on ? ', current provider' : ''}`}
              disabled={saving}
              onClick={() => { setExpanded(lane.id); setDraft(null); setDraftNotice(null); setError(''); picker.dismissSelectionFeedback(); }}
            >
              <span className="ring">{meta.ring}</span>
              <span>
                <span className="nm">{lane.label}</span>
                <span className="sb">{meta.short}</span>
              </span>
              <span className="lane-browse">{on ? 'Current' : open ? 'Browsing' : 'Browse'}</span>
              {on ? <span className="tick"><StarSigil style={{ width: 13, height: 13 }} /></span> : null}
            </button>
            {open ? <>
              <SelectionFeedback picker={picker} />
              {!on ? <div className="provider-switch">
                <p><strong>{choiceModelLabel(lane.id, choice.model)} · {choice.effort} {meta.word}</strong>
                  <span>Preview. {WORKSPACE_COMPANIONS.find(c => c.id === picker.companion)?.label} stays in use.</span></p>
                <button type="button" disabled={saving} aria-busy={saving} onClick={async () => {
                  focusAfterSwitch.current = lane.id;
                  setSwitchSaving(true); setError('');
                  try { await picker.setCompanion(lane.id, choice.model, choice.effort); }
                  catch { setError('The switch could not be saved. Try again.'); }
                  finally { setSwitchSaving(false); }
                }}>{saving ? 'Switching…' : `Use ${lane.label}`}</button>
              </div> : null}
              {!on && draftNotice ? <p className="model-choice-hint" role="status">{draftNotice}</p> : null}
              {error ? <p className="model-choice-hint" role="alert">{error}</p> : null}
              <LaneControls picker={picker} laneId={lane.id} model={choice.model} effort={choice.effort}
                onModel={pickModel} onEffort={effort => on ? saved.onEffort(effort) : setDraft({ model: choice.model, effort })}
                accountContext={accountContext} rejectedCodexModel={rejectedCodexModel} disabled={saving} />
            </> : null}
          </div>
        );
      })}
    </>
  );
}

// Most OpenRouter labels read "Vendor: Model"; group on that vendor (or the id's
// vendor segment when a label has no prefix), keeping the server's order
// (vendor, then newest first). Options drop only a verified prefix.
function openRouterVendorGroups(models: OpenRouterModelSpec[]): Array<[string, Array<{ id: string; name: string }>]> {
  const groups = new Map<string, Array<{ id: string; name: string }>>();
  for (const m of models) {
    const cut = m.label.indexOf(': ');
    const vendor = cut > 0 ? m.label.slice(0, cut) : m.id.replace(/^~/, '').split('/')[0]!;
    const name = cut > 0 ? m.label.slice(cut + 2) : m.label;
    groups.set(vendor, [...(groups.get(vendor) ?? []), { id: m.id, name }]);
  }
  return [...groups];
}

// A scrollable list of model rows drawn in the page. Native <select> pickers on
// phones could lose the pick, and plain buttons behave the same everywhere.
type ModelGroup = [string, Array<{ id: string; name: string }>];
function ModelList({
  label,
  groups,
  current,
  onPick,
  searchable = false,
}: {
  label: string;
  groups: ModelGroup[];
  current: string;
  onPick: (id: string) => void;
  searchable?: boolean;
}) {
  const [query, setQuery] = useState('');
  // Show a tap right away; agent threads only confirm after the server save.
  const [picked, setPicked] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const q = query.trim().toLowerCase();
  const shown = q
    ? groups
      .map(([vendor, models]): ModelGroup => [vendor, models.filter((m) => `${vendor} ${m.name} ${m.id}`.toLowerCase().includes(q))])
      .filter(([, models]) => models.length > 0)
    : groups;
  const selected = picked ?? current;
  const rowCount = groups.reduce((n, [, models]) => n + models.length, 0);

  // The server answered (or another device changed it): drop the optimistic pick.
  // A save that never lands (conflict, offline) falls back after a few seconds.
  useEffect(() => { setPicked(null); }, [current]);
  useEffect(() => {
    if (picked === null) return;
    const t = window.setTimeout(() => setPicked(null), 5000);
    return () => window.clearTimeout(t);
  }, [picked]);

  // Keep the current model in view (also once a late catalog fills in),
  // scrolling only the list itself, never while a search is narrowing it.
  useLayoutEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>('.model-row.on');
    if (q || !list || !row) return;
    list.scrollTop = row.offsetTop - list.clientHeight / 2 + row.clientHeight / 2;
  }, [current, rowCount]);

  // Listbox keys: one Tab stop, arrows/Home/End move between rows.
  const onListKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('.model-row') ?? []);
    if (!rows.length) return;
    e.preventDefault();
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'Home' ? 0
      : e.key === 'End' ? rows.length - 1
      : e.key === 'ArrowDown' ? Math.min(rows.length - 1, at + 1)
      : Math.max(0, at < 0 ? 0 : at - 1);
    rows[next]!.focus();
  };
  const firstId = shown[0]?.[1][0]?.id;
  const tabbableId = shown.some(([, models]) => models.some((m) => m.id === selected)) ? selected : firstId;

  return (
    <div className="model-list-wrap">
      {searchable ? (
        <input
          type="search"
          className="model-search"
          placeholder="Search models"
          aria-label={`Search ${label}s`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      ) : null}
      <div className="model-list" role="listbox" aria-label={label} ref={listRef} onKeyDown={onListKey}>
        {shown.map(([vendor, models]) => (
          <div key={vendor || 'all'} role="group" aria-label={vendor || undefined}>
            {vendor ? <div className="model-group">{vendor}</div> : null}
            {models.map((m) => (
              <button
                key={m.id}
                type="button"
                role="option"
                aria-selected={selected === m.id}
                tabIndex={m.id === tabbableId ? 0 : -1}
                title={m.id}
                className={`model-row${selected === m.id ? ' on' : ''}`}
                onClick={() => {
                  if (m.id === selected) return;
                  setPicked(m.id);
                  onPick(m.id);
                }}
              >
                {m.name}
              </button>
            ))}
          </div>
        ))}
        {shown.length === 0 ? <div className="model-empty">No models match</div> : null}
      </div>
    </div>
  );
}

// The browsed provider's controls. Inactive providers edit only the local draft.
function LaneControls({ picker, laneId, model, effort, onModel, onEffort, accountContext, rejectedCodexModel, disabled }: {
  picker: CompanionPicker; laneId: string; model: string; effort: string;
  onModel: (model: string) => void; onEffort: (effort: string) => void;
  accountContext?: AccountContext; rejectedCodexModel?: string; disabled: boolean;
}) {
  const lane = WORKSPACE_COMPANIONS.find(c => c.id === laneId)!;
  const codexModels = useCodexModels();
  useFireworksModels();
  useOpenRouterModels();
  return (
    <fieldset className="lane-ctl" disabled={disabled}>
      {accountContext ? <>
        {laneId !== picker.companion ? <p className="model-choice-hint">Account changes save immediately, even while browsing.</p> : null}
        <AccountControl {...accountContext} engine={lane.cli} />
      </> : null}
      {(laneId === 'claude') && (
        <>
          <span className="ctl-lab">model</span>
          {CLAUDE_MODELS.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`mini${model === m.id ? ' on' : ''}`}
              onClick={() => onModel(m.id)}
            >
              {m.label}
            </button>
          ))}
          <span className="ctl-lab">effort</span>
          <EffortPills options={CLAUDE_EFFORTS} current={effort} onPick={onEffort} />
        </>
      )}
      {(laneId === 'codex') && (
        <>
          <span className="ctl-lab">model</span>
          {(codexModels.some((entry) => entry.id === model) ? codexModels
            : [...codexModels, { id: model, label: `${codexModelLabel(model)} · saved choice` }]).map((m) => (
            <button
              key={m.id}
              type="button"
              className={`mini${model === m.id ? ' on' : ''}`}
              onClick={() => onModel(m.id)}
              title={m.id === rejectedCodexModel ? 'Rejected on the last attempt in this chat. Choose another model, or retry after changing accounts.' : undefined}
            >
              {m.id === rejectedCodexModel ? `${codexModelLabel(m.id)} · last attempt rejected` : m.label}
            </button>
          ))}
          <span className="ctl-lab">effort</span>
          <EffortPills
            options={codexEffortsForModel(model)}
            current={effort}
            onPick={onEffort}
          />
          {model === rejectedCodexModel ? <p className="model-choice-hint" role="status">{codexModelLabel(rejectedCodexModel)} was rejected in this chat. Choose another listed model, or change accounts before retrying.</p> : isCodexModelUnlisted(model) ? <p className="model-choice-hint">Your saved model is missing from this account’s list. Choose a listed model if it cannot run.</p> : null}
        </>
      )}
      {(laneId === 'xai') && (
        <>
          <span className="ctl-lab">model</span>
          {XAI_MODELS.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`mini${model === m.id ? ' on' : ''}`}
              onClick={() => onModel(m.id)}
            >
              {m.label}
            </button>
          ))}
          <span className="ctl-lab">thinking</span>
          <EffortPills options={XAI_EFFORTS} current={effort} onPick={onEffort} />
        </>
      )}
      {(laneId === 'zai') && (
        <>
          <span className="ctl-lab">model</span>
          {ZAI_MODELS.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`mini${model === m.id ? ' on' : ''}`}
              onClick={() => onModel(m.id)}
            >
              {m.label}
            </button>
          ))}
          <span className="ctl-lab">effort</span>
          <EffortPills options={ZAI_EFFORTS} current={effort} onPick={onEffort} />
        </>
      )}
      {(laneId === 'agy') && (
        <>
          <span className="ctl-lab">model</span>
          {AGY_MODELS.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`mini${model === m.id ? ' on' : ''}`}
              onClick={() => onModel(m.id)}
            >
              {m.label}
            </button>
          ))}
          <span className="ctl-lab">thinking</span>
          <EffortPills options={AGY_EFFORTS} current={effort} onPick={onEffort} />
        </>
      )}
      {(laneId === 'fireworks') && (
        <>
          <span className="ctl-lab">model</span>
          {/* An in-page list, not a native select: phone OS pickers dropped the pick. */}
          <ModelList
            label="Fireworks model"
            groups={[['', FIREWORKS_MODELS.map((m) => ({ id: m.id, name: `${m.label}${m.thinkingOnly ? ' · always thinking' : ''}` }))]]}
            current={model}
            onPick={onModel}
          />
          <span className="ctl-lab">thinking</span>
          <EffortPills
            options={fireworksEffortsForModel(model)}
            current={effort}
            onPick={onEffort}
          />
        </>
      )}
      {((laneId === 'openrouter') || (laneId === 'openrouter2')) && (
        <>
          <span className="ctl-lab">model</span>
          {/* Hundreds of models: a searchable in-page list, grouped by vendor. */}
          <ModelList
            label={(laneId === 'openrouter2') ? 'Personal model' : 'OpenRouter model'}
            groups={openRouterVendorGroups(OPENROUTER_MODELS)}
            current={model}
            onPick={onModel}
            searchable
          />
          <span className="ctl-lab">thinking</span>
          <EffortPills
            options={openRouterEffortsForModel(model)}
            current={effort}
            onPick={onEffort}
          />
        </>
      )}
      <span className="lane-note">{companionAuthBlurb(lane.cli, lane.account ?? null)}</span>
    </fieldset>
  );
}

export function SelectionFeedback({ picker }: { picker: CompanionPicker }) {
  const text = picker.selectionError ?? picker.selectionNotice;
  return text ? <div className={`model-choice-feedback${picker.selectionError ? ' is-error' : ''}`} role={picker.selectionError ? 'alert' : 'status'}>
    <span>{text}</span>
    <button type="button" aria-label="Dismiss settings message" onClick={picker.dismissSelectionFeedback}>Dismiss</button>
  </div> : null;
}

// ── desktop popover ─────────────────────────────────────────────────────────
export function CounselPopover({
  picker,
  open,
  onClose,
  accountContext,
  rejectedCodexModel,
}: {
  picker: CompanionPicker;
  rejectedCodexModel?: string;
  accountContext?: AccountContext;
  open: boolean;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open || !panel.current) return;
    const popup = panel.current;
    const anchor = popup.parentElement;
    if (!anchor) return;
    const conversation = popup.closest('.bt-conv-wrap');
    const header = conversation?.querySelector(':scope > .bt-head, :scope > .desk-chat-head');
    const place = () => {
      const top = Math.max(header?.getBoundingClientRect().bottom ?? conversation?.getBoundingClientRect().top ?? 0, window.visualViewport?.offsetTop ?? 0);
      popup.style.maxHeight = `${Math.max(0, Math.floor(anchor.getBoundingClientRect().top - top - 18))}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(anchor);
    if (header) observer.observe(header);
    window.addEventListener('resize', place);
    window.visualViewport?.addEventListener('resize', place);
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.visualViewport?.removeEventListener('resize', place); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onDown = (e: MouseEvent) => {
      // Close on outside click, but ignore clicks on the chip that owns this
      // popover (it toggles the popover itself).
      const t = e.target as HTMLElement | null;
      if (t?.closest('.modelpop') || t?.closest('.model-chip')) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      ref={panel}
      className="pop modelpop show"
      role="dialog"
      aria-label="Choose a companion"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="pop-h">Choose a companion</div>
      <LaneList picker={picker} accountContext={accountContext} rejectedCodexModel={rejectedCodexModel} />
    </div>
  );
}

// ── mobile bottom sheet ─────────────────────────────────────────────────────
export function CounselSheet({
  picker,
  open,
  onClose,
  accountContext,
  rejectedCodexModel,
}: {
  picker: CompanionPicker;
  rejectedCodexModel?: string;
  accountContext?: AccountContext;
  open: boolean;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <>
      <div className={`scrim${open ? ' show' : ''}`} onClick={onClose} />
      <div className={`sheet${open ? ' show' : ''}`} role="dialog" aria-modal="true" aria-label="Choose a companion">
        <button type="button" className="sheet-grab" aria-label="Close" onClick={onClose}>
          <i />
        </button>
        <h2>Choose a companion</h2>
        <div className="sheet-list">
          <LaneList picker={picker} accountContext={accountContext} rejectedCodexModel={rejectedCodexModel} />
        </div>
      </div>
    </>
  );
}
