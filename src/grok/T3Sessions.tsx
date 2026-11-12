// A teammate's running T3 Code sessions, shown on the roster: one line per
// session under their name (title, host, state, a live run clock) and a small
// count badge where there is no room for lines. A session is a satellite the
// teammate launched, so each one wears a tiny orbit that keeps turning while
// it runs.

import { useEffect, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import type { T3SessionView } from '../data/api';
import { fmtClock } from '../chat/components/jobs/format';
import './t3Sessions.css';

const MAX_LINES = 4;

/** running: turning. asking or waiting: holding for an answer. Anything else is spinning up. */
function tone(state: string): 'run' | 'wait' | 'warm' {
  return state === 'running' ? 'run' : state === 'asking' || state === 'waiting' ? 'wait' : 'warm';
}

/** The word on the chip. `asking` is a run blocked on a question for its owner. */
const stateLabel = (state: string): string => (state === 'asking' ? 'needs answer' : state);

/** The orbit a session wears; its moon (.t3s-moon) is what turns. */
export function T3Orbit() {
  return (
    <svg className="t3s-orbit" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.32" strokeWidth="1.2" />
      <circle cx="8" cy="8" r="2" fill="currentColor" fillOpacity="0.55" />
      <circle className="t3s-moon" cx="8" cy="2" r="1.9" fill="currentColor" />
    </svg>
  );
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function describe(session: T3SessionView, elapsedMs: number): string {
  return `${session.title}: ${stateLabel(session.state)} on ${session.host} for ${fmtClock(elapsedMs)}`;
}

export function T3SessionLines({ agentName, sessions, skewMs }: { agentName: string; sessions: T3SessionView[]; skewMs: number }) {
  const now = useNow(sessions.length > 0) + skewMs;
  if (!sessions.length) return null;
  const more = sessions.length - MAX_LINES;
  return (
    <span className="t3s" role="list" aria-label={`${agentName}'s running T3 sessions`}>
      {sessions.slice(0, MAX_LINES).map((session) => {
        const elapsed = now - session.runningSince;
        return (
          <span key={session.id} className={`t3s-line is-${tone(session.state)}`} role="listitem" title={describe(session, elapsed)}>
            <T3Orbit />
            <span className="t3s-body">
              <span className="t3s-title">{session.title}</span>
              <span className="t3s-meta">
                {session.state === 'running' ? null : <span className="t3s-state">{stateLabel(session.state)}</span>}
                {session.host} · <span className="t3s-clock">{fmtClock(elapsed)}</span>
              </span>
            </span>
            {session.link ? (
              <span
                className="t3s-open"
                role="link"
                tabIndex={0}
                aria-label={`Open ${session.title} in T3 Code`}
                title="Open in T3 Code"
                onClick={(e) => { e.stopPropagation(); window.open(session.link, '_blank', 'noopener'); }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return;
                  e.preventDefault(); e.stopPropagation();
                  window.open(session.link, '_blank', 'noopener');
                }}
                onKeyUp={(e) => { if (e.key === ' ') { e.preventDefault(); e.stopPropagation(); } }}
              >
                <ArrowUpRight size={12} />
              </span>
            ) : null}
          </span>
        );
      })}
      {more > 0 ? <span className="t3s-more" role="listitem">+{more} more running</span> : null}
    </span>
  );
}

/** "3 sessions" with the orbit: the pinned strip and folded group headers. */
export function T3SessionsBadge({ sessions, count = sessions?.length ?? 0 }: { sessions?: T3SessionView[]; count?: number }) {
  if (count <= 0) return null;
  const label = `${count} T3 ${count === 1 ? 'session' : 'sessions'} running`;
  const detail = sessions?.map((s) => `${s.title} (${stateLabel(s.state)} on ${s.host})`).join('\n');
  return (
    <span className="t3s-badge" role="status" aria-label={label} title={detail ? `${label}\n${detail}` : label}>
      <T3Orbit />
      {count} {count === 1 ? 'session' : 'sessions'}
    </span>
  );
}
