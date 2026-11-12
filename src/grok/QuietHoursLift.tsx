// Quiet hours for one teammate, inside their editor (Matt, Nov 12 2026):
// lift the overnight window for a set stretch, see a lift in force, change
// or end it. A lift applies the moment it is set, separate from Save, and
// quiet hours return on their own when it ends.

import { useEffect, useState } from 'react';
import { Moon, MoonStar } from 'lucide-react';
import { endQuietHoursLift, fetchQuietNightEnds, liftQuietHours } from '../data/api';
import type { Agent, AgentQuietHours } from './agents';
import './quietHours.css';

/** "Sun, Nov 15, 9:00 PM" in the viewer's own zone. */
export function liftEndText(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** <input type="datetime-local"> value for an instant, in the viewer's zone. */
function localInput(ms: number): string {
  return new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/** Each length ends when the server's Eastern quiet window does, counting the
 *  night in force now (or the coming one) as tonight. */
const PRESETS = [
  { label: 'Tonight', nights: 1 },
  { label: '3 nights', nights: 3 },
  { label: 'A week', nights: 7 },
] as const;

/** The server's sentence out of the body apiJson throws. */
function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  try { return (JSON.parse(raw) as { error?: string }).error || raw; } catch { return raw; }
}

/** `onChanged` runs after a lift or an end lands, so the app re-reads the
 *  roster and the sidebar's moon follows at once. */
export function QuietHoursLift({ agent, onChanged }: { agent: Agent; onChanged?: () => void }) {
  const [state, setState] = useState<AgentQuietHours | undefined>(agent.quietHours);
  const [picking, setPicking] = useState(false);
  /** The quick length picked (in nights), or null when the end is typed. */
  const [preset, setPreset] = useState<number | null>(null);
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [nightEnds, setNightEnds] = useState<string[] | null>(null);

  // Another teammate, or a newer roster view of this one, resets the panel.
  useEffect(() => { setState(agent.quietHours); }, [agent.id, agent.quietHours?.until, agent.quietHours?.standing]);
  useEffect(() => { setPicking(false); setErr(null); }, [agent.id]);

  if (state?.standing) {
    return (
      <div className="bt-quiet is-standing">
        <span className="bt-quiet-icon" aria-hidden><MoonStar size={16} /></span>
        <span className="bt-quiet-text">
          Works through quiet hours
          <small>A standing exception: overnight work always reaches {agent.name}.</small>
        </span>
      </div>
    );
  }

  const liftedUntil = state?.until && Date.parse(state.until) > Date.now() ? state.until : undefined;

  const presetEnd = (nights: number): string => {
    const end = nightEnds?.[nights - 1];
    return end ? localInput(Date.parse(end)) : '';
  };
  const until = preset ? presetEnd(preset) : typed;

  const openPicker = () => {
    // A new lift starts on Tonight; a change starts from the end in force.
    setPreset(liftedUntil ? null : 1);
    setTyped(liftedUntil ? localInput(Date.parse(liftedUntil)) : '');
    setReason(liftedUntil ? state?.reason ?? '' : '');
    setErr(null);
    setNightEnds(null);
    setPicking(true);
    fetchQuietNightEnds()
      .then(setNightEnds)
      .catch(() => setErr("Couldn't load the quick lengths. Pick an end below instead."));
  };

  const lift = async () => {
    if (!preset && !Number.isFinite(new Date(typed).getTime())) { setErr('Pick when the lift ends.'); return; }
    setBusy(true);
    setErr(null);
    try {
      // A quick length means "this many nights from now": re-read the windows
      // as it is granted, so a picker left open past a window's end still
      // lifts the nights it names. A typed end is kept exactly.
      const ends = preset ? Date.parse((await fetchQuietNightEnds())[preset - 1]) : new Date(typed).getTime();
      const { pass } = await liftQuietHours(agent.id, new Date(ends).toISOString(), reason.trim() || undefined);
      setState({ until: pass.until, reason: pass.reason, grantedBy: pass.grantedBy });
      setPicking(false);
      onChanged?.();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const end = async () => {
    setBusy(true);
    setErr(null);
    try {
      await endQuietHoursLift(agent.id);
      setState(undefined);
      onChanged?.();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const error = err ? <div className="bt-quiet-err" role="alert">{err}</div> : null;

  if (picking) {
    return (
      <div className="bt-quiet is-picking">
        <div className="bt-quiet-head">
          <span className="bt-quiet-icon" aria-hidden><MoonStar size={16} /></span>
          <span className="bt-quiet-text">
            Let {agent.name} work through quiet hours
            <small>Routines, job results, T3 Code wake-ups and teammate messages reach them overnight until then. Quiet hours return on their own after.</small>
          </span>
        </div>
        <div className="bt-quiet-chips" role="group" aria-label="Quick lengths">
          {PRESETS.map((option) => {
            const on = preset === option.nights;
            return (
              <button key={option.label} type="button" className={`bt-quiet-chip${on ? ' on' : ''}`} aria-pressed={on} disabled={!presetEnd(option.nights)} onClick={() => setPreset(option.nights)}>
                {option.label}
              </button>
            );
          })}
        </div>
        <div className="bt-quiet-fields">
          <label className="bt-quiet-field">
            <span>Until</span>
            <input type="datetime-local" value={until} min={localInput(Date.now())} onChange={(e) => { setTyped(e.target.value); setPreset(null); }} />
          </label>
          <label className="bt-quiet-field">
            <span>Why <em>optional</em></span>
            <input type="text" value={reason} maxLength={200} placeholder="A game jam that runs around the clock" onChange={(e) => setReason(e.target.value)} />
          </label>
        </div>
        {error}
        <div className="bt-quiet-actions">
          <button type="button" className="bt-quiet-btn ghost" disabled={busy} onClick={() => { setPicking(false); setErr(null); }}>Cancel</button>
          <button type="button" className="bt-quiet-btn primary" disabled={busy || !until} onClick={lift}>
            {busy ? 'Lifting…' : liftedUntil ? 'Save new end' : 'Lift quiet hours'}
          </button>
        </div>
      </div>
    );
  }

  if (liftedUntil) {
    return (
      <>
        <div className="bt-quiet is-lifted">
          <span className="bt-quiet-icon" aria-hidden><MoonStar size={16} /></span>
          <span className="bt-quiet-text">
            Working through quiet hours
            <small>
              Until {liftEndText(liftedUntil)}
              {state?.reason ? ` · ${state.reason}` : ''}
              {state?.grantedBy ? ` · lifted by ${state.grantedBy}` : ''}
            </small>
          </span>
          <span className="bt-quiet-btns">
            <button type="button" className="bt-quiet-btn ghost" disabled={busy} onClick={openPicker}>Change</button>
            <button type="button" className="bt-quiet-btn" disabled={busy} onClick={end}>{busy ? 'Ending…' : 'End now'}</button>
          </span>
        </div>
        {error}
      </>
    );
  }

  return (
    <div className="bt-quiet">
      <span className="bt-quiet-icon" aria-hidden><Moon size={16} /></span>
      <span className="bt-quiet-text">
        Quiet hours hold overnight work
        <small>9pm–7am weeknights, 8pm–8am Friday and Saturday nights, Eastern</small>
      </span>
      <button type="button" className="bt-quiet-btn" onClick={openPicker}>Lift for a stretch</button>
    </div>
  );
}
