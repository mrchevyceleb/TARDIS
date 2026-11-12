// Sessions: every T3 Code session the team has going, one band per teammate
// who started one. Waiting and working sessions lead each band; finished ones
// fold away under a single line. The feed is polled every 5s while the tab is
// visible, so it never needs a refresh. Server: routes/t3Sessions.ts (/all).

import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, CircleCheck, CloudOff } from 'lucide-react';
import { apiJson, fetchAllT3Sessions, type T3SessionPhase } from '../data/api';
import type { Agent } from '../grok/agents';
import { T3Orbit } from '../grok/T3Sessions';
import { RoomHeader } from '../components/RoomHeader';
import { ROOM_NAMES } from '../data/roomNames';
import { useMediaQuery } from '../chat/hooks/useMediaQuery';
import { bandsOf, countPhases, fallbackName, fmtAgo, hostLabel, type Band } from './sessionsModel';
import { Avatar, FinishedRow, LivePill, PhaseFilters, SessionCard, useNow, type LiveState } from './sessionsParts';
import './sessions.css';

const PHONE = '(max-width: 760px), (pointer: coarse) and (max-width: 1180px)';
/** Finished rows shown per band before "Show more". */
const FINISHED_PAGE = 12;

function useAllSessions() {
  return useQuery({
    queryKey: ['t3-sessions-all'],
    queryFn: async ({ signal }) => {
      const data = await fetchAllT3Sessions(signal);
      return { ...data, skewMs: data.now - Date.now() };
    },
    refetchInterval: (query) => (query.state.data?.configured === false ? false : 5_000),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: 'always',
    staleTime: 1_000,
    retry: false,
  });
}

/** Names and faces. A teammate the roster has not caught up on yet still gets a band. */
function useRoster(): Agent[] {
  const query = useQuery({
    queryKey: ['sessions-roster'],
    queryFn: ({ signal }) => apiJson<{ agents: Agent[] }>('/api/agents', { signal }),
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
  return query.data?.agents ?? [];
}

function Empty({ title, text, orbit, children }: { title: string; text?: string; orbit?: boolean; children?: ReactNode }) {
  return (
    <div className="ses-empty">
      {orbit ? <span className="ses-empty-orbit"><T3Orbit /></span> : null}
      <p className="ses-empty-title">{title}</p>
      {text ? <p className="ses-empty-text">{text}</p> : null}
      {children}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="ses-skeleton" aria-busy="true" aria-label="Loading sessions">
      {[3, 2].map((cards, band) => (
        <div key={band} className="ses-band">
          <div className="ses-band-head"><span className="ses-avatar ses-shimmer" /><span className="ses-sk-name ses-shimmer" /></div>
          <div className="ses-grid">{Array.from({ length: cards }, (_, i) => <div key={i} className="ses-sk-card ses-shimmer" />)}</div>
        </div>
      ))}
    </div>
  );
}

type BandProps = {
  band: Band;
  agent?: Agent;
  filter: T3SessionPhase | null;
  open: boolean;
  onToggle: () => void;
  shown: number;
  onMore: () => void;
  skewMs: number;
  now: number;
};

function BandView({ band, agent, filter, open, onToggle, shown, onMore, skewMs, now }: BandProps) {
  const name = agent?.name ?? fallbackName(band.ownerId);
  const headId = `ses-band-${band.ownerId}`;
  const listId = `ses-done-${band.ownerId}`;
  const { working, waiting } = band.counts;
  // The head counts what the filter shows: running work by default, else just that phase.
  const tally = (filter ? [filter] : (['waiting', 'working'] as const)).filter((phase) => band.counts[phase]);
  const showFinished = filter === 'finished' || open;
  const finished = band.finished.slice(0, shown);
  const left = band.finished.length - finished.length;
  return (
    <section className={`ses-band${working + waiting ? ' is-busy' : ''}`} aria-labelledby={headId}>
      <header className="ses-band-head">
        <Avatar agent={agent} name={name} />
        <h2 id={headId} className="ses-band-name">{name}</h2>
        <span className="ses-band-counts">
          {tally.length
            ? tally.map((phase) => <span key={phase} className={`is-${phase}`}>{band.counts[phase]} {phase}</span>)
            : <span>Nothing running</span>}
        </span>
      </header>
      {band.live.length ? (
        <div className="ses-grid">
          {band.live.map((row, index) => <SessionCard key={row.id} row={row} ownerName={name} skewMs={skewMs} index={index} />)}
        </div>
      ) : null}
      {band.finished.length ? (
        // Folded: one dashed line. Open: a panel, the line as its header.
        <div className={`ses-done${showFinished ? ' is-open' : ''}`}>
          {filter !== 'finished' ? (
            <button type="button" className="ses-fold" aria-expanded={open} aria-controls={listId} onClick={onToggle}>
              <CircleCheck size={15} aria-hidden="true" />
              <span>{band.finished.length} finished</span>
              <span className="ses-fold-last">last {fmtAgo(now - band.finished[0].since)}</span>
              <ChevronDown className="ses-chev" size={16} aria-hidden="true" />
            </button>
          ) : null}
          {showFinished ? (
            <>
              <ul id={listId} className="ses-rows">
                {finished.map((row) => <FinishedRow key={row.id} row={row} skewMs={skewMs} />)}
              </ul>
              {left > 0 ? <button type="button" className="ses-more" onClick={onMore}>Show {Math.min(left, FINISHED_PAGE)} more <span>· {left} left</span></button> : null}
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function Sessions() {
  const isPhone = useMediaQuery(PHONE);
  const query = useAllSessions();
  const agents = useRoster();
  const [filter, setFilter] = useState<T3SessionPhase | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [shown, setShown] = useState<Readonly<Record<string, number>>>({});
  const data = query.data;
  const skewMs = data?.skewMs ?? 0;
  // Coarse on purpose: it only decides when a just-finished session folds away.
  const now = useNow(15_000) + skewMs;
  const rows = useMemo(() => data?.sessions ?? [], [data]);
  const counts = useMemo(() => countPhases(rows), [rows]);
  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const bands = useMemo(() => {
    const order = new Map(agents.map((agent, index) => [agent.id, index]));
    return bandsOf(rows, now, filter, (id) => order.get(id) ?? Number.MAX_SAFE_INTEGER);
  }, [rows, now, filter, agents]);

  const hosts = data?.hosts ?? [];
  const downHosts = hosts.filter((host) => !host.reachable && rows.some((row) => row.host === host.name));
  const liveState: LiveState = query.isError ? 'offline' : data ? 'live' : 'connecting';
  const detail = [
    query.isError ? 'Not answering, retrying every 5 seconds' : 'Updates every 5 seconds',
    ...hosts.map((host) => `${hostLabel(host.name)}: ${!host.reachable ? 'not answering' : host.seenAt ? 'reading' : 'not read yet'}`),
  ].join(' · ');

  // A new filter starts at the top of its list if the reader had scrolled into
  // the old one. The phone scrolls the room itself; desktop scrolls under the
  // bar. The jump waits for the new list to be on screen: made any earlier,
  // the browser holds the reader's place in the old list and carries them
  // down past whatever the new one puts above it.
  const scrollRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const bandsRef = useRef<HTMLDivElement>(null);
  const rewind = useRef(false);
  const pickFilter = (next: T3SessionPhase | null) => {
    const list = bandsRef.current;
    const edge = isPhone ? scrollRef.current?.getBoundingClientRect().top : barRef.current?.getBoundingClientRect().bottom;
    rewind.current = Boolean(list && edge !== undefined && list.getBoundingClientRect().top < edge - 1);
    setFilter(next);
  };
  useLayoutEffect(() => {
    if (!rewind.current) return;
    rewind.current = false;
    bandsRef.current?.scrollIntoView({ block: 'start' });
  }, [filter]);

  const toggle = (ownerId: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (!next.delete(ownerId)) next.add(ownerId);
    return next;
  });

  let body: ReactNode;
  if (!data) {
    body = query.isError
      ? <Empty title="Can't reach TARDIS right now" text="Trying again every few seconds." />
      : <Skeleton />;
  } else if (!data.configured) {
    body = <Empty orbit title="No T3 host is set up" text="Name one in RIVENDELL_T3_HOSTS and every teammate's sessions show up here." />;
  } else if (!rows.length) {
    body = <Empty orbit title="No sessions yet" text="When a teammate starts a T3 session, it shows up here, live." />;
  } else if (!bands.length) {
    body = (
      <Empty title={`Nothing ${filter} right now`}>
        <button type="button" className="ses-reset" onClick={() => pickFilter(null)}>Show everything</button>
      </Empty>
    );
  } else {
    body = bands.map((band) => (
      <BandView
        key={band.ownerId}
        band={band}
        agent={agentById.get(band.ownerId)}
        filter={filter}
        open={open.has(band.ownerId)}
        onToggle={() => toggle(band.ownerId)}
        shown={shown[band.ownerId] ?? FINISHED_PAGE}
        onMore={() => setShown((prev) => ({ ...prev, [band.ownerId]: (prev[band.ownerId] ?? FINISHED_PAGE) + FINISHED_PAGE }))}
        skewMs={skewMs}
        now={now}
      />
    ));
  }

  const filters = rows.length ? <PhaseFilters counts={counts} filter={filter} onFilter={pickFilter} /> : null;
  return (
    <div className={`ses-room${isPhone ? ' is-phone' : ''}`}>
      <div ref={scrollRef} className="ses-scroll">
        <RoomHeader
          eyebrow={ROOM_NAMES.sessions.eyebrow}
          title={ROOM_NAMES.sessions.name}
          subtitle={ROOM_NAMES.sessions.tagline}
          actions={<LivePill state={liveState} beat={query.dataUpdatedAt} detail={detail} />}
        />
        {filters && !isPhone ? <div ref={barRef} className="ses-bar">{filters}</div> : null}
        {downHosts.map((host) => (
          <p key={host.name} className="ses-notice" role="status">
            <CloudOff size={16} aria-hidden="true" />
            <span>
              Can't reach {hostLabel(host.name)} right now. Its sessions show what was last seen
              {host.seenAt ? ` ${fmtAgo(now - host.seenAt)}` : ''}.
            </span>
          </p>
        ))}
        <div ref={bandsRef} className="ses-bands">{body}</div>
      </div>
      {filters && isPhone ? <div className="ses-dock">{filters}</div> : null}
    </div>
  );
}
