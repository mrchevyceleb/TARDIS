import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, CheckCircle2, Clock3, RefreshCw, TriangleAlert } from 'lucide-react';
import { fetchQaBoard, fetchQaSignInLinks, type QaItem, type QaSignInLink } from '../data/qa';
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

/** Landing page for a tester sign-in link (/qa-signin?d=...&s=...). The GET
 *  itself consumes nothing: link scanners and prefetchers can fetch this
 *  page harmlessly, and even a scanner that runs the page's scripts finds
 *  only a button. The exchange POST fires on the tester's own tap, once,
 *  for the HttpOnly session; success sends them to their board. */
export function QaSignInLanding() {
  const [state, setState] = useState<'ready' | 'working' | 'failed'>('ready');
  const [credentials] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return { d: params.get('d') ?? '', s: params.get('s') ?? '' };
  });
  const usable = Boolean(credentials.d && credentials.s);
  return (
    <div className="qa-board">
      <header className="qa-head">
        <div>
          <p className="qa-eyebrow">Rally QA</p>
          <h2>{state === 'failed' || !usable ? 'This sign-in link has expired' : state === 'working' ? 'Signing you in…' : 'Your QA list is ready'}</h2>
          <p className="qa-sub">{state === 'working'
            ? 'One moment while we open your list.'
            : state === 'failed' || !usable
              ? 'Ask for a fresh link.'
              : 'Tap below to open your list. The link works once.'}</p>
          {usable && state !== 'failed' ? (
            <button
              type="button"
              className="qa-refresh"
              disabled={state === 'working'}
              onClick={() => {
                setState('working');
                void fetch('/api/qa/auth/exchange', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(credentials),
                }).then((res) => {
                  if (res.ok) window.location.replace('/qa-board');
                  else setState('failed');
                }).catch(() => setState('failed'));
              }}
            >
              Sign in
            </button>
          ) : null}
        </div>
      </header>
    </div>
  );
}

/** `tester` is the bare page testers get on the public QA address: the whole
 *  board with their own column first, and no operator controls. */
export function QaBoard({ tester = false }: { tester?: boolean } = {}) {
  const [now, setNow] = useState(() => Date.now());
  const [links, setLinks] = useState<QaSignInLink[] | null>(null);
  const [copied, setCopied] = useState('');
  const [linkError, setLinkError] = useState('');
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
        <div className="qa-head-actions">
          {tester ? null : <button className="qa-refresh" onClick={async () => {
            setLinkError('');
            try { setLinks((await fetchQaSignInLinks()).links); }
            catch { setLinkError('Links are operator-only.'); }
          }} aria-label="Get tester sign-in links">
            <ArrowUpRight size={15} /> Tester links
          </button>}
          <button className="qa-refresh" onClick={() => board.refetch()} disabled={board.isFetching} aria-label="Refresh the QA board">
            <RefreshCw size={15} className={board.isFetching ? 'qa-spin' : ''} /> Refresh
          </button>
        </div>
      </header>

      {linkError ? <p className="qa-state qa-state-error"><TriangleAlert size={15} /> {linkError}</p> : null}
      {links ? (
        <div className="qa-links-panel">
          <p>Fresh single-use sign-in links (good for 7 days, one sign-in each). Copy the link for the tester and hand it over.</p>
          {links.map((link) => (
            <div key={link.id} className="qa-link-row">
              <span>{link.name}</span>
              <code>{link.url ?? `${window.location.origin}${link.path}`}</code>
              <button type="button" onClick={async () => {
                try { await navigator.clipboard.writeText(link.url ?? `${window.location.origin}${link.path}`); setCopied(link.id); }
                catch { setCopied(''); }
              }}>{copied === link.id ? 'Copied' : 'Copy'}</button>
            </div>
          ))}
        </div>
      ) : null}

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
                  <h3>{col.name}{col.id === board.data?.me ? ' (you)' : ''}</h3>
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
                        {/* Every card links to its PR; the Slack thread joins it once the
                            item has been posted for testing. */}
                        <a className="qa-slack qa-pr" href={`https://github.com/${item.repo}/pull/${item.pr}`} target="_blank" rel="noreferrer">Open PR #{item.pr} <ArrowUpRight size={13} /></a>
                        {item.slackThreadUrl ? (
                          <a className="qa-slack" href={item.slackThreadUrl} target="_blank" rel="noreferrer">Open Slack thread <ArrowUpRight size={13} /></a>
                        ) : null}
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
