// The switch at the top of the right sidebar: the open agent's desk, Matt's own
// desk ("My desk"), or both side by side. The choice is a per-device setting
// (localStorage), never a server value.

import { Columns2 } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useDeskSummary } from '../data/desk';
import { agentColor, DISC_INK } from './agents';
import './myDesk.css';

export type DeskPaneMode = 'agent' | 'mine' | 'both';
export const DESK_PANE_MODE_KEY = 'rivendell:bot-pane-desk';

function readMode(): DeskPaneMode {
  try {
    const raw = localStorage.getItem(DESK_PANE_MODE_KEY);
    return raw === 'mine' || raw === 'both' ? raw : 'agent';
  } catch {
    return 'agent';
  }
}

/** The saved mode for this device. Setting it saves it; a browser that refuses
 *  storage still switches for the session. */
export function useDeskPaneMode(): [DeskPaneMode, (next: DeskPaneMode) => void] {
  const [mode, setModeState] = useState<DeskPaneMode>(readMode);
  const setMode = useCallback((next: DeskPaneMode) => {
    setModeState(next);
    try { localStorage.setItem(DESK_PANE_MODE_KEY, next); } catch { /* per-session only */ }
  }, []);
  return [mode, setMode];
}

const MODES: DeskPaneMode[] = ['agent', 'mine', 'both'];

export function DeskPaneSwitch({ mode, onChange, agentLabel }: {
  mode: DeskPaneMode;
  onChange: (next: DeskPaneMode) => void;
  agentLabel: string;
}) {
  // Reads the workspace badge's cached poll (GrokApp runs it whenever the Desk is
  // on, which is the only time this switch exists), so it never fetches itself.
  const summary = useDeskSummary(false);
  const needsYou = summary.data?.openTodos ?? 0;
  const hot = (summary.data?.highTodos ?? 0) > 0;
  const name = agentLabel.trim() || 'Agent';
  const titles: Record<DeskPaneMode, string> = {
    agent: `${name}'s desk`,
    mine: 'My desk',
    both: `${name}'s desk and mine`,
  };

  return (
    <div className="md-switch" role="group" aria-label="Which desk to show" data-mode={mode}>
      <span className="md-switch-thumb" aria-hidden="true" />
      {MODES.map((key) => (
        <button
          key={key}
          type="button"
          className="md-seg"
          aria-pressed={mode === key}
          title={titles[key]}
          onClick={() => { if (mode !== key) onChange(key); }}
        >
          {key === 'agent' ? (
            <>
              <span className="md-disc" aria-hidden="true" style={{ background: agentColor(name), color: DISC_INK }}>
                {name.slice(0, 1).toUpperCase()}
              </span>
              <span className="md-seg-label">{name}</span>
            </>
          ) : key === 'mine' ? (
            <>
              <span className="md-disc is-mine" aria-hidden="true">M</span>
              <span className="md-seg-label">My desk</span>
              {needsYou ? (
                <span
                  className={`md-seg-badge${hot ? ' is-hot' : ''}`}
                  aria-label={`${needsYou} need${needsYou === 1 ? 's' : ''} you`}
                >
                  {needsYou > 99 ? '99+' : needsYou}
                </span>
              ) : null}
            </>
          ) : (
            <>
              <Columns2 size={14} aria-hidden="true" className="md-seg-icon" />
              <span className="md-seg-label">Both</span>
            </>
          )}
        </button>
      ))}
    </div>
  );
}
