// Left-rail badge: "N jobs" with a turning arc. Deliberately not a dot, not a
// count bubble and not the busy pulse, so it never reads as presence, unread
// or "working". The rail calls useJobsSummary() once and hands each row its
// entry:
//
//   const jobs = useJobsSummary();
//   const entry = jobs.get(agent.id);
//   {entry ? <RailJobsBadge running={entry.running} latest={entry.latest} latestLine={entry.latestLine} /> : null}

import './jobs.css';

export type RailJobsBadgeProps = {
  /** Running job count. Renders nothing at 0. */
  running: number;
  /** Newest running job's name, for the tooltip. */
  latest?: string;
  /** Its last output line, for the tooltip. */
  latestLine?: string;
  /** Visible text when it is not the plain "N jobs" (a folded group header
   *  counts agents, not jobs). */
  label?: string;
  className?: string;
};

export function RailJobsBadge({ running, latest, latestLine, label, className }: RailJobsBadgeProps) {
  if (!Number.isFinite(running) || running <= 0) return null;
  const count = `${running} ${running === 1 ? 'job' : 'jobs'}`;
  const detail = [latest, latestLine].filter(Boolean).join(': ');
  return (
    <span
      className={`jb-badge${className ? ` ${className}` : ''}`}
      role="status"
      aria-label={label ? undefined : `${count} running${latest ? `, latest ${latest}` : ''}`}
      title={label ? undefined : detail ? `${count} running. ${detail}` : `${count} running`}
    >
      <svg className="jb-badge-ring" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.2" />
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeDasharray="20 18" />
      </svg>
      {label ?? count}
    </span>
  );
}
