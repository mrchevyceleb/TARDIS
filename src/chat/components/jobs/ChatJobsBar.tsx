// The chat's background-work pill. It sits with the composer (not in the feed),
// so it is visible whether the agent is streaming or idle, and it never
// touches the composer itself: you can always type. One picture of everything
// running behind the chat: named jobs the agent started with job_start (timer,
// last output line, Stop) plus the model's own background shells and subagents
// (label only). Ended jobs from the last few minutes stay in the list, dimmed.

import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown } from '../reimagine/icons';
import { useJobLog, useJobs, type JobView, type StopResult } from '../../hooks/useJobs';
import { fmtClock, jobOutcome, jobTone } from './format';
import { JobRing } from './parts';
import './jobs.css';

export type ChatJobsBarProps = {
  /** The chat's agent. Without one only the model's own background work shows. */
  agentId?: string;
  /** Background shells and subagents the model itself is running (useChat). */
  backgroundWork?: string[];
  mobile?: boolean;
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

export function ChatJobsBar({ agentId, backgroundWork, mobile = false }: ChatJobsBarProps) {
  const { running, recent, fetchedAt, stopping, stopJob } = useJobs(agentId);
  const tasks = backgroundWork ?? [];
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  const popId = useId();

  const runningCount = running.length + tasks.length;
  const empty = runningCount === 0 && recent.length === 0;
  const now = useNow(open && !empty);

  useEffect(() => { if (empty) setOpen(false); }, [empty]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      pillRef.current?.focus();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (empty) return null;

  const bad = recent.filter((job) => jobTone(job.state) === 'bad');
  const failed = bad.length;
  let tone: 'run' | 'ok' | 'bad' | 'warn';
  let label: string;
  if (runningCount > 0) {
    tone = 'run';
    label = `${plural(runningCount, 'job')} running`;
  } else if (failed > 0) {
    tone = 'bad';
    label = `${plural(failed, 'job')} ${bad.every((job) => job.state === 'lost') ? 'lost' : 'failed'}`;
  } else if (recent.length === 1) {
    tone = jobTone(recent[0].state) === 'ok' ? 'ok' : 'warn';
    label = `1 job ${jobOutcome(recent[0])}`;
  } else {
    tone = recent.some((job) => jobTone(job.state) === 'warn') ? 'warn' : 'ok';
    label = `${recent.length} jobs ended`;
  }

  return (
    <div className={`jb-bar${mobile ? ' is-mobile' : ''}`} ref={rootRef}>
      <button
        ref={pillRef}
        type="button"
        className={`jb-pill jt-${tone}${open ? ' is-open' : ''}`}
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        aria-label={`${label}. ${open ? 'Hide' : 'Show'} the list`}
        onClick={() => setOpen((value) => !value)}
      >
        <JobRing tone={tone} />
        <span className="jb-count" key={label}>{label}</span>
        <ChevronDown className="jb-chev" aria-hidden="true" />
      </button>

      {open ? (
        <div className="jb-pop" id={popId} role="region" aria-label="Background jobs">
          <div className="jb-pop-h">
            <span>Background jobs</span>
            <button type="button" className="jb-x" aria-label="Close the list" onClick={() => { setOpen(false); pillRef.current?.focus(); }}>
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
        </div>
      ) : null}
    </div>
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
