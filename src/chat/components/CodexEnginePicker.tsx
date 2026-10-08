import { codexEffortsForModel, useCodexCliStatus, useCodexModels } from '../codexModels';

// Model + reasoning-effort selector for Codex. The chosen values ride the WS
// send/steer payload and reach `codex -m` / `-c model_reasoning_effort`.
export const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
  { id: 'claude-fable-5', label: 'Fable 5' },
];
// The 5.5 family (Opus, Sonnet, Haiku) shares the same five real effort tiers
// (low → max); their own CLI defaults differ, but TARDIS always passes
// --effort explicitly per brain.
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// Default Claude model when nothing (valid) is stored. Opus 5.5 is the flagship.
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';

// Coerce a stored/legacy Claude model id onto the current option set so a stale
// value (e.g. the retired `claude-opus-4-8`) can never leave the <select> on a
// value with no matching <option>, which would strand the picker on a blank.
export function normalizeClaudeModel(model: string | null | undefined): string {
  return CLAUDE_MODELS.some((m) => m.id === model) ? (model as string) : DEFAULT_CLAUDE_MODEL;
}

export function CodexEnginePicker(props: {
  model: string;
  onModelChange: (m: string) => void;
  effort: string;
  onEffortChange: (e: string) => void;
  disabled?: boolean;
  models?: { id: string; label: string }[];
  efforts?: string[];
  modelAriaLabel?: string;
  effortAriaLabel?: string;
  effortLabel?: string;
}) {
  const live = useCodexModels();
  const cli = useCodexCliStatus();
  const models = props.models ?? live;
  const efforts = props.efforts ?? codexEffortsForModel(props.model);
  const base = {
    fontSize: 12.5,
    border: '1px solid var(--rule, currentColor)',
    borderRadius: 6,
    background: 'transparent',
    color: 'inherit',
    padding: '2px 6px',
    cursor: (props.disabled ? 'not-allowed' : 'pointer') as 'not-allowed' | 'pointer',
    opacity: props.disabled ? 0.5 : 1,
  };
  return (
    <>
      <select
        aria-label={props.modelAriaLabel ?? 'Codex model'}
        style={base}
        disabled={props.disabled}
        value={props.model}
        onChange={(e) => props.onModelChange(e.target.value)}
      >
        {models.map((m) => (
          <option key={m.id} value={m.id}>{m.label}</option>
        ))}
      </select>
      <select
        aria-label={props.effortAriaLabel ?? 'Reasoning effort'}
        style={base}
        disabled={props.disabled}
        value={props.effort}
        onChange={(e) => props.onEffortChange(e.target.value)}
      >
        {efforts.map((e) => (
          <option key={e} value={e}>{`${props.effortLabel ?? 'effort'} · ${e}`}</option>
        ))}
      </select>
      {cli.outdated && (
        <span
          style={{ fontSize: 11.5, opacity: 0.75, cursor: 'help' }}
          title={`Codex CLI ${cli.version ?? '?'} is behind ${cli.latest ?? 'the latest release'}. Models this account offers may be hidden until the CLI is updated.`}
        >
          CLI outdated
        </span>
      )}
    </>
  );
}
