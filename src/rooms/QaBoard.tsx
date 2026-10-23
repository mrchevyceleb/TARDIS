import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, CheckCircle2, Clock3, RefreshCw, TriangleAlert } from 'lucide-react';
import { fetchQaBoard, type QaItem } from '../data/qa';
import './qa.css';

const STATUS: Record<QaItem['status'], { label: string; className: string }> = {
  up_next: { label: 'up next', className: 'qa-status-next' },
  testing: { label: 'testing', className: 'qa-status-testing' },
  fixing: { label: 'fixing', className: 'qa-status-fixing' },
  retest: { label: 'retest', className: 'qa-status-retest' },
  validated: { label: 'validated', className: 'qa-status-validated' },
};

const dueLabel = (dueAt: string, now: number) => {
  const at = Date.parse(dueAt);
  if (!Number.isFinite(at)) return 'no deadline';
  const mins = Math.round((at - now) / 60_000);
  const time = new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (mins < 0) return `overdue · was due ${time}`;
  if (mins < 60) return `due ${time} · ${mins}m left`;
  return `due ${time}`;
};

const TESTER_BLURB: Record<string, string> = {
  sud: 'Sud list · skips Edgar and Martin',
  edgar: 'Studio · 9 to 5',
  martin: 'Operly · 9 to 5',
};

export function QaBoard() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const board = useQuery({ queryKey: ['qa-board'], queryFn: ({ signal }) => fetchQaBoard(signal), staleTime: 15_000, refetchInterval: 30_000 });
  const columns = board.data?.testers ?? [];
  const openCount = useMemo(() => columns.reduce((sum, col) => sum + col.items.length, 0), [columns]);

  return (
    <div className="qa-board">
      <header className="qa-head">
        <div>
          <p className="qa-eyebrow">Rally QA</p>
          <h2>What to test next</h2>
          <p className="qa-sub">Each column is one tester&apos;s live list, in the order to work it. The highlighted card is the one to do now. Replies happen in Slack; this board just always matches it.</p>
        </div>
        <button className="qa-refresh" onClick={() => board.refetch()} disabled={board.isFetching} aria-label="Refresh the QA board">
          <RefreshCw size={15} className={board.isFetching ? 'qa-spin' : ''} /> Refresh
        </button>
      </header>

      {board.isPending ? <p className="qa-state">Loading the live lists…</p> : null}
      {board.isError ? (
        <p className="qa-state qa-state-error"><TriangleAlert size={15} /> The board could not load. Your Slack list is unchanged; try refresh in a moment.</p>
      ) : null}

      {board.data ? (
        <>
          <p className="qa-summary">{openCount} open item{openCount === 1 ? '' : 's'} across {columns.length} tester{columns.length === 1 ? '' : 's'}. Validated items drop off on their own.</p>
          <div className="qa-columns">
            {columns.map((col) => (
              <section key={col.id} className="qa-col" aria-label={`${col.name}'s QA list`}>
                <header className="qa-col-head">
                  <h3>{col.name}</h3>
                  <span>{col.items.length} open</span>
                </header>
                <p className="qa-col-blurb">{TESTER_BLURB[col.id]}</p>
                {col.items.length === 0 ? (
                  <p className="qa-empty"><CheckCircle2 size={15} /> All clear. New work lands here the moment it merges to staging.</p>
                ) : col.items.map((item, index) => {
                  const status = STATUS[item.status];
                  const overdue = Date.parse(item.dueAt) < now;
                  return (
                    <article key={item.id} className={`qa-card${index === 0 ? ' qa-card-now' : ''}`}>
                      {index === 0 ? <p className="qa-now">Do this one now</p> : null}
                      <h4>{item.title}</h4>
                      <p className="qa-meta">
                        <span className={`qa-status ${status.className}`}>{status.label}</span>
                        <span className={`qa-due${overdue ? ' qa-due-over' : ''}`}><Clock3 size={12} /> {dueLabel(item.dueAt, now)}</span>
                        <span className="qa-app">{item.app}</span>
                      </p>
                      <p className="qa-links">
                        {item.slackThreadUrl ? (
                          <a className="qa-slack" href={item.slackThreadUrl} target="_blank" rel="noreferrer">Open Slack thread <ArrowUpRight size={13} /></a>
                        ) : (
                          <span className="qa-no-thread">Slack thread opens with the item</span>
                        )}
                        {item.stagingUrl ? <a className="qa-staging" href={item.stagingUrl} target="_blank" rel="noreferrer">Open on staging</a> : null}
                      </p>
                    </article>
                  );
                })}
              </section>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
