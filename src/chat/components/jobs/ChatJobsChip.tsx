// The chat's background-work chip. It lives in the chat header next to the
// Computer chip (never above the composer, where a stray click or thumb lands
// while someone is typing), so it is visible whether the agent is streaming or
// idle. Click drops the list down from the header. One picture of everything
// running behind the chat: named jobs the agent started with job_start (timer,
// last output line, Stop) plus the model's own background shells and subagents
// (label only). Ended jobs from the last few minutes stay in the list, dimmed.

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from '../reimagine/icons';
import { useAnchoredPopover } from '../useAnchoredPopover';
import { useJobLog, useJobs, type JobView, type StopResult } from '../../hooks/useJobs';
import { fmtClock, jobOutcome, jobTone } from './format';
import { JobRing } from './parts';
import './jobs.css';

export type ChatJobsChipProps = {
  /** The chat's agent. Without one only the model's own background work shows. */
  agentId?: string;
  /** Background shells and subagents the model itself is running (useChat). */
  backgroundWork?: string[];
  /** A narrow header: the pill is the ring and the count only (the label is in the tooltip and accessible name). */
  compact?: boolean;
};

/** Ticks while `active`, so a running job's clock moves between polls. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function ChatJobsChip({ agentId, backgroundWork, compact = false }: ChatJobsChipProps) {
  const { running, recent, fetchedAt, stopping, stopJob } = useJobs(agentId);
  const tasks = backgroundWork ?? [];

  const runningCount = running.length + tasks.length;
  const empty = runningCount === 0 && recent.length === 0;
  const bad = recent.filter((job) => jobTone(job.state) === 'bad');
  const failed = bad.length;
  let tone: 'run' | 'ok' | 'bad' | 'warn';
  let label: string;
  let count: number;
  if (runningCount > 0) {
    tone = 'run';
    label = `${plural(runningCount, 'job')} running`;
    count = runningCount;
  } else if (failed > 0) {
    tone = 'bad';
    label = `${plural(failed, 'job')} ${bad.every((job) => job.state === 'lost') ? 'lost' : 'failed'}`;
    count = failed;
  } else if (recent.length === 1) {
    tone = jobTone(recent[0].state) === 'ok' ? 'ok' : 'warn';
    label = `1 job ${jobOutcome(recent[0])}`;
    count = 1;
  } else {
    tone = recent.some((job) => jobTone(job.state) === 'warn') ? 'warn' : 'ok';
    label = `${recent.length} jobs ended`;
    count = recent.length;
  }

  const { open, setOpen, toggle, close, triggerRef, panelRef, panelId, portalRoot, ready, panelStyle, onPanelKeyDown, onPanelBlur } = useAnchoredPopover({ measureKey: `${compact}|${label}`, width: 440, maxHeight: 440 });
  const now = useNow(open && !empty);
  useEffect(() => { if (empty) setOpen(false); }, [empty, setOpen]);

  if (empty) return null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`jb-pill jt-${tone}${compact ? ' is-compact' : ''}${open ? ' is-open' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`${label}. ${open ? 'Hide' : 'Show'} the list`}
        title={label}
        onClick={toggle}
      >
        <span className="jb-face">
          <JobRing tone={tone} />
          <span className="jb-count" key={compact ? count : label}>{compact ? count : label}</span>
          {compact ? null : <ChevronDown className="jb-chev" aria-hidden="true" />}
        </span>
      </button>

      {ready && portalRoot ? createPortal(
        <div
          ref={panelRef}
          id={panelId}
          className="jb-pop"
          role="dialog"
          aria-label="Background jobs"
          tabIndex={-1}
          style={panelStyle}
          onKeyDown={onPanelKeyDown}
          onBlur={onPanelBlur}
        >
          <div className="jb-pop-h">
            <span>Background jobs</span>
            <button type="button" className="jb-x" aria-label="Close the list" onClick={() => close(true)}>
              <span aria-hidden="true">&times;</span>
            </button>
          </div>
          <ul className="jb-list">
            {running.map((job) => (
              <JobRow key={job.id} job={job} now={now} fetchedAt={fetchedAt} stopping={stopping.has(job.id)} onStop={stopJob} />
            ))}
            {tasks.map((task, index) => (
              <li className="jb-row jt-run is-task" key={`task-${index}-${task}`}>
                <div className="jb-row-main">
                  <div className="jb-row-static">
                    <JobRing tone="run" small />
                    <span className="jb-row-text">
                      <span className="jb-name">{task}</span>
                      <span className="jb-line jb-line-plain">Background task</span>
                    </span>
                  </div>
                </div>
              </li>
            ))}
            {recent.map((job) => (
              <JobRow key={job.id} job={job} now={now} fetchedAt={fetchedAt} stopping={false} onStop={stopJob} />
            ))}
          </ul>
        </div>,
        portalRoot,
      ) : null}
    </>
  );
}

function JobRow({ job, now, fetchedAt, stopping, onStop }: {
  job: JobView;
  now: number;
  fetchedAt: number;
  stopping: boolean;
  onStop: (id: string) => Promise<StopResult>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState('');
  const isRunning = job.state === 'running';
  const tone = jobTone(job.state);
  const log = useJobLog(job.id, expanded, isRunning);
  // The poll's elapsed plus local time since it landed: skew-free and 1s smooth.
  // A failed Stop's message belongs to that attempt: drop it once the job's state moves on.
  useEffect(() => { setError(''); }, [job.state]);
  const elapsed = isRunning ? job.elapsedMs + Math.max(0, now - fetchedAt) : job.elapsedMs;

  const stop = async () => {
    setError('');
    const result = await onStop(job.id);
    if (!result.ok) setError(`Could not stop it: ${result.error}`);
  };

  return (
    <li className={`jb-row jt-${tone}${isRunning ? '' : ' is-ended'}${expanded ? ' is-open' : ''}${stopping ? ' is-stopping' : ''}`}>
      <div className="jb-row-main">
        <button
          type="button"
          className="jb-row-toggle"
          aria-expanded={expanded}
          aria-label={`${job.name}, ${jobOutcome(job)}. ${expanded ? 'Hide' : 'Show'} output`}
          onClick={() => setExpanded((value) => !value)}
        >
          {isRunning ? <JobRing tone="run" small stopping={stopping} /> : <span className="jb-dot" aria-hidden="true" />}
          <span className="jb-row-text">
            <span className="jb-name">{job.name}</span>
            <span className="jb-line">{job.lastLine || (isRunning ? 'no output yet' : 'no output')}</span>
          </span>
          <span className="jb-clock" title={isRunning ? 'running for' : 'ran for'}>{fmtClock(elapsed)}</span>
        </button>
        {isRunning ? (
          <button type="button" className="jb-stop" disabled={stopping} onClick={() => void stop()}>
            {stopping ? 'stopping…' : (<><i aria-hidden="true" />Stop</>)}
          </button>
        ) : (
          <span className="jb-outcome">{jobOutcome(job)}</span>
        )}
      </div>
      {error ? <div className="jb-err" role="alert">{error}</div> : null}
      {expanded ? (
        <pre className="jb-log" tabIndex={0} aria-label={`${job.name} output`}>
          {log.data ? (log.data.tail || 'no output yet') : log.isError ? 'could not load the log' : 'loading…'}
        </pre>
      ) : null}
    </li>
  );
}
