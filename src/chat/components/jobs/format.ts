// Wording and parsing helpers for the background-jobs UI.

import type { JobState, JobView } from '../../hooks/useJobs';

export type JobTone = 'run' | 'ok' | 'bad' | 'warn' | 'note';

/** m:ss, or h:mm:ss past an hour. Never negative. */
export function fmtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** 9:41 PM style, local time. */
export function fmtTime(ts: number): string {
  const d = new Date(ts);
  if (!Number.isFinite(ts) || ts <= 0 || !Number.isFinite(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hourCycle: 'h12' });
}

export function jobTone(state: JobState): JobTone {
  switch (state) {
    case 'running': return 'run';
    case 'finished': return 'ok';
    case 'failed':
    case 'lost': return 'bad';
    default: return 'warn';
  }
}

/** The outcome in the words the UI uses: finished, failed exit 2, stopped... */
export function jobOutcome(job: Pick<JobView, 'state' | 'exitCode'>): string {
  switch (job.state) {
    case 'running': return 'running';
    case 'finished': return 'finished';
    case 'failed': return job.exitCode === null ? 'failed' : `failed exit ${job.exitCode}`;
    case 'stopped': return 'stopped';
    case 'timed-out': return 'timed out';
    default: return 'lost';
  }
}

// ---- job result messages ---------------------------------------------------------
// The server wakes the agent with a peer message from role "automation" whose
// text is `[job: NAME] Job "NAME" <outcome>` (job_start) or `Your job "NAME"
// <outcome>` (watch_job), then `Last output:` and the tail. Older deliveries
// carry only `job: NAME`.

export function isJobResultPeer(fromRole: string | undefined, text: string): boolean {
  if ((fromRole ?? '').trim().toLowerCase() !== 'automation') return false;
  const t = text.trimStart();
  return /^\[job:\s/.test(t) || /^job:\s/.test(t);
}

export type JobResult = {
  name: string;
  label: string;
  tone: JobTone;
  duration: string;
  /** Last output lines, empty when the message carried none. */
  output: string;
  /** The final non-empty output line, for the collapsed row. */
  peek: string;
};

const DURATION = /\b(?:in|after)\s+(\d+h\s+\d+m|\d+m\s+\d+s|\d+m|\d+s)\b/;

function classify(outcome: string): { label: string; tone: JobTone } {
  const o = outcome.toLowerCase();
  const exit = /\bexit\s+(-?\d+)/.exec(o);
  if (/^failed\b/.test(o)) return { label: exit ? `failed exit ${exit[1]}` : 'failed', tone: 'bad' };
  if (/^finished\b/.test(o)) {
    if (exit && Number(exit[1]) !== 0) return { label: `failed exit ${exit[1]}`, tone: 'bad' };
    return { label: 'finished', tone: 'ok' };
  }
  if (/^was not reported finished/.test(o)) return { label: 'unconfirmed', tone: 'warn' };
  if (/^was stopped/.test(o)) return { label: 'stopped', tone: 'warn' };
  if (/^timed out/.test(o)) return { label: 'timed out', tone: 'warn' };
  if (/^is gone/.test(o)) return { label: 'lost', tone: 'bad' };
  return { label: 'update', tone: 'note' };
}

export function parseJobResult(text: string, from?: string): JobResult {
  const lines = text.replace(/\r/g, '').split('\n');
  const first = lines[0] ?? '';
  const fromName = from?.replace(/^\s*⏱\s*/, '').trim();
  const headerName = /^\s*\[job:\s*(.*?)\]\s+(?:Your job|Job)\s+"/.exec(first)?.[1]
    ?? /^\s*job:\s*(.+)$/.exec(first)?.[1];
  const name = (fromName || headerName || 'job').trim();

  const quoted = first.indexOf(`"${name}" `);
  const outcome = quoted >= 0 ? first.slice(quoted + name.length + 3) : '';
  const { label, tone } = outcome ? classify(outcome) : { label: 'update', tone: 'note' as JobTone };
  const duration = DURATION.exec(outcome)?.[1] ?? '';

  let output = '';
  const at = lines.findIndex((line) => line.trim() === 'Last output:');
  if (at >= 0) {
    const tail: string[] = [];
    for (const line of lines.slice(at + 1)) {
      if (/^Full log:/.test(line) || /^Background job (?:result|wake) from /.test(line)) break;
      tail.push(line);
    }
    while (tail.length && !tail[tail.length - 1].trim()) tail.pop();
    output = tail.join('\n');
  }
  const peek = output.split('\n').reverse().find((line) => line.trim())?.trim() ?? '';
  return { name, label, tone, duration, output, peek };
}
