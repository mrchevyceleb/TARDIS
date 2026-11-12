// The pieces of the Sessions tab: a session's card and its finished row, the
// state and pull-request chips, a teammate's avatar, the live pill and the
// phase filters. One shared ticker per beat keeps every clock in step.

import { useCallback, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { ArrowUpRight, CircleCheck, CircleSlash, CircleX, GitMerge, GitPullRequest, GitPullRequestClosed, Server } from 'lucide-react';
import type { T3PullRequest, T3SessionPhase, T3SessionRow } from '../data/api';
import { agentAvatarUrl, agentColor, DISC_INK, type Agent } from '../grok/agents';
import { T3Orbit } from '../grok/T3Sessions';
import { fmtAgo, fmtSpan, hostLabel, modelLabel, orderPrs, prStates, safeHref, sharedState, splitTitle, stateWord, toneOf, type Counts, type Tone } from './sessionsModel';

type Ticker = { now: number; listeners: Set<() => void>; timer?: number };
const tickers = new Map<number, Ticker>();

function tickerFor(step: number): Ticker {
  let ticker = tickers.get(step);
  if (!ticker) tickers.set(step, ticker = { now: Date.now(), listeners: new Set() });
  return ticker;
}

function subscribe(step: number, listener: () => void): () => void {
  const ticker = tickerFor(step);
  ticker.listeners.add(listener);
  if (ticker.timer === undefined) {
    ticker.now = Date.now();
    ticker.timer = window.setInterval(() => {
      ticker.now = Date.now();
      for (const notify of ticker.listeners) notify();
    }, step);
  }
  return () => {
    ticker.listeners.delete(listener);
    if (ticker.listeners.size) return;
    window.clearInterval(ticker.timer);
    tickers.delete(step);
  };
}

/** Now, refreshed every `step` ms. Every caller on the same step shares one timer. */
export function useNow(step: number): number {
  const listen = useCallback((listener: () => void) => subscribe(step, listener), [step]);
  return useSyncExternalStore(listen, () => tickerFor(step).now);
}

/** How long a session has been where it is: a ticking clock while it runs or
 *  waits, "4m ago" once it finished. */
function Since({ row, skewMs }: { row: T3SessionRow; skewMs: number }) {
  const live = row.phase !== 'finished';
  const now = useNow(live ? 1_000 : 15_000) + skewMs;
  return (
    <time className="ses-since" dateTime={new Date(row.since).toISOString()}>
      {live ? fmtSpan(now - row.since) : fmtAgo(now - row.since)}
    </time>
  );
}

function StateGlyph({ tone }: { tone: Tone }) {
  if (tone === 'done') return <CircleCheck className="ses-glyph" size={14} aria-hidden="true" />;
  if (tone === 'fail') return <CircleX className="ses-glyph" size={14} aria-hidden="true" />;
  if (tone === 'off') return <CircleSlash className="ses-glyph" size={14} aria-hidden="true" />;
  return <span className="ses-orbit"><T3Orbit /></span>;
}

function StateChip({ row, ownerName, skewMs }: { row: T3SessionRow; ownerName: string; skewMs: number }) {
  return (
    <span className="ses-state">
      <StateGlyph tone={toneOf(row)} />
      <span className="ses-state-word">{row.phase === 'waiting' ? `Waiting on ${ownerName}` : stateWord(row)}</span>
      <Since row={row} skewMs={skewMs} />
    </span>
  );
}

const PR_ICONS = { merged: GitMerge, closed: GitPullRequestClosed } as const;

function PrChip({ pr }: { pr: T3PullRequest }) {
  const Icon = PR_ICONS[pr.state as keyof typeof PR_ICONS] ?? GitPullRequest;
  return (
    <a className={`ses-pr is-${pr.state}`} href={pr.url} target="_blank" rel="noopener noreferrer" title={`${pr.repo ? `${pr.repo} ` : ''}#${pr.number}: ${pr.state}`}>
      <Icon size={12} aria-hidden="true" />
      #{pr.number} {pr.state}
    </a>
  );
}

/** Every pull request is its own chip. A long list shows its first `shown`
 *  and a "+N" chip that opens the rest in place; one more never hides behind it. */
function PrChips({ prs, shown, terse = false }: { prs?: T3PullRequest[]; shown: number; terse?: boolean }) {
  const [open, setOpen] = useState(false);
  const list = orderPrs(prs);
  if (!list.length) return null;
  const rest = list.slice(shown);
  if (rest.length < 2) return <span className="ses-prs">{list.map((pr) => <PrChip key={pr.url} pr={pr} />)}</span>;
  return (
    <span className="ses-prs">
      {(open ? list : list.slice(0, shown)).map((pr) => <PrChip key={pr.url} pr={pr} />)}
      <button
        type="button"
        className="ses-pr-more"
        aria-expanded={open}
        aria-label={open ? 'Show fewer pull requests' : `Show ${rest.length} more pull requests: ${prStates(rest)}`}
        title={open ? undefined : prStates(rest)}
        onClick={() => setOpen((was) => !was)}
      >
        {open ? 'Fewer' : terse ? `+${rest.length}` : `+${rest.length} ${sharedState(rest) ?? 'more'}`}
      </button>
    </span>
  );
}

/** A session that is running, waiting, or just finished. The whole card opens it in T3. */
export function SessionCard({ row, ownerName, skewMs, index }: { row: T3SessionRow; ownerName: string; skewMs: number; index: number }) {
  const { headline, note } = splitTitle(row.title);
  const link = safeHref(row.link);
  return (
    <article className={`ses-card is-${toneOf(row)}`} title={row.title} style={{ '--i': index } as CSSProperties}>
      <div className="ses-card-top">
        <StateChip row={row} ownerName={ownerName} skewMs={skewMs} />
        {link ? <ArrowUpRight className="ses-go" size={16} aria-hidden="true" /> : null}
      </div>
      {note ? <p className="ses-note">{note}</p> : null}
      <h3 className="ses-head">
        {link ? <a className="ses-link" href={link} target="_blank" rel="noopener noreferrer">{headline}</a> : headline}
      </h3>
      <div className="ses-meta">
        <span className="ses-host"><Server size={12} aria-hidden="true" />{hostLabel(row.host)}</span>
        {row.model ? <span className="ses-model" title={row.model}>{modelLabel(row.model)}</span> : null}
        <PrChips prs={row.pullRequests} shown={2} />
      </div>
    </article>
  );
}

/** A finished session: one line on a wide screen (its columns line up with
 *  the rows around it), title over machine, model and PR on a phone. */
export function FinishedRow({ row, skewMs }: { row: T3SessionRow; skewMs: number }) {
  const { headline } = splitTitle(row.title);
  const link = safeHref(row.link);
  const tone = toneOf(row);
  return (
    <li className={`ses-row is-${tone}`} title={row.title}>
      <StateGlyph tone={tone} />
      <span className="ses-sr">{stateWord(row)}: </span>
      {link
        ? <a className="ses-link ses-row-title" href={link} target="_blank" rel="noopener noreferrer">{headline}</a>
        : <span className="ses-row-title">{headline}</span>}
      <span className="ses-row-info">
        <span className="ses-row-meta">{hostLabel(row.host)}{row.model ? ` · ${modelLabel(row.model)}` : ''}</span>
        <span className="ses-row-pr"><PrChips prs={row.pullRequests} shown={1} terse /></span>
      </span>
      <Since row={row} skewMs={skewMs} />
    </li>
  );
}

export function Avatar({ agent, name }: { agent?: Agent; name: string }) {
  const url = agent ? agentAvatarUrl(agent) : null;
  return (
    <span className="ses-avatar" style={{ background: agentColor(name), color: DISC_INK }} aria-hidden="true">
      {url ? <img src={url} alt="" /> : name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export type LiveState = 'live' | 'connecting' | 'offline';
const LIVE_WORDS: Record<LiveState, string> = { live: 'Live', connecting: 'Connecting', offline: 'Reconnecting' };

/** Its dot pings once per fresh answer from the server, so a quiet dot means a stalled feed. */
export function LivePill({ state, beat, detail }: { state: LiveState; beat: number; detail: string }) {
  return (
    <span className={`ses-live is-${state}`} role="status" title={detail}>
      <span key={beat} className="ses-live-dot" aria-hidden="true" />
      {LIVE_WORDS[state]}
    </span>
  );
}

const FILTERS: Array<{ phase: T3SessionPhase; label: string }> = [
  { phase: 'working', label: 'Working' },
  { phase: 'waiting', label: 'Waiting' },
  { phase: 'finished', label: 'Finished' },
];

/** Tap a phase to see only it; tap it again for everything. */
export function PhaseFilters({ counts, filter, onFilter }: { counts: Counts; filter: T3SessionPhase | null; onFilter: (next: T3SessionPhase | null) => void }) {
  return (
    <div className="ses-filters" role="group" aria-label="Show only sessions that are">
      {FILTERS.map(({ phase, label }) => (
        <button
          key={phase}
          type="button"
          className={`ses-filter is-${phase}`}
          aria-pressed={filter === phase}
          onClick={() => onFilter(filter === phase ? null : phase)}
        >
          <span key={counts[phase]} className="ses-filter-count">{counts[phase]}</span>
          <span className="ses-filter-label">{label}</span>
        </button>
      ))}
    </div>
  );
}
