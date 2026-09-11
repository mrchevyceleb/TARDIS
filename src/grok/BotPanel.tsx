// Grok Bot right info pane: the agent's "screen" (latest artifact it made,
// live preview when it's HTML/an image — honest empty state otherwise), the
// Routines card (real cron jobs from /api/cron with status + schedule), and a
// Session card with the live context meter + compaction state.

import { X, Play, Pause, Trash2, Pin, Pencil } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CheckCircle2, PauseCircle, Plus } from 'lucide-react';
import { apiJson } from '../data/api';
import { useCronJobs } from '../hooks/useRoomData';
import { useProxyViewer } from '../hooks/useProxyViewer';
import { scrollToPinnedMessage, useAgentMessagePins } from './messagePins';
import { statusLabel } from '../theme/voice';

type ArtifactMeta = { id: string; title?: string; kind?: string; createdAt?: number };

// Light cron humanizer for the Routines card. Shows "Weekdays · every 30 min,
// 9:12 AM–4:42 PM", not "Cron 12,42 9-16 * * 1-5".
function humanizeRoutine(schedule: string): string {
  const m = /^every:(\d+)(m|h)$/.exec(schedule);
  if (m) return m[2] === 'h' ? `Every ${m[1]} hour${m[1] === '1' ? '' : 's'}` : `Every ${m[1]} min`;
  const d = /^(weekdays|daily):(\d{1,2}):(\d{2})$/.exec(schedule);
  if (d) {
    return `${d[1] === 'weekdays' ? 'Weekdays' : 'Daily'} · ${fmtClock(parseInt(d[2], 10), parseInt(d[3], 10))}`;
  }
  if (schedule.startsWith('cron:')) return humanizeCron(schedule.slice(5));
  return humanizeCron(schedule);
}

function fmtClock(h: number, m: number): string {
  const ap = h >= 12 ? 'PM' : 'AM';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${String(m).padStart(2, '0')} ${ap}`;
}

function parseIntList(field: string): number[] | null {
  if (!/^\d+(,\d+)*$/.test(field)) return null;
  return field.split(',').map(Number);
}

function parseStep(field: string): number | null {
  const m = /^\*\/(\d+)$/.exec(field);
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? n : null;
}

function parseRange(field: string): [number, number] | null {
  const m = /^(\d+)-(\d+)$/.exec(field);
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

function describeDays(dow: string): string {
  const sorted = (parseIntList(dow) ?? []).slice().sort((a, b) => a - b).join(',');
  if (dow === '*' || dow === '0-6' || dow === '0-7') return '';
  if (dow === '1-5') return 'Weekdays';
  if (sorted === '0,6' || dow === '6,0') return 'Weekends';
  if (sorted === '1,5') return 'Mon and Fri';
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  if (/^[0-6]$/.test(dow) || dow === '7') return DAYS[dow === '7' ? 0 : Number(dow)] ?? '';
  const list = parseIntList(dow);
  if (list?.every((d) => d >= 0 && d <= 7)) {
    return list.map((d) => DAYS[d === 7 ? 0 : d]).filter(Boolean).join(', ');
  }
  return '';
}

function joinWhen(when: string, days: string): string {
  if (days && when) return `${days} · ${when}`;
  return days || when || '';
}

export function humanizeCron(schedule: string): string {
  const raw = schedule.trim().replace(/^cron:/, '');
  const parts = raw.split(/\s+/);
  if (parts.length !== 5) return schedule;
  const [min, hour, dom, mon, dow] = parts;
  if (dom !== '*' || mon !== '*') {
    if (/^\d+$/.test(min) && /^\d+$/.test(hour) && /^\d+$/.test(dom) && mon === '*') {
      return `On the ${ordinal(Number(dom))} of every month at ${fmtClock(Number(hour), Number(min))}`;
    }
    return raw;
  }

  const days = describeDays(dow);
  const minStep = parseStep(min);
  const hourStep = parseStep(hour);
  const hourRange = parseRange(hour);
  const hourList = parseIntList(hour);
  const minList = parseIntList(min);
  const oneMin = /^\d+$/.test(min) ? Number(min) : null;

  if (minStep && hour === '*') return joinWhen(`every ${minStep} min`, days);
  if (minStep && hourRange) {
    return joinWhen(`every ${minStep} min, ${fmtClock(hourRange[0], 0)} to ${fmtClock(hourRange[1], 59)}`, days);
  }
  if (hourStep && (oneMin != null || min === '0')) {
    const mm = oneMin ?? 0;
    return joinWhen(`every ${hourStep} hours at :${String(mm).padStart(2, '0')}`, days);
  }
  if (oneMin != null && hourRange) {
    return joinWhen(`hourly at :${String(oneMin).padStart(2, '0')}, ${fmtClock(hourRange[0], oneMin)} to ${fmtClock(hourRange[1], oneMin)}`, days);
  }
  if (minList && hourRange) {
    const span = minList.length === 2 ? Math.abs(minList[1] - minList[0]) : 0;
    const start = fmtClock(hourRange[0], Math.min(...minList));
    const end = fmtClock(hourRange[1], Math.max(...minList));
    const cadence = span === 30 ? `every 30 min, ${start} to ${end}` : `at :${minList.map((n) => String(n).padStart(2, '0')).join(' and :')}, ${start} to ${end}`;
    return joinWhen(cadence, days);
  }
  if (oneMin != null && hourList) {
    const times = hourList.map((h) => fmtClock(h, oneMin)).join(', ');
    return joinWhen(times, days);
  }
  if (oneMin != null && hour === '*') {
    return joinWhen(`hourly at :${String(oneMin).padStart(2, '0')}`, days);
  }
  if (oneMin != null && /^\d+$/.test(hour)) {
    return joinWhen(fmtClock(Number(hour), oneMin), days) || `Every day at ${fmtClock(Number(hour), oneMin)}`;
  }
  return raw;
}

function ordinal(n: number): string {
  const s = n % 10;
  return `${n}${s === 1 && n !== 11 ? 'st' : s === 2 && n !== 12 ? 'nd' : s === 3 && n !== 13 ? 'rd' : 'th'}`;
}

const SCHEDULE_PRESETS: Array<{ value: string; label: string }> = [
  { value: 'every:30m', label: 'Every 30 minutes' },
  { value: 'every:2h', label: 'Every 2 hours' },
  { value: 'every:4h', label: 'Every 4 hours' },
  { value: 'daily:09:00', label: 'Daily · 9:00 AM' },
  { value: 'daily:17:00', label: 'Daily · 5:00 PM' },
  { value: 'weekdays:09:00', label: 'Weekdays · 9:00 AM' },
  { value: 'cron:12,42 9-16 * * 1-5', label: 'Weekdays · every 30 min, 9 AM to 5 PM' },
  { value: 'cron:17 18,22,2,6 * * 1-5', label: 'Weeknights · 6 PM, 10 PM, 2 AM, 6 AM' },
  { value: 'cron:17 */4 * * 0,6', label: 'Weekends · every 4 hours' },
  { value: 'cron:23 8-17 * * 1-5', label: 'Weekdays · hourly, 8 AM to 5 PM' },
  { value: 'cron:23 21,1,5 * * 1-5', label: 'Weeknights · 9 PM, 1 AM, 5 AM' },
  { value: 'cron:23 */4 * * 0,6', label: 'Weekends · every 4 hours' },
  { value: 'cron:0 * * * *', label: 'Hourly' },
];

function scheduleOptions(current: string): Array<{ value: string; label: string }> {
  if (SCHEDULE_PRESETS.some((p) => p.value === current)) return SCHEDULE_PRESETS;
  return [{ value: current, label: humanizeRoutine(current) }, ...SCHEDULE_PRESETS];
}

export type ChatMeta = {
  agentLabel: string;
  model?: string | null;
  status: string;
  /** Context window fullness 0..1 when known. */
  fraction?: number;
  compacting?: boolean;
};

export function BotPanel({ meta, onOpenForge, onClose, className = '', agent }: { meta: ChatMeta | null; onOpenForge: () => void; onClose?: () => void; className?: string; agent?: import('./agents').Agent | null }) {
  const viewer = useProxyViewer();
  const { data: cronJobs } = useCronJobs();
  const messagePins = useAgentMessagePins(agent?.id);
  const visiblePins = agent ? messagePins.pins.filter((p) => p.agentId === agent.id) : [];
  const [latest, setLatest] = useState<ArtifactMeta | null>(null);
  const [routines, setRoutines] = useState<Array<{ id: string; name: string; agentName: string; agentId: string; schedule: string; prompt: string; paused?: boolean; lastRunAt?: number }>>([]);
  const [routineForm, setRoutineForm] = useState(false);
  const [rtEditingId, setRtEditingId] = useState<string | null>(null);
  const [rtName, setRtName] = useState('');
  const [rtSchedule, setRtSchedule] = useState('daily:09:00');
  const [rtPrompt, setRtPrompt] = useState('');
  const [rtBusy, setRtBusy] = useState(false);

  const closeRoutineForm = () => {
    setRoutineForm(false);
    setRtEditingId(null);
    setRtName('');
    setRtPrompt('');
    setRtSchedule(agent ? 'daily:09:00' : 'every:30m');
  };
  const openNewRoutine = () => {
    if (routineForm && !rtEditingId) { closeRoutineForm(); return; }
    setRtEditingId(null);
    setRtName('');
    setRtPrompt('');
    setRtSchedule(agent ? 'daily:09:00' : 'every:30m');
    setRoutineForm(true);
  };
  const openEditRoutine = (r: { id: string; name: string; schedule: string; prompt: string }) => {
    setRtEditingId(r.id);
    setRtName(r.name);
    setRtSchedule(r.schedule);
    setRtPrompt(r.prompt);
    setRoutineForm(true);
  };

  const reloadRoutines = () => {
    apiJson<{ routines: typeof routines }>('/api/routines')
      .then((r) => setRoutines(r.routines ?? []))
      .catch(() => {});
  };
  useEffect(() => {
    reloadRoutines();
    const iv = window.setInterval(reloadRoutines, 20_000);
    return () => window.clearInterval(iv);
  }, []);

  useEffect(() => {
    let alive = true;
    apiJson<ArtifactMeta[]>('/api/artifacts')
      .then((rows) => { if (alive) setLatest(Array.isArray(rows) && rows.length ? rows[0] : null); })
      .catch(() => { /* desk is best-effort */ });
    const iv = window.setInterval(() => {
      apiJson<ArtifactMeta[]>('/api/artifacts')
        .then((rows) => { if (alive) setLatest(Array.isArray(rows) && rows.length ? rows[0] : null); })
        .catch(() => {});
    }, 20_000);
    return () => { alive = false; window.clearInterval(iv); };
  }, []);

  const isHtml = (latest?.kind ?? '').includes('html');
  const isImage = (latest?.kind ?? '').includes('image') || /\.(png|jpe?g|gif|webp|svg)$/i.test(latest?.title ?? '');
  const jobs = (cronJobs ?? []).slice(0, 8);
  const frac = meta?.fraction;

  return (
    <aside className={`bt-pane ${className}`.trim()}>
      <section className="bt-pane-sec">
        <div className="bt-pane-title-row">
          <div className="bt-pane-title">{meta?.agentLabel ?? 'Agent'}&apos;s desk</div>
          {onClose ? (
            <button className="bt-iconbtn bt-pane-close" onClick={onClose} aria-label="Close panel" title="Close panel">
              <X size={16} />
            </button>
          ) : null}
        </div>
        <div className="bt-screen">
          {latest ? (
            <>
              {isHtml ? (
                <button
                  className="bt-screen-preview"
                  onClick={() => viewer.open({ source: 'artifact', id: latest.id, title: latest.title })}
                  title="Open artifact"
                >
                  <iframe title="artifact preview" sandbox="" src={`/api/artifacts/${encodeURIComponent(latest.id)}/content`} />
                </button>
              ) : isImage ? (
                <button
                  className="bt-screen-preview"
                  onClick={() => viewer.open({ source: 'artifact', id: latest.id, title: latest.title })}
                  title="Open artifact"
                >
                  <img src={`/api/artifacts/${encodeURIComponent(latest.id)}/content`} alt={latest.title ?? 'artifact'} />
                </button>
              ) : (
                <button
                  className="bt-screen-preview"
                  onClick={() => viewer.open({ source: 'artifact', id: latest.id, title: latest.title })}
                  title="Open artifact"
                >
                  <span className="bt-screen-idle">▤</span>
                </button>
              )}
              <div className="bt-screen-meta">{latest.title ?? 'Latest artifact'}</div>
            </>
          ) : (
            <>
              <div className="bt-screen-idle">·</div>
              <div className="bt-screen-meta">Nothing on the desk yet — ask {meta?.agentLabel ?? 'the agent'} to build something.</div>
            </>
          )}
        </div>
      </section>

      <section className="bt-pane-sec">
        <div className="bt-pane-title">
          Automations{agent ? ` · ${agent.name}` : ''}
          <button
            className="bt-iconbtn"
            onClick={openNewRoutine}
            title={agent ? `New automation for ${agent.name}` : 'New automation'}
            aria-label="New automation"
          >
            <Plus size={16} />
          </button>
        </div>
        {routineForm ? (
          <div className="bt-rt-form">
            <input className="bt-rt-input" placeholder="Name (Morning brief)" value={rtName} onChange={(e) => setRtName(e.target.value)} maxLength={80} />
            <select className="bt-rt-input" value={rtSchedule} onChange={(e) => setRtSchedule(e.target.value)}>
              {scheduleOptions(rtSchedule).map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            <textarea
              className="bt-rt-input"
              placeholder={agent ? `What ${agent.name} should do each run…` : 'What the agent should do each run…'}
              value={rtPrompt}
              onChange={(e) => setRtPrompt(e.target.value)}
              rows={4}
            />
            <div className="bt-rt-actions">
              <button type="button" className="bt-rt-btn" onClick={closeRoutineForm}>Cancel</button>
              <button
                className="bt-rt-btn primary"
                disabled={rtBusy || !rtPrompt.trim() || (!rtEditingId && !agent)}
                onClick={async () => {
                  setRtBusy(true);
                  try {
                    if (rtEditingId) {
                      await apiJson(`/api/routines/${encodeURIComponent(rtEditingId)}`, {
                        method: 'PATCH',
                        body: JSON.stringify({ name: rtName || 'Routine', schedule: rtSchedule, prompt: rtPrompt }),
                      });
                    } else {
                      await apiJson('/api/routines', {
                        method: 'POST',
                        body: JSON.stringify({ name: rtName || 'Routine', agentId: agent?.id, schedule: rtSchedule, prompt: rtPrompt }),
                      });
                    }
                    closeRoutineForm();
                    reloadRoutines();
                  } finally { setRtBusy(false); }
                }}
              >
                {rtEditingId ? 'Save' : agent ? `Add for ${agent.name}` : 'Pick an agent first'}
              </button>
            </div>
          </div>
        ) : null}
        {routines.filter((r) => !agent || r.agentId === agent.id).map((r) => (
          <div key={r.id} className={`bt-routine ${r.paused ? 'off' : 'on'}${rtEditingId === r.id ? ' editing' : ''}`}>
            {r.paused ? <PauseCircle size={16} /> : <CheckCircle2 size={16} />}
            <span style={{ flex: 1, minWidth: 0 }}>
              <span className="bt-routine-name">{r.name}</span>
              <span className="bt-routine-sched" style={{ display: 'block' }}>{humanizeRoutine(r.schedule)}</span>
              {!agent ? <span className="bt-routine-sched" style={{ display: 'block' }}>→ {r.agentName}</span> : null}
              {r.paused ? <span className="bt-routine-paused" style={{ display: 'block' }}>Paused</span> : null}
            </span>
            <span className="bt-rt-rowbtns">
              <button className="bt-iconbtn" title="Edit" aria-label={`Edit ${r.name}`}
                onClick={() => openEditRoutine(r)}>
                <Pencil size={13} />
              </button>
              <button className="bt-iconbtn" title="Run now" aria-label="Run now"
                onClick={() => { void apiJson(`/api/routines/${encodeURIComponent(r.id)}/run`, { method: 'POST' }).then(reloadRoutines); }}>
                <Play size={13} />
              </button>
              <button className="bt-iconbtn" title={r.paused ? 'Resume' : 'Pause'} aria-label={r.paused ? 'Resume' : 'Pause'}
                onClick={() => { void apiJson(`/api/routines/${encodeURIComponent(r.id)}`, { method: 'PATCH', body: JSON.stringify({ paused: !r.paused }) }).then(reloadRoutines); }}>
                {r.paused ? <Play size={13} /> : <Pause size={13} />}
              </button>
              <button className="bt-iconbtn" title="Delete" aria-label="Delete routine"
                onClick={() => { if (window.confirm(`Delete routine "${r.name}"?`)) { void apiJson(`/api/routines/${encodeURIComponent(r.id)}`, { method: 'DELETE' }).then(reloadRoutines); } }}>
                <Trash2 size={13} />
              </button>
            </span>
          </div>
        ))}
        {!routines.length && !routineForm ? (
          <div className="bt-pane-empty">{agent ? `No automations for ${agent.name} yet — + to schedule one.` : 'No automations yet.'}</div>
        ) : null}
      </section>

      {agent ? (
        <section className="bt-pane-sec">
          <div className="bt-pane-title">Pinned from {agent.name}</div>
          {messagePins.loadError && !visiblePins.length ? (
            <div className="bt-pane-empty">Pins hid for a second — I’ll try again in a moment.</div>
          ) : visiblePins.length ? visiblePins.map((p) => (
            <div key={p.id} className="bt-msgpin">
              <button
                type="button"
                className="bt-msgpin-body"
                title="Jump to this message"
                onClick={() => scrollToPinnedMessage(p.blockId)}
              >
                <span className="bt-msgpin-text">{(p.text ?? '').trim() || 'Empty bubble'}</span>
              </button>
              <button
                type="button"
                className="bt-iconbtn bt-msgpin-unpin"
                title="Unpin"
                aria-label="Unpin"
                onClick={() => { void messagePins.unpin(p.id); }}
              >
                <X size={13} />
              </button>
            </div>
          )) : (
            <div className="bt-msgpin-empty">
              <Pin size={16} className="bt-msgpin-idle" />
              <span>Nothing pocketed yet. Hover a bubble, tap pin, and I’ll hold it here.</span>
            </div>
          )}
        </section>
      ) : null}

      <section className="bt-pane-sec">
        <div className="bt-pane-title">
          System cron
          <button className="bt-iconbtn" onClick={onOpenForge} title="Manage in Forge" aria-label="Manage in Forge">
            <Plus size={16} />
          </button>
        </div>
        {jobs.length ? jobs.map((j) => (
          <button key={j.id} className={`bt-routine ${j.status === 'active' ? 'on' : 'off'}`} onClick={onOpenForge} title="Open in Forge">
            {j.status === 'active' ? <CheckCircle2 size={16} /> : <PauseCircle size={16} />}
            <span>
              <span className="bt-routine-name">{j.name}</span>
              <span className="bt-routine-sched" style={{ display: 'block' }}>{humanizeCron(j.schedule)}</span>
              {j.status !== 'active' ? <span className="bt-routine-paused" style={{ display: 'block' }}>Paused</span> : null}
            </span>
          </button>
        )) : (
          <div className="bt-pane-empty">No routines yet. Forge can schedule one.</div>
        )}
      </section>

      {meta ? (
        <section className="bt-pane-sec">
          <div className="bt-pane-title">Session</div>
          <div className="bt-session">
            <div className="bt-session-row"><span>Agent</span><b>{meta.agentLabel}</b></div>
            {meta.model ? <div className="bt-session-row"><span>Model</span><b>{meta.model}</b></div> : null}
            <div className="bt-session-row"><span>State</span><b>{meta.compacting ? 'Regenerating…' : statusLabel(meta.status)}</b></div>
            {typeof frac === 'number' ? (
              <>
                <div className={`bt-meter${frac > 0.8 ? ' hot' : ''}`}>
                  <i style={{ width: `${Math.min(100, Math.round(frac * 100))}%` }} />
                </div>
                <div className="bt-session-cap">Context {Math.round(frac * 100)}%{meta.compacting ? ' — regenerating to keep the thread alive' : ''}</div>
              </>
            ) : null}
          </div>
        </section>
      ) : null}
    </aside>
  );
}
