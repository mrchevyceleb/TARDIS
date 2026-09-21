// Choose a companion — the reimagined companion + model + effort picker
// (§3.10). Reskins CompanionControls.tsx into a single "model chip" that opens
// either a desktop popover ("Counsel of the house") or a mobile bottom sheet
// ("The Counsel"). All state + persistence already live in useCompanionPicker;
// this is presentation-only, with subscription model and effort controls.

import { useEffect } from 'react';
import type { CompanionPicker } from '../../hooks/useCompanionPicker';
import {
  WORKSPACE_COMPANIONS,
  XAI_MODELS,
  XAI_EFFORTS,
  ZAI_MODELS,
  ZAI_EFFORTS,
  companionAuthBlurb,
} from '../../hooks/useCompanionPicker';
import { CLAUDE_MODELS, CLAUDE_EFFORTS } from '../CodexEnginePicker';
import { CODEX_MODELS, codexEffortsForModel } from '../../codexModels';
import { StarSigil } from './icons';

type LaneMeta = { ring: string; short: string; word: string };

const LANE_META: Record<string, LaneMeta> = {
  claude: { ring: 'C', short: 'Claude Code subscription', word: 'effort' },
  codex: { ring: 'X', short: 'Codex subscription', word: 'effort' },
  xai: { ring: 'G', short: 'Grok coding subscription', word: 'thinking' },
  zai: { ring: 'Z', short: 'Z.ai coding plan', word: 'effort' },
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
  else if (picker.isCodex) name = labelFor(picker.codexModel, CODEX_MODELS);
  else if (picker.isXai) name = labelFor(picker.xaiModel, XAI_MODELS);
  else if (picker.isZai) name = labelFor(picker.zaiModel, ZAI_MODELS);
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
      {options.map((v) => (
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
function LaneList({ picker }: { picker: CompanionPicker }) {
  return (
    <>
      {WORKSPACE_COMPANIONS.map((lane) => {
        const meta = LANE_META[lane.id] ?? { ring: '•', short: '', word: 'effort' };
        const on = picker.companion === lane.id;
        return (
          <div key={lane.id}>
            <button
              type="button"
              className={`lane${on ? ' on' : ''}`}
              onClick={() => picker.setCompanion(lane.id)}
            >
              <span className="ring">{meta.ring}</span>
              <span>
                <span className="nm">{lane.label}</span>
                <span className="sb">{meta.short}</span>
              </span>
              <span className="tick">
                <StarSigil style={{ width: 13, height: 13 }} />
              </span>
            </button>
            {on ? <LaneControls picker={picker} /> : null}
          </div>
        );
      })}
    </>
  );
}

// The active lane's model + effort controls, expanded in place.
function LaneControls({ picker }: { picker: CompanionPicker }) {
  return (
    <div className="lane-ctl">
      {picker.isClaude && (
        <>
          <span className="ctl-lab">model</span>
          {CLAUDE_MODELS.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`mini${picker.claudeModel === m.id ? ' on' : ''}`}
              onClick={() => picker.setClaudeModel(m.id)}
            >
              {m.label}
            </button>
          ))}
          <span className="ctl-lab">effort</span>
          <EffortPills options={CLAUDE_EFFORTS} current={picker.claudeEffort} onPick={picker.setClaudeEffort} />
        </>
      )}
      {picker.isCodex && (
        <>
          <span className="ctl-lab">model</span>
          {CODEX_MODELS.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`mini${picker.codexModel === m.id ? ' on' : ''}`}
              onClick={() => picker.setCodexModel(m.id)}
            >
              {m.label}
            </button>
          ))}
          <span className="ctl-lab">effort</span>
          <EffortPills
            options={codexEffortsForModel(picker.codexModel)}
            current={picker.codexEffort}
            onPick={picker.setCodexEffort}
          />
        </>
      )}
      {picker.isXai && (
        <>
          <span className="ctl-lab">model</span>
          {XAI_MODELS.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`mini${picker.xaiModel === m.id ? ' on' : ''}`}
              onClick={() => picker.setXaiModel(m.id)}
            >
              {m.label}
            </button>
          ))}
          <span className="ctl-lab">thinking</span>
          <EffortPills options={XAI_EFFORTS} current={picker.xaiEffort} onPick={picker.setXaiEffort} />
        </>
      )}
      {picker.isZai && (
        <>
          <span className="ctl-lab">model</span>
          {ZAI_MODELS.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`mini${picker.zaiModel === m.id ? ' on' : ''}`}
              onClick={() => picker.setZaiModel(m.id)}
            >
              {m.label}
            </button>
          ))}
          <span className="ctl-lab">effort</span>
          <EffortPills options={ZAI_EFFORTS} current={picker.zaiEffort} onPick={picker.setZaiEffort} />
        </>
      )}
      <span className="lane-note">{counselChipInfo(picker).blurb}</span>
    </div>
  );
}

// ── desktop popover ─────────────────────────────────────────────────────────
export function CounselPopover({
  picker,
  open,
  onClose,
}: {
  picker: CompanionPicker;
  open: boolean;
  onClose: () => void;
}) {
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
      className="pop modelpop show"
      role="listbox"
      aria-label="Choose a companion"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="pop-h">Choose a companion</div>
      <LaneList picker={picker} />
    </div>
  );
}

// ── mobile bottom sheet ─────────────────────────────────────────────────────
export function CounselSheet({
  picker,
  open,
  onClose,
}: {
  picker: CompanionPicker;
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
          <LaneList picker={picker} />
        </div>
      </div>
    </>
  );
}
