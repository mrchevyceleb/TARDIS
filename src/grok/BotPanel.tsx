import { agyModelLabel } from '../chat/agyModels';
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
import { ChecklistSection } from './ChecklistSection';
import { CopyButton } from '../chat/components/primitives/CopyButton';
import { parsePinLinkTarget } from '../chat/utils/proxyLinks';
import { statusLabel } from '../theme/voice';
import { DeskPaneSwitch, useDeskPaneMode } from './DeskPaneSwitch';
import { MyDeskPane } from './MyDeskPane';
import {
  buildEverySchedule,
  CUSTOM_INTERVAL_CHIPS,
  CUSTOM_INTERVAL_VALUE,
  customIntervalError,
  customIntervalLabel,
  humanizeCron,
  humanizeRoutine,
  parseEveryInterval,
  SCHEDULE_PRESETS,
  scheduleOptions,
  type EveryUnit,
} from './routineSchedule';

export { humanizeCron };

type ArtifactMeta = { id: string; title?: string; kind?: string; createdAt?: number };

export type ChatMeta = {
  agentLabel: string;
  model?: string | null;
  status: string;
  /** Context window fullness 0..1 when known. */
  fraction?: number;
  compacting?: boolean;
};

export function BotPanel({ meta, onOpenForge, onOpenDesk, onClose, className = '', agent, open = true }: {
  meta: ChatMeta | null;
  onOpenForge: () => void;
  /** Opens the full Desk room. Passed only when the Desk room is on for this
   *  deployment; without it the pane shows the agent's desk alone, as before. */
  onOpenDesk?: () => void;
  onClose?: () => void;
  className?: string;
  agent?: import('./agents').Agent | null;
  /** The pane is showing. My desk only polls the Desk while it is. */
  open?: boolean;
}) {
  const viewer = useProxyViewer();
  const [savedMode, setDeskMode] = useDeskPaneMode();
  const deskEnabled = Boolean(onOpenDesk);
  const deskMode = deskEnabled ? savedMode : 'agent';
  const showAgent = deskMode !== 'mine';
  const showMine = deskMode !== 'agent';
  const { data: cronJobs } = useCronJobs();
  const messagePins = useAgentMessagePins(agent?.id);
  /** Outcome of a manual Run, per routine, shown briefly under the row. */
  const [runStatus, setRunStatus] = useState<Record<string, string>>({});
  const visiblePins = agent ? messagePins.pins.filter((p) => p.agentId === agent.id) : [];
  const [latest, setLatest] = useState<ArtifactMeta | null>(null);
  const [routines, setRoutines] = useState<Array<{ id: string; name: string; agentName: string; agentId: string; schedule: string; prompt: string; paused?: boolean; lastRunAt?: number }>>([]);
  const [routineForm, setRoutineForm] = useState(false);
  const [rtEditingId, setRtEditingId] = useState<string | null>(null);
  const [rtName, setRtName] = useState('');
  const [rtSchedule, setRtSchedule] = useState('daily:09:00');
  const [rtPrompt, setRtPrompt] = useState('');
  const [rtBusy, setRtBusy] = useState(false);
  // Custom interval: any minutes or hours, typed beside the presets.
  // rtSchedule stays the value sent to the API; these three drive the fields.
  const [rtUseCustom, setRtUseCustom] = useState(false);
  const [rtCustomValue, setRtCustomValue] = useState('5');
  const [rtCustomUnit, setRtCustomUnit] = useState<EveryUnit>('m');
  const rtCustomError = rtUseCustom ? customIntervalError(rtCustomValue, rtCustomUnit) : null;

  const applyCustomInterval = (raw: string, unit: EveryUnit) => {
    setRtCustomValue(raw);
    setRtCustomUnit(unit);
    if (!customIntervalError(raw, unit)) {
      setRtSchedule(buildEverySchedule(Number(raw.trim()), unit));
    }
  };
  const pickSchedule = (value: string) => {
    if (value !== CUSTOM_INTERVAL_VALUE) {
      setRtUseCustom(false);
      setRtSchedule(value);
      return;
    }
    // Carry the current interval over when there is one, so tweaking a
    // preset starts from its own number instead of from scratch.
    const seed = parseEveryInterval(rtSchedule) ?? { value: 5, unit: 'm' as EveryUnit };
    setRtUseCustom(true);
    setRtCustomValue(String(seed.value));
    setRtCustomUnit(seed.unit);
    setRtSchedule(buildEverySchedule(seed.value, seed.unit));
  };

  const closeRoutineForm = () => {
    setRoutineForm(false);
    setRtEditingId(null);
    setRtName('');
    setRtPrompt('');
    setRtSchedule(agent ? 'daily:09:00' : 'every:30m');
    setRtUseCustom(false);
  };
  const openNewRoutine = () => {
    if (routineForm && !rtEditingId) { closeRoutineForm(); return; }
    setRtEditingId(null);
    setRtName('');
    setRtPrompt('');
    setRtSchedule(agent ? 'daily:09:00' : 'every:30m');
    setRtUseCustom(false);
    setRoutineForm(true);
  };
  const openEditRoutine = (r: { id: string; name: string; schedule: string; prompt: string }) => {
    setRtEditingId(r.id);
    setRtName(r.name);
    setRtSchedule(r.schedule);
    setRtPrompt(r.prompt);
    // An every-N routine no preset matches opens in the custom fields,
    // showing its own number, ready to tweak.
    const every = parseEveryInterval(r.schedule);
    const custom = every !== null && !SCHEDULE_PRESETS.some((p) => p.value === r.schedule);
    setRtUseCustom(custom);
    if (custom && every) {
      setRtCustomValue(String(every.value));
      setRtCustomUnit(every.unit);
    }
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
    <aside className={`bt-pane${deskMode === 'both' ? ' is-both' : ''} ${className}`.trim()}>
      {deskEnabled ? (
        <div className="bt-pane-top">
          <DeskPaneSwitch mode={deskMode} onChange={setDeskMode} agentLabel={meta?.agentLabel ?? agent?.name ?? 'Agent'} />
          {onClose ? (
            <button className="bt-iconbtn bt-pane-close" onClick={onClose} aria-label="Close panel" title="Close panel">
              <X size={16} />
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="bt-pane-cols">
        {/* Stays mounted while hidden, so a half-written routine survives a flip to My desk. */}
        <div className="bt-pane-col bt-pane-agent" hidden={!showAgent}>
          <section className="bt-pane-sec">
            <div className="bt-pane-title-row">
              <div className="bt-pane-title">{meta?.agentLabel ?? 'Agent'}&apos;s desk</div>
              {onClose && !deskEnabled ? (
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
                <select className="bt-rt-input" aria-label="Schedule" value={rtUseCustom ? CUSTOM_INTERVAL_VALUE : rtSchedule} onChange={(e) => pickSchedule(e.target.value)}>
                  {scheduleOptions(rtSchedule, rtUseCustom).map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
                {rtUseCustom ? (
                  <>
                    <div className="bt-rt-custom">
                      <span className="bt-rt-custom-every">Every</span>
                      <input
                        className="bt-rt-input bt-rt-custom-num"
                        aria-label="Custom interval amount"
                        inputMode="numeric"
                        autoFocus
                        value={rtCustomValue}
                        onChange={(e) => applyCustomInterval(e.target.value, rtCustomUnit)}
                        onFocus={(e) => e.target.select()}
                      />
                      <select
                        className="bt-rt-input bt-rt-custom-unit"
                        aria-label="Custom interval unit"
                        value={rtCustomUnit}
                        onChange={(e) => applyCustomInterval(rtCustomValue, e.target.value === 'h' ? 'h' : 'm')}
                      >
                        <option value="m">minutes</option>
                        <option value="h">hours</option>
                      </select>
                    </div>
                    <div className="bt-rt-chips">
                      {CUSTOM_INTERVAL_CHIPS.map((chip) => (
                        <button
                          key={`${chip.value}${chip.unit}`}
                          type="button"
                          className={`bt-rt-chip${!rtCustomError && Number(rtCustomValue.trim()) === chip.value && rtCustomUnit === chip.unit ? ' on' : ''}`}
                          onClick={() => applyCustomInterval(String(chip.value), chip.unit)}
                        >
                          {chip.label}
                        </button>
                      ))}
                    </div>
                    <div className={`bt-rt-hint${rtCustomError ? ' warn' : ''}`} aria-live="polite">
                      {rtCustomError ?? customIntervalLabel(Number(rtCustomValue.trim()), rtCustomUnit)}
                    </div>
                  </>
                ) : null}
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
                    disabled={rtBusy || !rtPrompt.trim() || (!rtEditingId && !agent) || rtCustomError !== null}
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
                  {runStatus[r.id] ? <span className="bt-routine-sched" style={{ display: 'block', color: runStatus[r.id].startsWith('Sent') ? 'var(--r-mint, #7ee0a9)' : runStatus[r.id].startsWith('Not run') || runStatus[r.id].startsWith('Failed') ? 'var(--r-rose)' : undefined }}>{runStatus[r.id]}</span> : null}
                </span>
                <span className="bt-rt-rowbtns">
                  <button className="bt-iconbtn" title="Edit" aria-label={`Edit ${r.name}`}
                    onClick={() => openEditRoutine(r)}>
                    <Pencil size={13} />
                  </button>
                  <button className="bt-iconbtn" title="Run now" aria-label="Run now"
                    onClick={() => {
                      setRunStatus((m) => ({ ...m, [r.id]: 'Running…' }));
                      void apiJson<{ ran: boolean; reason?: string; gated?: string; agent?: string }>(`/api/routines/${encodeURIComponent(r.id)}/run`, { method: 'POST' })
                        .then((out) => {
                          const text = out.gated ? `Checked, nothing new (${out.gated})` : out.ran ? `Sent to ${out.agent ?? 'the agent'}` : `Not run: ${out.reason ?? 'unknown'}`;
                          setRunStatus((m) => ({ ...m, [r.id]: text }));
                          reloadRoutines();
                        })
                        .catch((err: Error) => setRunStatus((m) => ({ ...m, [r.id]: `Failed: ${err.message}` })));
                      window.setTimeout(() => setRunStatus((m) => { const { [r.id]: _gone, ...rest } = m; return rest; }), 12_000);
                    }}>
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

          {agent ? <ChecklistSection owner={agent.id} name={agent.name} /> : null}

          {agent ? (
            <section className="bt-pane-sec">
              <div className="bt-pane-title">Pinned from {agent.name}</div>
              {messagePins.loadError && !visiblePins.length ? (
                <div className="bt-pane-empty">Pins hid for a second — I’ll try again in a moment.</div>
              ) : visiblePins.length ? visiblePins.map((p) => (
                <div key={p.id} className="bt-msgpin">
                  {(() => {
                    // Quick-access notes: a pin that IS a link opens on tap
                    // (web in a new tab, workspace path in the viewer) — for
                    // message pins AND agent team_pin notes alike. Everything
                    // else: message pins jump to their bubble, notes sit still.
                    const target = parsePinLinkTarget(p.text);
                    if (target?.kind === 'web') {
                      return (
                        <button
                          type="button"
                          className="bt-msgpin-body"
                          title={`Open ${target.url}`}
                          onClick={() => window.open(target.url, '_blank', 'noopener,noreferrer')}
                        >
                          <span className="bt-msgpin-text">{(p.text ?? '').trim() || 'Empty note'} ↗</span>
                        </button>
                      );
                    }
                    if (target) {
                      return (
                        <button
                          type="button"
                          className="bt-msgpin-body"
                          title="Open in the viewer"
                          onClick={() => viewer.open({ source: target.kind, path: target.path, title: (p.text ?? '').trim() || undefined })}
                        >
                          <span className="bt-msgpin-text">{(p.text ?? '').trim() || 'Empty note'} ↗</span>
                        </button>
                      );
                    }
                    if (p.blockId.startsWith('note-')) {
                      // An agent's own note (team_pin): there is no bubble to jump to.
                      return (
                        <div className="bt-msgpin-body" title="Pinned by the agent">
                          <span className="bt-msgpin-text">{(p.text ?? '').trim() || 'Empty note'}</span>
                        </div>
                      );
                    }
                    return (
                      <button
                        type="button"
                        className="bt-msgpin-body"
                        title="Jump to this message"
                        onClick={() => scrollToPinnedMessage(p.blockId)}
                      >
                        <span className="bt-msgpin-text">{(p.text ?? '').trim() || 'Empty bubble'}</span>
                      </button>
                    );
                  })()}
                  <CopyButton text={(p.text ?? '').trim()} className="bt-msgpin-copy" size={13} title="Copy pin text" />
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
                {meta.model ? <div className="bt-session-row"><span>Model</span><b>{agyModelLabel(meta.model)}</b></div> : null}
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
        </div>
        {onOpenDesk && showMine && open ? <MyDeskPane limits={deskMode === 'both' ? { todos: 6, cards: 5 } : { todos: 20, cards: 14 }} onOpenDesk={onOpenDesk} /> : null}
      </div>
    </aside>
  );
}
