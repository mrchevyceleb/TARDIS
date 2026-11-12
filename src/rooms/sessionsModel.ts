// How a T3 Code session reads at a glance on the Sessions tab: its subject,
// its state word, its model's name, its pull requests, and which teammate's
// band it sits in. Pure functions, no React.

import type { T3PullRequest, T3SessionPhase, T3SessionRow } from '../data/api';
import { fmtClock } from '../chat/components/jobs/format';

/** A session that just finished stays with the live work this long, so a finish is seen happen. */
export const JUST_FINISHED_MS = 3 * 60_000;

/** "claude-opus-5-5" → "Opus 5.5", "gpt-6.1-sol" → "GPT-6.1 Sol",
 *  "openrouter/google/gemini-4-argon" → "Gemini 4 Argon". */
export function modelLabel(model: string): string {
  const tokens = (model.split('/').pop() ?? model).split('-').filter(Boolean);
  if (tokens[0]?.toLowerCase() === 'claude' && tokens.length > 1) tokens.shift();
  const merged: string[] = [];
  for (const token of tokens) {
    const prev = merged.at(-1);
    // Claude versions arrive split by hyphens: opus-5-5 is Opus 5.5.
    if (prev && /^\d+$/.test(token) && /^\d+$/.test(prev)) merged[merged.length - 1] = `${prev}.${token}`;
    else merged.push(token);
  }
  const words = merged.map((word) => (word.toLowerCase() === 'gpt' ? 'GPT' : word.charAt(0).toUpperCase() + word.slice(1)));
  return words.join(' ').replace(/^GPT (\d)/, 'GPT-$1');
}

/** A title often leads with a progress note and ends with its Desk card:
 *  "ROOT CAUSE · Subject (card-1a2b3c)". The subject is what the session is
 *  working on, so it always gets the room; the note and card ride along. */
export function splitTitle(title: string): { headline: string; note?: string; card?: string } {
  let rest = title.trim();
  let card: string | undefined;
  const cardMatch = /\s*\((card-[0-9a-f]+)\)?\s*$/i.exec(rest);
  if (cardMatch && cardMatch.index > 0) {
    card = cardMatch[1];
    rest = rest.slice(0, cardMatch.index);
  }
  const parts = rest.split(' · ').map((part) => part.trim()).filter(Boolean);
  const headline = parts.pop() || title.trim();
  return { headline, ...(parts.length ? { note: parts.join(' · ') } : {}), ...(card ? { card } : {}) };
}

/** A running span: 4:07 under an hour (it ticks), then 3h 12m, then 2d 5h. */
export function fmtSpan(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 60) return fmtClock(ms);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** just now, 4m ago, 2h ago, 3d ago */
export function fmtAgo(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

/** The colour family a session wears. */
export type Tone = 'run' | 'warm' | 'wait' | 'done' | 'fail' | 'off';

const STARTING = new Set(['preparing', 'queued', 'starting']);

export function toneOf(row: T3SessionRow): Tone {
  if (row.phase === 'working') return STARTING.has(row.status) ? 'warm' : 'run';
  if (row.phase === 'waiting') return 'wait';
  return row.status === 'completed' ? 'done' : row.status === 'failed' ? 'fail' : 'off';
}

/** The word on the state chip. */
export function stateWord(row: T3SessionRow): string {
  if (row.phase === 'working') return STARTING.has(row.status) ? 'Starting' : 'Working';
  if (row.phase === 'waiting') return 'Waiting';
  switch (row.status) {
    case 'failed': return 'Failed';
    case 'interrupted': case 'cancelled': return 'Stopped';
    case 'rolled_back': return 'Rolled back';
    case 'idle': return 'Idle';
    default: return 'Finished';
  }
}

/** A session's pull requests with real links: open ones first (they still
 *  need something), then newest first. T3 lists them oldest first. */
export function orderPrs(prs: T3PullRequest[] | undefined): T3PullRequest[] {
  const newestFirst = (prs ?? []).filter((pr) => safeHref(pr.url)).reverse();
  return [...newestFirst.filter((pr) => pr.state === 'open'), ...newestFirst.filter((pr) => pr.state !== 'open')];
}

/** "18 merged" or "3 merged, 1 closed". */
export function prStates(prs: T3PullRequest[]): string {
  const counts = new Map<string, number>();
  for (const pr of prs) counts.set(pr.state, (counts.get(pr.state) ?? 0) + 1);
  return [...counts].map(([state, count]) => `${count} ${state}`).join(', ');
}

/** The state every one of these pull requests is in ("merged"), if they share one. */
export function sharedState(prs: T3PullRequest[]): string | undefined {
  const states = new Set(prs.map((pr) => pr.state));
  return states.size === 1 ? prs[0].state : undefined;
}

export type Counts = Record<T3SessionPhase, number>;

export type Band = {
  ownerId: string;
  /** Waiting (longest wait first), working (newest first), then just finished (newest first). */
  live: T3SessionRow[];
  /** Finished before the just-finished window, newest first. */
  finished: T3SessionRow[];
  counts: Counts;
};

export function countPhases(rows: T3SessionRow[]): Counts {
  const counts: Counts = { working: 0, waiting: 0, finished: 0 };
  for (const row of rows) counts[row.phase] += 1;
  return counts;
}

/** One band per teammate with sessions, in roster order, teammates with live
 *  work first. A filter keeps only that phase; under the Finished filter
 *  every finished session is listed, just-finished ones included. */
export function bandsOf(rows: T3SessionRow[], now: number, filter: T3SessionPhase | null, rosterIndex: (ownerId: string) => number): Band[] {
  const byOwner = new Map<string, T3SessionRow[]>();
  for (const row of rows) {
    const own = byOwner.get(row.ownerId);
    if (own) own.push(row);
    else byOwner.set(row.ownerId, [row]);
  }
  const bands: Band[] = [];
  for (const [ownerId, own] of byOwner) {
    const counts = countPhases(own);
    const of = (phase: T3SessionPhase) => own.filter((row) => row.phase === phase);
    const waiting = of('waiting').sort((a, b) => a.since - b.since);
    const working = of('working').sort((a, b) => b.since - a.since);
    const done = of('finished').sort((a, b) => b.since - a.since);
    const fresh = done.filter((row) => now - row.since < JUST_FINISHED_MS);
    const band: Band = filter === 'working' ? { ownerId, live: working, finished: [], counts }
      : filter === 'waiting' ? { ownerId, live: waiting, finished: [], counts }
        : filter === 'finished' ? { ownerId, live: [], finished: done, counts }
          : { ownerId, live: [...waiting, ...working, ...fresh], finished: done.filter((row) => !fresh.includes(row)), counts };
    if (band.live.length || band.finished.length) bands.push(band);
  }
  const busy = (band: Band) => (band.counts.working + band.counts.waiting > 0 ? 0 : 1);
  return bands.sort((a, b) => busy(a) - busy(b) || rosterIndex(a.ownerId) - rosterIndex(b.ownerId) || a.ownerId.localeCompare(b.ownerId));
}

/** A teammate the roster does not know (yet): "chief-of-staff" → "Chief of staff". */
export function fallbackName(ownerId: string): string {
  const words = ownerId.replace(/[-_]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Unknown';
}

/** "devbox" → "Devbox". Host names come from the deployment's own config. */
export const hostLabel = (host: string): string => host.charAt(0).toUpperCase() + host.slice(1);

/** Only real web links are ever rendered as links. */
export const safeHref = (href: string | undefined): string | undefined => (href && /^https?:\/\//i.test(href) ? href : undefined);
