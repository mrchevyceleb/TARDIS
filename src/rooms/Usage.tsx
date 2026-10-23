import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, ArrowDownUp, ArrowUpRight, Check, ChevronDown, Clock3, Flame, Gauge, Pin, RefreshCw, Search, Sparkles, TriangleAlert } from 'lucide-react';
import { fetchUsage, type UsageAccount, type UsageWindow } from '../data/usage';
import './usage.css';

const count = (value: number, digits = 1) => new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(value);
function money(value: number, currency: string): string {
  const tiny = value !== 0 && Math.abs(value) < 0.01;
  const formatter = new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: tiny ? 6 : 2 });
  return tiny && Math.abs(value) < 0.000001 ? (value < 0 ? '-' : '') + '< ' + formatter.format(0.000001) : formatter.format(value);
}
const exactTime = (value: string) => new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
const usagePercent = (w: UsageWindow) => w.limit > 0 ? w.used / w.limit * 100 : 0;
const quotaWindows = (a: UsageAccount) => a.windows.filter(w => w.unit !== 'credits');
const pressure = (a: UsageAccount) => Math.max(0, ...quotaWindows(a).filter(w => w.active !== false).map(usagePercent));
const runway = (a: UsageAccount) => (a.pace || []).filter(p => p.minutesLeft !== null).sort((a, b) => a.minutesLeft! - b.minutesLeft!)[0];
const needsAttention = (a: UsageAccount) => pressure(a) >= 85 || (runway(a)?.minutesLeft ?? Infinity) <= 180;
const urgency = (a: UsageAccount) => Math.max(pressure(a), (runway(a)?.minutesLeft ?? Infinity) <= 180 ? 400 - Math.min(180, runway(a)!.minutesLeft!) : 0);
const duration = (minutes: number) => minutes < 1 ? 'less than a minute' : minutes < 60 ? `${Math.max(1, Math.round(minutes))}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ${Math.round(minutes % 60)}m` : `${count(minutes / 1440)} days`;
const plainPeriod = (period: string) => period === 'Provider reporting period' ? 'Claude does not report the dates for this total' : period.replace('Current UTC day', 'Today (UTC)').replace('Current UTC month', 'Month to date (UTC)').replace('Whole billing account', 'Shared by all keys on this billing account');
const plainScope = (scope: string) => ({ key: 'This key', account: 'All keys on this billing account', subscription: 'This login' }[scope] || scope);
function tickerValue(a: UsageAccount): string {
  const p = runway(a); if (p && p.minutesLeft !== null) return duration(p.minutesLeft) + ' fuel';
  if (quotaWindows(a).length) return count(pressure(a)) + '% used';
  const m = a.amounts.find(m => /balance/i.test(m.label)) || a.amounts[0];
  return m ? money(m.amount, m.currency) : 'check provider';
}
const hue = (provider: string) => ({ Claude: 23, Codex: 157, OpenRouter: 264, Fireworks: 346, 'Z.ai': 216, Grok: 190, Gemini: 238, ElevenLabs: 64, fal: 300 }[provider] ?? 172);
const PIN_KEY = 'tardis:usage-pins';
function readPins(): string[] {
  try { const value: unknown = JSON.parse(localStorage.getItem(PIN_KEY) || '[]'); return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').slice(0, 100) : []; } catch { return []; }
}
function until(reset: string | null, time: number): string {
  if (!reset) return 'Reset not reported';
  const seconds = Math.ceil((Date.parse(reset) - time) / 1000);
  if (seconds <= 0) return 'Reset due · awaiting provider';
  const days = Math.floor(seconds / 86400), hours = Math.floor(seconds / 3600) % 24, minutes = Math.floor(seconds / 60) % 60;
  return 'Resets in ' + (days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m ${seconds % 60}s`);
}

function Quota({ window: w, time, remaining }: { window: UsageWindow; time: number; remaining: boolean }) {
  if (w.unit === 'credits') return <div className="usage-credit"><span>{w.label}</span><strong>{count(w.remaining, 2)} <small>credits</small></strong><span>Provider credits, no dollar value supplied</span></div>;
  const used = usagePercent(w), display = remaining ? Math.max(0, 100 - used) : used;
  return <div className={`usage-window${w.active === false ? ' usage-window-idle' : ''}`}>
    <div className="usage-window-title"><span>{w.label}</span><strong>{w.unit === 'percent' ? `${count(display)}% ${remaining ? 'left' : 'used'}` : `${count(remaining ? w.remaining : w.used, 0)} ${remaining ? 'left' : 'used'}`}</strong></div>
    <div className="usage-track" role="meter" aria-label={w.label + ' used'} aria-valuemin={0} aria-valuemax={Math.max(w.limit, w.used)} aria-valuenow={w.used} aria-valuetext={`${count(w.used)} ${w.unit} used, ${count(w.remaining)} remaining`}><span style={{ width: `${Math.min(100, Math.max(0, used))}%` }} /></div>
    <div className="usage-window-foot"><span title={w.resetsAt ? exactTime(w.resetsAt) : undefined}><Clock3 size={11} />{until(w.resetsAt, time)}</span>{w.active === false ? <span>Not active</span> : w.unit !== 'percent' ? <span>of {count(w.limit, 0)}</span> : <span>{count(w.used)}% used</span>}</div>
    {w.resetsAt && <time className="usage-reset-exact" dateTime={w.resetsAt}>{exactTime(w.resetsAt)}</time>}
  </div>;
}

function MasonryCell({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null), [rows, setRows] = useState(50);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) => setRows(Math.ceil((entry.contentRect.height + 16) / 8)));
    observer.observe(ref.current); return () => observer.disconnect();
  }, []);
  return <div className="usage-cell" style={{ gridRowEnd: `span ${rows}` }}><div ref={ref}>{children}</div></div>;
}

function AccountCard({ account: a, time, remaining, pinned, onPin, old, staleAfter, compact = false }: { account: UsageAccount; time: number; remaining: boolean; pinned: boolean; onPin: () => void; old: boolean; staleAfter: number; compact?: boolean }) {
  const [details, setDetails] = useState(false);
  const windows = quotaWindows(a), main = [...windows].sort((x, y) => Number(y.active !== false) - Number(x.active !== false) || usagePercent(y) - usagePercent(x))[0];
  const risk = pressure(a), stale = old || a.status === 'stale' || (a.checkedAt !== null && time - Date.parse(a.checkedAt) > staleAfter);
  const pace = runway(a) || (a.pace || [])[0], cashLow = !stale && a.status === 'live' && (pace?.minutesLeft ?? Infinity) <= 180;
  const state = a.status === 'unavailable' ? 'Check provider' : stale ? 'Last known' : cashLow ? pace?.minutesLeft === 0 ? 'Balance empty' : 'Short runway' : risk >= 100 ? 'At plan limit' : risk >= 85 ? 'Running low' : 'Live';
  const value = main ? (remaining ? Math.max(0, 100 - usagePercent(main)) : usagePercent(main)) : 0;
  const balance = a.amounts.find(m => /balance/i.test(m.label)) || a.amounts.find(m => /remaining/i.test(m.label));
  const lead = balance || a.amounts.find(m => /spend/i.test(m.label)) || a.amounts[0];
  const daily = a.amounts.find(m => m.label === 'Key spend' && m.period === 'Current UTC day'), monthly = a.amounts.find(m => m.label === 'Key spend' && m.period === 'Current UTC month');
  const matchingSpend = daily && monthly && daily.currency === monthly.currency && Math.abs(daily.amount - monthly.amount) < 0.00000001;
  const amounts = a.amounts.filter(m => !(matchingSpend && m === monthly) && (main || m !== lead)).map(m => ({ ...m,
    label: matchingSpend && m === daily ? 'Key spend: today and month to date' : m.label === 'Key spend' ? (m === daily ? 'Key spend today' : 'Key spend this month') : m.label,
    period: matchingSpend && m === daily ? 'Provider reports the same total for both; do not add them' : plainPeriod(m.period),
  }));
  return <article id={'usage-' + a.id} className={`usage-account${risk >= 85 || cashLow ? ' usage-account-warn' : ''}${compact ? ' usage-account-compact' : ''}`} style={{ '--usage-hue': hue(a.provider) } as CSSProperties} aria-label={`${a.provider} ${a.email || a.name}`}>
    <div className="usage-card-top"><span className="usage-provider-mark" aria-hidden="true">{a.provider === 'Claude' ? '✳' : a.provider.slice(0, 1)}</span><div><span className="usage-provider">{a.provider}</span><span className="usage-plan">{a.plan || (a.kind === 'subscription' ? 'Subscription' : 'API account')}</span></div><button className={`usage-pin${pinned ? ' on' : ''}`} onClick={onPin} aria-label={`${pinned ? 'Unpin' : 'Pin'} ${a.email || a.name}`} aria-pressed={pinned}><Pin size={15} /></button></div>
    <h2 title={a.email || a.name}>{a.email || a.name}</h2>
    <span className={`usage-feed-state${state === 'Live' ? ' is-live' : ''}${risk >= 85 || cashLow ? ' is-warn' : ''}`}>{state === 'Live' ? <span className="usage-live-dot" /> : <TriangleAlert size={11} />}{state}</span>
    {!compact && <>
      {main ? <div className="usage-gauge-head"><div className="usage-ring" aria-hidden="true"><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="42" /><circle cx="50" cy="50" r="42" pathLength="100" strokeDasharray={`${Math.min(100, Math.max(0, value))} 100`} /></svg><Gauge size={24} /></div><div><strong>{count(value)}<small>%</small></strong><span>{remaining ? 'remaining' : 'used'} · {main.label}</span></div></div>
        : lead ? <div className="usage-money-head"><strong>{money(lead.amount, lead.currency)}</strong><span>{lead.label}</span><small>{plainPeriod(lead.period)}</small></div>
        : a.windows.some(w => w.unit === 'credits') ? null : <p className="usage-note">The provider has not supplied an allowance or balance.</p>}
      {pace && <div className={`usage-pace${cashLow ? ' is-low' : ''}`}><Flame size={17} /><div><strong>{pace.minutesLeft !== null ? `About ${duration(pace.minutesLeft)} of fuel` : pace.perMinute > 0 ? `${money(pace.perMinute, pace.currency)}/min` : 'Balance holding steady'}</strong><span>{pace.perMinute > 0 ? `${money(pace.perMinute, pace.currency)}/min · ` : ''}{count(pace.observedMinutes)}m observed · {plainScope(pace.scope).toLowerCase()}</span><small>{pace.minutesLeft !== null ? 'Estimate if this pace continues. Billing can lag.' : 'Measured from recent provider readings.'}{stale ? ' Last known pace.' : ''}</small></div></div>}
      {!pace && balance && <p className="usage-measuring">Measuring spending pace. Needs two readings at least 45 seconds apart.</p>}
      <div className="usage-windows">{a.windows.map(w => <Quota key={w.id} window={w} time={time} remaining={remaining} />)}</div>
      {amounts.length > 0 && <dl className="usage-amounts">{amounts.map((m, index) => <div key={index}><dt>{m.label}<small>{m.period}{m.label.includes('Key spend') || /account/i.test(m.period) ? '' : ' · ' + plainScope(m.scope)}</small></dt><dd>{money(m.amount, m.currency)}</dd></div>)}</dl>}
    </>}
    {a.note && <p className="usage-note">{a.note}{a.provider === 'Claude' && a.amounts.length > 0 ? ' These are usage credits, not a subscription invoice. Claude does not report the dates for these totals.' : ''}</p>}
    {a.agents.length > 0 && <div className="usage-agents" aria-label="Agents on this account"><span>On this account</span><p>{a.agents.join(' · ')}</p></div>}
    <footer className="usage-card-footer"><button onClick={() => setDetails(v => !v)} aria-expanded={details}>Reading details<ChevronDown size={13} className={details ? 'rotated' : ''} /></button><a href={a.href} target="_blank" rel="noopener noreferrer">Open provider<ArrowUpRight size={13} /></a></footer>
    {details && <div className="usage-reading"><span>{a.source}</span><span>{a.checkedAt ? `Last success: ${exactTime(a.checkedAt)}` : 'No successful reading yet'}</span><span>Last attempt: {exactTime(a.attemptedAt)}</span><span>Subscription price and unreported costs are unknown.</span></div>}
  </article>;
}

export function Usage() {
  const manualRefresh = useRef(false);
  const query = useQuery({ queryKey: ['account-usage'], queryFn: ({ signal }) => fetchUsage(manualRefresh.current, signal), refetchInterval: 60_000, retry: false, staleTime: 30_000 });
  const [time, setTime] = useState(Date.now), [search, setSearch] = useState(''), [filter, setFilter] = useState('all'), [sort, setSort] = useState('attention');
  const [remaining, setRemaining] = useState(true), [pins, setPins] = useState(readPins), [spark, setSpark] = useState(0);
  useEffect(() => { const id = window.setInterval(() => setTime(Date.now()), 1000); return () => window.clearInterval(id); }, []);
  const old = query.isError, staleAfter = ((query.data?.refreshSeconds || 60) * 2 + 30) * 1000;
  const isFresh = (a: UsageAccount) => a.status === 'live' && !old && a.checkedAt !== null && time - Date.parse(a.checkedAt) <= staleAfter;
  const accounts = query.data?.accounts || [], live = accounts.filter(isFresh), limited = live.filter(needsAttention), missing = accounts.filter(a => a.status === 'unavailable');
  const visible = useMemo(() => accounts.filter(a => (filter === 'all' || filter === 'pinned' ? filter !== 'pinned' || pins.includes(a.id) : filter === 'attention' ? isFresh(a) && needsAttention(a) : a.kind === filter) && `${a.provider} ${a.name} ${a.email || ''} ${a.plan || ''} ${a.agents.join(' ')}`.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => Number(pins.includes(b.id)) - Number(pins.includes(a.id)) || (sort === 'attention' ? (isFresh(b) ? urgency(b) : -1) - (isFresh(a) ? urgency(a) : -1) : 0) || a.provider.localeCompare(b.provider) || (a.email || a.name).localeCompare(b.email || b.name)), [accounts, filter, search, pins, sort, time, old, staleAfter]);
  const togglePin = (id: string) => setPins(current => { const next = current.includes(id) ? current.filter(v => v !== id) : [...current, id]; try { localStorage.setItem(PIN_KEY, JSON.stringify(next)); } catch { /* Pins still work for this visit. */ } return next; });
  const refresh = async () => {
    manualRefresh.current = true;
    try { await query.refetch(); } finally { manualRefresh.current = false; }
  };
  const nextCheck = query.data ? Math.min(60, Math.max(0, Math.ceil((Math.max(query.dataUpdatedAt, query.errorUpdatedAt) + 60_000 - time) / 1000))) : 0;
  const reporting = visible.filter(a => a.status !== 'unavailable'), unavailable = visible.filter(a => a.status === 'unavailable');
  const shortest = live.filter(a => (runway(a)?.minutesLeft ?? Infinity) <= 180).sort((a, b) => runway(a)!.minutesLeft! - runway(b)!.minutesLeft!)[0];
  const ticker = useRef<HTMLDivElement>(null), drag = useRef<{ x: number; left: number; moved: boolean } | null>(null);
  return <section className="usage-room">
    <div className="usage-glow" aria-hidden="true" /><div className="usage-orbit" aria-hidden="true"><i /><i /><i /></div>
    <header className="usage-header"><div><button className={`usage-eyebrow${spark ? ' sparkle' : ''}`} onClick={() => setSpark(v => v + 1)} title="A little more energy"><Sparkles size={15} /> LIVE USAGE{spark > 0 && <span key={spark} className="usage-burst" aria-hidden="true">{Array.from({ length: 16 }, (_, i) => <i key={i} style={{ '--burst-x': `${Math.cos(i * Math.PI / 8) * (70 + i * 5)}px`, '--burst-y': `${Math.sin(i * Math.PI / 8) * (70 + i * 5)}px`, '--burst-hue': i * 25 } as CSSProperties}>✦</i>)}</span>}</button><h1>Know your runway<span>.</span></h1><p>Every connected AI account. The fuel, the limits, the next reset.</p></div><button className="usage-refresh" onClick={() => void refresh()} disabled={query.isFetching} aria-label="Refresh usage"><RefreshCw size={16} className={query.isFetching ? 'usage-spinning' : ''} />{query.isFetching ? 'Checking…' : 'Refresh'}</button></header>
    <div className="usage-overview"><button className={filter === 'all' ? 'selected' : ''} onClick={() => setFilter('all')}><span className="usage-stat-icon"><Gauge size={20} /></span><strong>{accounts.length || '—'}</strong><span>accounts</span></button><button className={filter === 'attention' ? 'selected' : ''} onClick={() => setFilter(filter === 'attention' ? 'all' : 'attention')}><span className="usage-stat-icon amber"><TriangleAlert size={20} /></span><strong>{query.data ? limited.length : '—'}</strong><span>need attention</span></button><div><span className="usage-stat-icon green"><Activity size={20} /></span><strong>{query.data ? live.length : '—'}<small> / {accounts.length}</small></strong><span>feeds responding</span></div><div className="usage-refresh-stat"><Clock3 size={19} /><span>{query.isFetching ? 'Reading providers…' : query.data ? `Next check in ${nextCheck}s` : 'Connecting…'}</span><small>Updates every minute</small></div></div>
    {shortest && <div className="usage-runway-alert" role="status"><Flame size={20} /><p><strong>{shortest.provider}: about {duration(runway(shortest)!.minutesLeft!)} of fuel left</strong><span>At the measured pace of {money(runway(shortest)!.perMinute, runway(shortest)!.currency)}/min. Estimate, not a promise; billing can lag.</span></p><button onClick={() => { setFilter('all'); setSearch(shortest.name); }}>See account<ArrowUpRight size={14} /></button></div>}
    {old && <div role="alert" className="usage-alert"><TriangleAlert size={16} />{query.data ? 'The latest check failed. The last readings stay visible with their original timestamps.' : 'Usage could not load. Refresh to try again.'}</div>}
    {!old && missing.length > 0 && <p className="usage-coverage"><span>{missing.length} {missing.length === 1 ? 'account has' : 'accounts have'} no usage reading here.</span> Their compact cards below link straight to the provider. Provider figures can arrive later than a request.</p>}
    <div className="usage-toolbar"><label className="usage-search"><Search size={16} /><input aria-label="Search usage accounts" placeholder="Find an account" value={search} onChange={e => setSearch(e.target.value)} /></label><div className="usage-mode" role="group" aria-label="Meter display"><button aria-pressed={remaining} onClick={() => setRemaining(true)}>Remaining</button><button aria-pressed={!remaining} onClick={() => setRemaining(false)}>Used</button></div></div>
    <div className="usage-filter-row"><div className="usage-filters" role="group" aria-label="Filter accounts">{[['all', 'All accounts'], ['subscription', 'Subscriptions'], ['api', 'API accounts'], ['pinned', 'Pinned'], ['attention', 'Needs attention']].map(([value, title]) => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === 'pinned' && <Pin size={12} />}{title}</button>)}</div><label className="usage-sort"><ArrowDownUp size={13} /><select aria-label="Sort accounts" value={sort} onChange={e => setSort(e.target.value)}><option value="attention">Needs attention first</option><option value="provider">By provider</option></select></label></div>
    {query.isPending ? <div className="usage-loading" role="status"><span className="usage-loading-orb"><Gauge size={34} /></span><h2>Reading the fuel gauges</h2><p>Checking the connected accounts. No model requests are sent.</p></div>
      : !accounts.length && !old ? <div className="usage-loading"><Gauge size={32} /><h2>No connected accounts yet</h2><p>Accounts appear here when they are configured for this office.</p></div>
      : !visible.length && accounts.length > 0 ? <div className="usage-loading">{filter === 'attention' ? <Check size={30} /> : filter === 'pinned' ? <Pin size={30} /> : <Search size={30} />}<h2>{filter === 'attention' ? 'No accounts need attention' : filter === 'pinned' ? 'Keep your favorites up front' : 'No matching accounts'}</h2><p>{filter === 'pinned' ? 'Tap the pin on an account to keep it at the top.' : 'Try another filter or search.'}</p><button onClick={() => { setFilter('all'); setSearch(''); }}>Show all accounts</button></div>
      : <>
        <div className="usage-ticker" ref={ticker} aria-label="Account ticker, drag to explore" onPointerDown={e => { if (e.pointerType === 'mouse' && ticker.current) { drag.current = { x: e.clientX, left: ticker.current.scrollLeft, moved: false }; } }} onPointerMove={e => { if (!drag.current || !ticker.current) return; const delta = e.clientX - drag.current.x; if (Math.abs(delta) > 5) { drag.current.moved = true; ticker.current.setPointerCapture(e.pointerId); } ticker.current.scrollLeft = drag.current.left - delta; }} onPointerUp={() => { if (drag.current && !drag.current.moved) drag.current = null; }} onClickCapture={e => { if (drag.current?.moved) { e.preventDefault(); e.stopPropagation(); } drag.current = null; }}>
          <div className="usage-ticker-track">{accounts.map(a => <button key={a.id} onClick={() => { setFilter('all'); setSearch(a.email || a.name); }}><span className={isFresh(a) && needsAttention(a) ? 'warn' : isFresh(a) ? 'good' : ''}>●</span>{a.provider}<strong>{tickerValue(a)}</strong></button>)}</div>
        </div>
        {reporting.length > 0 && <div className={`usage-account-grid${spark ? ' usage-extra-energy' : ''}`}>{reporting.map(a => <MasonryCell key={a.id}><AccountCard account={a} time={time} remaining={remaining} pinned={pins.includes(a.id)} onPin={() => togglePin(a.id)} old={old} staleAfter={staleAfter} /></MasonryCell>)}</div>}
        {unavailable.length > 0 && <section className="usage-unreported"><h2>{unavailable.length} accounts to check at the provider</h2><p>Remaining quota, reset times and costs are unknown here. No zeroes or estimates are substituted.</p><div className="usage-unreported-grid">{unavailable.map(a => <AccountCard compact key={a.id} account={a} time={time} remaining={remaining} pinned={pins.includes(a.id)} onPin={() => togglePin(a.id)} old={old} staleAfter={staleAfter} />)}</div></section>}
      </>}

    {query.data && <footer className="usage-page-footer"><span>Read-only provider data · no model requests</span><span>Balances, key budgets and plan windows keep their own scope. Unreported costs stay unknown.</span><span>Snapshot {exactTime(query.data.generatedAt)}</span></footer>}
  </section>;
}
