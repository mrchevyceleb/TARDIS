import {
  AlertTriangle,
  Bot,
  CalendarClock,
  CheckCircle2,
  Code2,
  History,
  Pencil,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Save,
  Sparkles,
  Trash2,
  X,
  XCircle,
  Zap,
} from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiJson } from '../data/api';
import { CLAUDE_MODELS, DEFAULT_CLAUDE_MODEL } from '../chat/components/CodexEnginePicker';
import {
  CODEX_MODELS,
  DEFAULT_CODEX_MODEL,
  codexModelSpec,
  normalizeCodexEffort,
} from '../chat/codexModels';
import { XAI_MODELS } from '../chat/hooks/useCompanionPicker';
import type { CronAiModel, CronJob, CronRun } from '../data/types';
import { Button, Chip, EmptyState, Surface } from '../components/Primitives';
import { RoomHeader } from '../components/RoomHeader';
import { useCronHistory, useCronJobs } from '../hooks/useRoomData';
import { ROOM_NAMES } from '../data/roomNames';

function runOutcome(status: string): 'ok' | 'failed' | 'running' | 'unknown' {
  if (status === 'completed' || status === 'success') return 'ok';
  if (status === 'failed') return 'failed';
  if (status === 'running') return 'running';
  return 'unknown';
}

// apiJson wraps upstream JSON error bodies inside the Error message; unwrap it
// and friendlify the UUID error that synthetic/managed ids produce.
function cleanHistoryError(err: unknown): string {
  let msg = err instanceof Error ? err.message : String(err ?? '');
  try { const parsed = JSON.parse(msg); if (parsed?.error) msg = parsed.error; } catch { /* not JSON, keep raw */ }
  if (/invalid input syntax for type uuid/i.test(msg)) msg = 'Run history is not available for this task.';
  return msg || 'Could not load run history.';
}

function runResultText(run: CronRun): string {
  if (run.error) return run.error;
  const r = run.result as { response?: string; error?: string; message?: string } | string | null | undefined;
  if (r == null) return '';
  if (typeof r === 'string') return r;
  if (typeof r.response === 'string') return r.response;
  if (typeof r.error === 'string') return r.error;
  if (typeof r.message === 'string') return r.message;
  try { return JSON.stringify(r); } catch { return ''; }
}

function formatDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

type CronDraft = {
  name: string;
  engine: string;
  model: string;
  effort: string;
  schedMode: 'simple' | 'custom';
  freq: string;
  schedTime: string;
  schedDow: string;
  schedule: string;
  prompt: string;
  repo: string;
  status: CronJob['status'];
};

const emptyDraft: CronDraft = {
  name: '',
  engine: 'assistant',
  model: DEFAULT_CLAUDE_MODEL,
  effort: '',
  schedMode: 'simple',
  freq: 'daily',
  schedTime: '09:00',
  schedDow: '1',
  schedule: '0 9 * * *',
  prompt: '',
  repo: '',
  status: 'active',
};

const schedulePresets = [
  { label: 'Every 5 min', value: 'every 5 minutes', cron: '*/5 * * * *' },
  { label: 'Every 15 min', value: 'every 15 minutes', cron: '*/15 * * * *' },
  { label: 'Hourly', value: 'hourly', cron: '0 * * * *' },
  { label: 'Daily 6 AM', value: 'daily 6am', cron: '0 6 * * *' },
  { label: 'Weekdays 9 AM', value: 'weekdays 9am', cron: '0 9 * * 1-5' },
  { label: 'M/F 7 AM', value: 'mon/fri 7am', cron: '0 7 * * 1,5' },
];

// Scheduled work uses the same three subscription engines as conversations.
// The legacy cron id `assistant` is the Claude Code lane.
const CRON_ENGINES: { id: string; label: string; hint: string }[] = [
  { id: 'assistant', label: 'Claude Code', hint: 'Your authenticated subscription CLI with tools' },
  { id: 'codex', label: 'Codex', hint: 'Your authenticated subscription CLI with tools' },
  { id: 'xai', label: 'Grok', hint: 'Your Grok coding subscription with tools' },
];
const KNOWN_ENGINES = new Set(CRON_ENGINES.map((e) => e.id));
function engineLabel(id: string): string {
  return CRON_ENGINES.find((e) => e.id === id)?.label ?? id;
}
function engineHint(id: string): string {
  return CRON_ENGINES.find((e) => e.id === id)?.hint ?? '';
}
// aiModel is a legacy coarse field the upstream still stores; the engine field
// is the real dispatch key now. We only need claude/codex here.
function coarseAiModel(engine: string): CronAiModel {
  return engine === 'codex' ? 'codex' : 'claude';
}
function engineFromAiModel(m: CronAiModel): string {
  return m === 'codex' ? 'codex' : 'assistant';
}

/**
 * Clean display for ANY job, never "Mandrill". The engine field is the source of
 * truth; legacy jobs without one fall back to the local Claude Code lane.
 * Returns the human label + optional specific model id.
 */
function engineDisplay(job: CronJob): { label: string; modelId?: string } {
  // Migrate the legacy Claude engine id to the current assistant lane so
  // legacy jobs render with a real label instead of the bare id.
  if (job.engine === 'claude') {
    return { label: engineLabel('assistant'), modelId: job.modelId };
  }
  if (job.engine && KNOWN_ENGINES.has(job.engine)) {
    return { label: engineLabel(job.engine), modelId: job.modelId };
  }
  if (job.engine) {
    return { label: prettifyEngineId(job.engine), modelId: job.modelId };
  }
  // Engine-less legacy jobs use the coarse aiModel field.
  return { label: engineLabel(engineFromAiModel(job.aiModel || 'claude')), modelId: job.modelId };
}
function prettifyEngineId(id: string): string {
  const cleaned = id.replace(/[-_]/g, ' ').replace(/\bbanana\b/gi, 'LM Studio').replace(/\s+/g, ' ').trim();
  return cleaned || id;
}

// Subscription model menus.
type ModelOpt = { id: string; label: string };
function staticModelsForEngine(engine: string): ModelOpt[] {
  if (engine === 'xai') return XAI_MODELS;
  if (engine === 'codex') return CODEX_MODELS;
  if (engine === 'assistant') return CLAUDE_MODELS;
  return [];
}

// ── Schedule builder: pick frequency + time + day, never type a cron string ──
const FREQ_OPTIONS: ModelOpt[] = [
  { id: 'every-5-min', label: 'Every 5 minutes' },
  { id: 'every-15-min', label: 'Every 15 minutes' },
  { id: 'every-30-min', label: 'Every 30 minutes' },
  { id: 'hourly', label: 'Hourly' },
  { id: 'daily', label: 'Daily' },
  { id: 'weekdays', label: 'Weekdays (Mon–Fri)' },
  { id: 'weekly', label: 'Weekly' },
];
const DAY_OPTIONS: ModelOpt[] = [
  { id: '0', label: 'Sunday' }, { id: '1', label: 'Monday' }, { id: '2', label: 'Tuesday' },
  { id: '3', label: 'Wednesday' }, { id: '4', label: 'Thursday' }, { id: '5', label: 'Friday' },
  { id: '6', label: 'Saturday' },
];
const TIME_OPTIONS: ModelOpt[] = (() => {
  const out: ModelOpt[] = [];
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 30]) {
      const id = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      const suffix = h >= 12 ? 'PM' : 'AM';
      const hr12 = h % 12 || 12;
      out.push({ id, label: `${hr12}:${String(m).padStart(2, '0')} ${suffix}` });
    }
  }
  return out;
})();
function freqNeedsTime(freq: string): boolean {
  return freq === 'daily' || freq === 'weekdays' || freq === 'weekly';
}
function describeSimple(freq: string, time: string, dow: string): string {
  const t = TIME_OPTIONS.find((o) => o.id === time)?.label ?? time;
  switch (freq) {
    case 'every-5-min': return 'every 5 minutes';
    case 'every-15-min': return 'every 15 minutes';
    case 'every-30-min': return 'every 30 minutes';
    case 'hourly': return 'hourly';
    case 'daily': return `daily at ${t}`;
    case 'weekdays': return `weekdays at ${t}`;
    case 'weekly': return `every ${DAY_OPTIONS.find((d) => d.id === dow)?.label ?? 'day'} at ${t}`;
    default: return '';
  }
}
function buildCron(freq: string, time: string, dow: string): string {
  const [h, m] = time.split(':').map((n) => Number(n) || 0);
  switch (freq) {
    case 'every-5-min': return '*/5 * * * *';
    case 'every-15-min': return '*/15 * * * *';
    case 'every-30-min': return '*/30 * * * *';
    case 'hourly': return '0 * * * *';
    case 'daily': return `${m} ${h} * * *`;
    case 'weekdays': return `${m} ${h} * * 1-5`;
    case 'weekly': return `${m} ${h} * * ${dow}`;
    default: return '';
  }
}
type SchedParts = { freq: string; time: string; dow: string };
/** Best-effort parse of a 5-field cron back into builder selections. null = custom. */
function parseCron(cron: string): SchedParts | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [m, h, dom, mon, dow] = parts;
  const def = { time: '09:00', dow: '1' };
  if (h === '*' && dom === '*' && mon === '*' && dow === '*') {
    if (m === '*/5') return { freq: 'every-5-min', ...def };
    if (m === '*/15') return { freq: 'every-15-min', ...def };
    if (m === '*/30') return { freq: 'every-30-min', ...def };
    if (m === '0') return { freq: 'hourly', ...def };
  }
  if (/^\d+$/.test(m) && /^\d+$/.test(h) && dom === '*' && mon === '*') {
    const time = `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
    if (dow === '*') return { freq: 'daily', time, dow: '1' };
    if (dow === '1-5') return { freq: 'weekdays', time, dow: '1' };
    if (/^[0-6]$/.test(dow)) return { freq: 'weekly', time, dow };
  }
  return null;
}

// A workspace-root CWD means "no specific repo" and should be hidden in the UI
// regardless of the host operating system or account name.
const isWorkspaceRoot = (cwd: string) => /(?:^|[\\/])ASSISTANT-HUB[\\/]?$/.test(cwd);

export function Forge() {
  const { data: jobs = [], refetch } = useCronJobs();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<CronDraft>(emptyDraft);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  // Synchronous in-flight guard for save. busyId (state) only blocks clicks
  // AFTER React re-renders, so a synchronous burst (rapid double-click, repeat
  // Enter) sails past it and creates duplicate schedules. A ref flips instantly.
  const savingRef = useRef(false);

  const flash = useCallback((kind: 'error' | 'success', text: string) => {
    setNotice({ kind, text });
    if (kind === 'success') window.setTimeout(() => setNotice(null), 3500);
  }, []);

  const modelOptions = staticModelsForEngine(draft.engine);
  const codexEffortOptions = draft.engine === 'codex'
    ? codexModelSpec(draft.model).efforts
    : [];
  const initialSelectionFor = (engine: string): { model: string; effort: string } => {
    const list = staticModelsForEngine(engine);
    const model = engine === 'codex' ? DEFAULT_CODEX_MODEL : list[0]?.id ?? '';
    return {
      model,
      effort: engine === 'codex' ? codexModelSpec(model).defaultEffort : '',
    };
  };

  // Active first, then paused, then failed; stable within each group.
  const sortedJobs = useMemo(() => {
    const rank: Record<string, number> = { active: 0, paused: 1, failed: 2 };
    return [...jobs].sort((a, b) => (rank[a.status] ?? 1) - (rank[b.status] ?? 1));
  }, [jobs]);

  const selected = useMemo(() => {
    if (!sortedJobs.length) return null;
    return sortedJobs.find((job) => job.id === selectedId) ?? sortedJobs[0];
  }, [sortedJobs, selectedId]);

  const isCreating = editingId === 'new';
  const editing = isCreating ? null : jobs.find((job) => job.id === editingId) ?? null;
  const activeCount = jobs.filter((job) => job.status === 'active').length;
  const pausedCount = jobs.filter((job) => job.status === 'paused').length;
  const failedCount = jobs.filter((job) => job.status === 'failed').length;
  const resolvedSchedule = resolveScheduleInput(draft.schedule);
  const missingRequiredModel = !draft.model.trim();
  const cannotSave = !draft.name.trim() || !draft.prompt.trim() || !resolvedSchedule.valid || missingRequiredModel;

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['cron'] });
  };

  const startCreate = () => {
    setDraft(emptyDraft);
    setEditingId('new');
    setSelectedId(null);
  };

  const startEdit = (job: CronJob) => {
    if (job.readOnly) return;
    setDraft(draftFromJob(job));
    setEditingId(job.id);
    setSelectedId(job.id);
  };

  const closeEditor = () => {
    setEditingId(null);
    setDraft(emptyDraft);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (cannotSave) return;
    // Synchronous guard: a rapid double-click or repeated Enter fires multiple
    // submit events before React re-renders, so busyId (state) can't block the
    // burst. Flip the ref now and only the first call proceeds.
    if (savingRef.current) return;
    savingRef.current = true;
    const savingId = editingId || 'new';
    setBusyId(savingId);
    try {
      const payload = normalizeDraft(draft);
      const saved = await apiJson<CronJob>(isCreating ? '/api/cron' : `/api/cron/${encodeURIComponent(editingId || '')}`, {
        method: isCreating ? 'POST' : 'PATCH',
        body: JSON.stringify(payload),
      });
      setSelectedId(saved.id);
      closeEditor();
      await invalidate();
      flash('success', `Saved "${saved.name}".`);
    } catch (err: any) {
      flash('error', err?.message || 'Could not save the task.');
    } finally {
      savingRef.current = false;
      setBusyId(null);
    }
  };

  const toggle = async (job: CronJob) => {
    if (job.readOnly) return;
    setBusyId(job.id);
    try {
      await apiJson<CronJob>(`/api/cron/${encodeURIComponent(job.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: cronIsPaused(job) ? 'active' : 'paused' }),
      });
      await invalidate();
      flash('success', cronIsPaused(job) ? `Resumed "${job.name}".` : `Paused "${job.name}".`);
    } catch (err: any) {
      flash('error', err?.message || 'Could not update the task.');
    } finally {
      setBusyId(null);
    }
  };

  const runNow = async (job: CronJob) => {
    if (job.readOnly) return;
    setBusyId(job.id);
    try {
      const resp = await apiJson<{ runtime?: string }>(`/api/cron/${encodeURIComponent(job.id)}/run-now`, { method: 'POST' });
      await invalidate();
      flash('success', `Triggered "${job.name}" on the ${resp?.runtime || 'local'} runner. History updates in a moment.`);
    } catch (err: any) {
      flash('error', err?.message || 'Could not trigger the task.');
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (job: CronJob) => {
    if (job.readOnly) return;
    if (!window.confirm(`Delete "${job.name}"? This cannot be undone.`)) return;
    setBusyId(job.id);
    try {
      await apiJson<void>(`/api/cron/${encodeURIComponent(job.id)}`, { method: 'DELETE' });
      if (selectedId === job.id) setSelectedId(null);
      if (editingId === job.id) closeEditor();
      await invalidate();
      flash('success', `Deleted "${job.name}".`);
    } catch (err: any) {
      flash('error', err?.message || 'Could not delete the task.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="room-scroll r-scroll forge-room">
      <RoomHeader
        eyebrow={ROOM_NAMES.forge.eyebrow}
        title="Scheduled tasks"
        subtitle={`${jobs.length} tasks. ${activeCount} active, ${pausedCount} paused${failedCount ? `, ${failedCount} failed` : ''}.`}
        actions={
          <>
            <Button tone="ghost" onClick={() => refetch()}>
              <RotateCcw size={15} />
              Refresh
            </Button>
            <Button tone="gold" onClick={startCreate}>
              <Plus size={15} />
              New task
            </Button>
          </>
        }
      />

      {notice ? (
        <div
          className={`cron-notice notice-${notice.kind}`}
          role={notice.kind === 'error' ? 'alert' : 'status'}
          onClick={() => setNotice(null)}
        >
          {notice.kind === 'error' ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />}
          <span>{notice.text}</span>
        </div>
      ) : null}

      <div className="forge-studio forge-studio-simple">
        <section className="cron-list-panel">
          <div className="section-head">
            <div>
              <p className="r-eyebrow-gold">Tasks</p>
              <h2>Existing schedules</h2>
            </div>
          </div>

          <div className="cron-card-list">
            {sortedJobs.length ? (
              sortedJobs.map((job) => {
                const eng = engineDisplay(job);
                return (
                <article
                  className={`cron-card status-${job.status} engine-${job.engine === 'claude' ? 'assistant' : (job.engine || 'assistant')} source-${job.source || 'assistant-mcp'} ${job.readOnly ? 'is-readonly' : ''} ${selected?.id === job.id ? 'is-selected' : ''}`}
                  key={job.id}
                  onClick={() => setSelectedId(job.id)}
                >
                  <div className="cron-card-main">
                    <span className={`status-pin status-${job.status}`} />
                    <div>
                      <h3>{job.name}</h3>
                      <p>{job.prompt || 'No prompt saved.'}</p>
                    </div>
                  </div>
                  <div className="cron-card-meta">
                    <Chip tone={job.status === 'active' ? 'emerald' : job.status === 'failed' ? 'rose' : 'neutral'}>
                      {job.status}
                    </Chip>
                    <span title={`${eng.label}${eng.modelId ? ` · ${eng.modelId}` : ''}${job.reasoningEffort ? ` · ${job.reasoningEffort}` : ''}`}>
                      <Bot size={13} />
                      {eng.label}{eng.modelId ? ` · ${eng.modelId}` : ''}{job.reasoningEffort ? ` · ${job.reasoningEffort}` : ''}
                    </span>
                    {job.sourceLabel && job.source !== 'assistant-mcp' ? (
                      <span title={job.description || job.sourceLabel}>
                        <Sparkles size={13} />
                        {job.sourceLabel}
                      </span>
                    ) : null}
                    <span>
                      <CalendarClock size={13} />
                      {humanizeCron(job.schedule)}
                    </span>
                    <span title={displayRepo(job) || 'No repo saved'}>
                      <Code2 size={13} />
                      {shortRepo(displayRepo(job))}
                    </span>
                  </div>
                  <div className="cron-card-actions" onClick={(event) => event.stopPropagation()}>
                    {job.readOnly ? (
                      <span className="cron-readonly-note">Managed in {job.sourceLabel || 'source'}</span>
                    ) : (
                      <>
                        <button type="button" onClick={() => toggle(job)} disabled={busyId === job.id} title={cronIsPaused(job) ? 'Resume schedule' : 'Pause schedule'}>
                          {cronIsPaused(job) ? <Play size={14} /> : <Pause size={14} />}
                        </button>
                        <button type="button" onClick={() => runNow(job)} disabled={busyId === job.id} title="Run once now">
                          <Zap size={14} />
                        </button>
                        <button type="button" onClick={() => startEdit(job)} title="Edit">
                          <Pencil size={14} />
                        </button>
                        <button type="button" onClick={() => remove(job)} disabled={busyId === job.id} title="Delete">
                          <Trash2 size={14} />
                        </button>
                      </>
                    )}
                  </div>
                </article>
                );
              })
            ) : (
              <EmptyState
                title="No scheduled tasks yet"
                body="Create one with a title, model, schedule, and prompt."
              />
            )}
          </div>
        </section>

        <aside className="cron-detail-panel">
          {editingId ? (
            <form className="cron-editor cron-editor-simple" onSubmit={save}>
              <div className="section-head">
                <div>
                  <p className="r-eyebrow-gold">{isCreating ? 'New task' : 'Edit task'}</p>
                  <h2>{isCreating ? 'Create schedule' : editing?.name}</h2>
                </div>
                <button type="button" onClick={closeEditor} title="Close editor">
                  <X size={16} />
                </button>
              </div>

              <label className="cron-field">
                Task title
                <input
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  placeholder="Morning brief"
                  autoFocus
                />
              </label>

              <div className="cron-field">
                Engine
                <select
                  className="cron-engine-select"
                  value={draft.engine}
                  onChange={(event) => {
                    const engine = event.target.value;
                    setDraft({ ...draft, engine, ...initialSelectionFor(engine) });
                  }}
                >
                  {CRON_ENGINES.map((e) => (
                    <option key={e.id} value={e.id}>{e.label}</option>
                  ))}
                </select>
                <small className="cron-engine-hint">{engineHint(draft.engine)}</small>
              </div>

              <div className="cron-field">
                Model
                <select
                  className="cron-engine-select"
                  value={draft.model}
                  onChange={(event) => {
                    const model = event.target.value;
                    const effort = draft.engine === 'codex'
                      ? normalizeCodexEffort(model, draft.effort)
                      : draft.effort;
                    setDraft({ ...draft, model, effort });
                  }}
                >
                  {modelOptions.length === 0 && (
                    <option value="">No models</option>
                  )}
                  {modelOptions.map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
              </div>

              {draft.engine === 'codex' ? (
                <div className="cron-field">
                  Reasoning effort
                  <select
                    aria-label="Codex reasoning effort"
                    className="cron-engine-select"
                    value={draft.effort}
                    onChange={(event) => setDraft({
                      ...draft,
                      effort: normalizeCodexEffort(draft.model, event.target.value),
                    })}
                  >
                    {codexEffortOptions.map((effort) => (
                      <option key={effort} value={effort}>{effort}</option>
                    ))}
                  </select>
                </div>
              ) : null}

              <div className="cron-field">
                Schedule
                <select
                  className="cron-engine-select"
                  value={draft.schedMode === 'custom' ? 'custom' : draft.freq}
                  onChange={(event) => {
                    const val = event.target.value;
                    if (val === 'custom') { setDraft({ ...draft, schedMode: 'custom' }); return; }
                    setDraft({ ...draft, schedMode: 'simple', freq: val, schedule: buildCron(val, draft.schedTime, draft.schedDow) });
                  }}
                >
                  {FREQ_OPTIONS.map((f) => (
                    <option key={f.id} value={f.id}>{f.label}</option>
                  ))}
                  <option value="custom">Custom…</option>
                </select>
              </div>

              {draft.schedMode === 'simple' && freqNeedsTime(draft.freq) && (
                <div className="cron-field">
                  Time
                  <select
                    className="cron-engine-select"
                    value={draft.schedTime}
                    onChange={(event) => setDraft({ ...draft, schedTime: event.target.value, schedule: buildCron(draft.freq, event.target.value, draft.schedDow) })}
                  >
                    {TIME_OPTIONS.map((t) => (
                      <option key={t.id} value={t.id}>{t.label}</option>
                    ))}
                  </select>
                </div>
              )}

              {draft.schedMode === 'simple' && draft.freq === 'weekly' && (
                <div className="cron-field">
                  Day
                  <select
                    className="cron-engine-select"
                    value={draft.schedDow}
                    onChange={(event) => setDraft({ ...draft, schedDow: event.target.value, schedule: buildCron(draft.freq, draft.schedTime, event.target.value) })}
                  >
                    {DAY_OPTIONS.map((d) => (
                      <option key={d.id} value={d.id}>{d.label}</option>
                    ))}
                  </select>
                </div>
              )}

              {draft.schedMode === 'custom' && (
                <label className="cron-field">
                  Custom schedule
                  <input
                    value={draft.schedule}
                    onChange={(event) => setDraft({ ...draft, schedule: event.target.value })}
                    placeholder="every 10 minutes, daily 6am, or a cron expression"
                    autoFocus
                  />
                </label>
              )}

              <small className="cron-schedule-hint">
                Runs {draft.schedMode === 'custom' ? describeSchedule(draft.schedule).toLowerCase() : describeSimple(draft.freq, draft.schedTime, draft.schedDow)}
              </small>

              <label className="cron-field">
                Prompt
                <textarea
                  value={draft.prompt}
                  onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
                  placeholder="Describe the recurring work. Be specific about the result you want."
                  rows={8}
                />
              </label>

              <label className="cron-field">
                <span>Repo <span className="cron-optional">optional</span></span>
                <input
                  value={draft.repo}
                  onChange={(event) => setDraft({ ...draft, repo: event.target.value })}
                  placeholder="Leave blank for no repo"
                />
              </label>

              {cannotSave ? (
                <p className="form-error">
                  {missingRequiredModel
                    ? 'Choose a model before saving.'
                    : 'Fill in the task title, schedule, and prompt before saving.'}
                </p>
              ) : null}

              <div className="cron-editor-actions">
                <Button tone="ghost" type="button" onClick={closeEditor} disabled={busyId === (editingId || 'new')}>Cancel</Button>
                <Button tone="gold" type="submit" disabled={cannotSave || busyId === (editingId || 'new')}>
                  <Save size={14} />
                  {busyId === (editingId || 'new') ? 'Saving…' : 'Save task'}
                </Button>
              </div>
            </form>
          ) : selected ? (
            <CronDetails
              key={selected.id}
              job={selected}
              onEdit={() => startEdit(selected)}
              onRun={() => runNow(selected)}
              onToggle={() => toggle(selected)}
              onDelete={() => remove(selected)}
              busy={busyId === selected.id}
            />
          ) : (
            <EmptyState
              title="Pick a scheduled task"
              body="The details panel shows the title, model, schedule, prompt, and repo."
            />
          )}
        </aside>
      </div>
    </div>
  );
}

// The schedule's on/off state is independent of the last run's pass/fail.
// A job can be enabled (running) yet show "failed" from its last run, so the
// pause/resume control must follow `paused`, not the derived display status.
function cronIsPaused(job: CronJob): boolean {
  return job.paused ?? job.status === 'paused';
}

function CronDetails({ job, onEdit, onRun, onToggle, onDelete, busy }: {
  job: CronJob;
  onEdit: () => void;
  onRun: () => void;
  onToggle: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const eng = engineDisplay(job);
  const repo = displayRepo(job);
  const [expanded, setExpanded] = useState<string | null>(null);
  // TanStack Query: dedup + abort + single-flight polling, so a slow upstream
  // can't stack overlapping requests or overwrite newer history.
  const history = useCronHistory(job.id, !job.readOnly);
  const runs = history.data?.runs ?? [];
  const runsError = history.isError ? cleanHistoryError(history.error) : null;
  const runsLoading = history.isLoading && !history.isError;

  return (
    <Surface className="cron-detail-card cron-detail-simple">
      <div className="section-head">
        <div>
          <p className="r-eyebrow-gold">Selected task</p>
          <h2>{job.name}</h2>
        </div>
        <div className="cron-detail-chips">
          <Chip tone={job.status === 'active' ? 'emerald' : job.status === 'failed' ? 'rose' : 'neutral'}>{job.status}</Chip>
          <Chip tone="elf">{eng.label}{eng.modelId ? ` · ${eng.modelId}` : ''}{job.reasoningEffort ? ` · ${job.reasoningEffort}` : ''}</Chip>
          {job.sourceLabel && job.source !== 'assistant-mcp' ? <Chip tone="elf">{job.sourceLabel}</Chip> : null}
          {job.readOnly ? <Chip>Read only</Chip> : null}
        </div>
      </div>

      <dl className="cron-facts">
        <div>
          <dt>Task title</dt>
          <dd>{job.name}</dd>
        </div>
        <div>
          <dt>Engine</dt>
          <dd>
            {eng.label}
            {eng.modelId ? <> · <code>{eng.modelId}</code></> : null}
          </dd>
        </div>
        {job.reasoningEffort ? (
          <div>
            <dt>Reasoning effort</dt>
            <dd><code>{job.reasoningEffort}</code></dd>
          </div>
        ) : null}
        <div>
          <dt>Schedule</dt>
          <dd>{humanizeCron(job.schedule)} <code>{job.schedule}</code></dd>
        </div>
        <div>
          <dt>Repo</dt>
          <dd><code>{repo || 'No repo saved'}</code></dd>
        </div>
        <div>
          <dt>Last run</dt>
          <dd>
            {job.lastRunAt ? <>{timeAgoLabel(job.lastRunAt)} · {job.lastRunStatus || 'unknown'}</> : 'never'}
          </dd>
        </div>
      </dl>

      <div className="cron-prompt-preview">
        <p className="r-eyebrow">Prompt</p>
        <pre>{job.prompt || 'No prompt saved.'}</pre>
      </div>

      {job.lastRunError ? (
        <div className="cron-error">
          <p className="r-eyebrow">Last error</p>
          <pre>{job.lastRunError}</pre>
        </div>
      ) : null}

      <CronHistory
        runs={runs}
        loading={runsLoading}
        error={runsError}
        readOnly={job.readOnly}
        expanded={expanded}
        onToggle={setExpanded}
        onRefresh={() => history.refetch()}
      />

      <div className="cron-detail-actions">
        {job.readOnly ? (
          <span className="cron-readonly-note">Managed in {job.sourceLabel || 'source'}</span>
        ) : (
          <>
            <Button tone="elf" onClick={onToggle} disabled={busy}>
              {cronIsPaused(job) ? <Play size={14} /> : <Pause size={14} />}
              {cronIsPaused(job) ? 'Resume' : 'Pause'}
            </Button>
            <Button tone="ghost" onClick={onRun} disabled={busy}>
              <Zap size={14} />
              Run once
            </Button>
            <Button tone="gold" onClick={onEdit}>
              <Pencil size={14} />
              Edit
            </Button>
            <Button tone="danger" onClick={onDelete} disabled={busy} title="Delete this task">
              <Trash2 size={14} />
              Delete
            </Button>
          </>
        )}
      </div>
    </Surface>
  );
}

function CronHistory({ runs, loading, error, readOnly, expanded, onToggle, onRefresh }: {
  runs: CronRun[];
  loading: boolean;
  error: string | null;
  readOnly?: boolean;
  expanded: string | null;
  onToggle: (id: string | null) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="cron-history">
      <div className="cron-history-head">
        <p className="r-eyebrow"><History size={13} /> Run history</p>
        {!readOnly ? (
          <button type="button" className="cron-history-refresh" onClick={onRefresh} title="Refresh history">
            <RotateCcw size={13} />
          </button>
        ) : null}
      </div>
      {readOnly ? (
        <p className="cron-history-empty">This task is managed by another system, so per-run history isn’t tracked here.</p>
      ) : error ? (
        <p className="cron-history-empty">{error}</p>
      ) : loading && runs.length === 0 ? (
        <p className="cron-history-empty">Loading runs…</p>
      ) : runs.length === 0 ? (
        <p className="cron-history-empty">No runs yet. Trigger it with “Run once.”</p>
      ) : (
        <ul className="cron-history-list">
          {runs.map((run) => {
            const outcome = runOutcome(run.status);
            const Icon = outcome === 'ok' ? CheckCircle2 : outcome === 'failed' ? XCircle : RotateCcw;
            const text = runResultText(run);
            const isOpen = expanded === run.id;
            return (
              <li key={run.id} className={`cron-run outcome-${outcome}`}>
                <button
                  type="button"
                  className="cron-run-head"
                  onClick={() => onToggle(isOpen ? null : run.id)}
                  title={text ? 'Show output' : ''}
                >
                  <Icon size={14} />
                  <span className="cron-run-status">{run.status}</span>
                  <span className="cron-run-time">{run.startedAt ? timeAgoLabel(run.startedAt) : ''}</span>
                  {run.durationMs != null ? <span className="cron-run-dur">{formatDuration(run.durationMs)}</span> : null}
                </button>
                {isOpen && text ? (
                  <pre className="cron-run-output">{text.slice(0, 1200)}</pre>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function draftFromJob(job: CronJob): CronDraft {
  // Clamp to one of the three subscription engines so editing a legacy/unknown job
  // lands on a valid choice instead of a phantom dropdown value.
  // A legacy `claude` job falls through to the current assistant lane.
  const fallback = job.aiModel === 'codex' ? 'codex' : 'assistant';
  const rawEngine = job.engine && KNOWN_ENGINES.has(job.engine) ? job.engine : fallback;
  const cron = job.schedule || '';
  const parsed = parseCron(cron);
  // Validate the stored model against the (possibly clamped) engine so a legacy
  // job never carries an incompatible model id into a save.
  const model = validModelFor(rawEngine, job.modelId);
  return {
    name: job.name,
    engine: rawEngine,
    model,
    effort: rawEngine === 'codex'
      ? normalizeCodexEffort(model, job.reasoningEffort)
      : '',
    schedMode: parsed ? 'simple' : 'custom',
    freq: parsed?.freq ?? 'daily',
    schedTime: parsed?.time ?? '09:00',
    schedDow: parsed?.dow ?? '1',
    schedule: parsed ? cron : cronToInput(cron),
    prompt: job.prompt || '',
    repo: displayRepo(job),
    status: job.status === 'failed' ? 'paused' : job.status,
  };
}

function validModelFor(engine: string, modelId: string | undefined): string {
  const list = staticModelsForEngine(engine);
  if (modelId && list.some((m) => m.id === modelId)) return modelId;
  return engine === 'codex' ? DEFAULT_CODEX_MODEL : list[0]?.id ?? '';
}

function normalizeDraft(draft: CronDraft): Partial<CronJob> {
  const engine = draft.engine;
  const aiModel = coarseAiModel(engine);
  const repo = draft.repo.trim();
  const schedule = resolveScheduleInput(draft.schedule);

  return {
    name: draft.name.trim(),
    description: '',
    schedule: schedule.cron,
    target: engineLabel(engine),
    actionType: 'ai_prompt',
    prompt: draft.prompt.trim(),
    aiModel,
    engine,
    modelId: draft.model.trim() || undefined,
    reasoningEffort: engine === 'codex'
      ? normalizeCodexEffort(draft.model, draft.effort)
      : undefined,
    repo: repo || undefined,
    toolName: '',
    deliveryChannel: 'log_only',
    maxTokens: 2048,
    status: draft.status,
    // Every engine runs through its authenticated CLI on the local cron runner.
    runtime: 'local',
    cwd: repo || undefined,
    permissionMode: undefined,
  };
}

type ScheduleResolution = {
  cron: string;
  label: string;
  valid: boolean;
};

function describeSchedule(schedule: string): string {
  return resolveScheduleInput(schedule).label;
}

function timeAgoLabel(value: string): string {
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) return value;
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Intl.DateTimeFormat([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ts));
}

function displayRepo(job: CronJob): string {
  if (job.repo) return job.repo;
  if (job.cwd && !isWorkspaceRoot(job.cwd)) return job.cwd;
  return '';
}

function resolveScheduleInput(input: string): ScheduleResolution {
  const raw = input.trim();
  const normalized = normalizeScheduleText(raw);
  if (!normalized) {
    return { cron: '0 9 * * *', label: 'Runs daily at 9:00 AM', valid: true };
  }

  const preset = schedulePresets.find(
    (item) => normalized === normalizeScheduleText(item.value) ||
      normalized === normalizeScheduleText(item.label) ||
      raw === item.cron,
  );
  if (preset) return { cron: preset.cron, label: `Runs ${preset.label.toLowerCase()}`, valid: true };

  const everyMinutes = normalized.match(/^every\s+(\d+)\s*(?:m|min|mins|minute|minutes)$/);
  if (everyMinutes) {
    const minutes = Number(everyMinutes[1]);
    if (minutes >= 1 && minutes <= 59) {
      return { cron: minutes === 1 ? '* * * * *' : `*/${minutes} * * * *`, label: `Runs every ${minutes} minute${minutes === 1 ? '' : 's'}`, valid: true };
    }
    return { cron: '', label: 'Use 1 to 59 minutes for minute intervals.', valid: false };
  }

  const everyHours = normalized.match(/^every\s+(\d+)\s*(?:h|hr|hrs|hour|hours)$/);
  if (everyHours) {
    const hours = Number(everyHours[1]);
    if (hours >= 1 && hours <= 23) {
      return { cron: hours === 1 ? '0 * * * *' : `0 */${hours} * * *`, label: `Runs every ${hours} hour${hours === 1 ? '' : 's'}`, valid: true };
    }
    return { cron: '', label: 'Use 1 to 23 hours for hourly intervals.', valid: false };
  }

  const everyDays = normalized.match(/^every\s+(\d+)\s*(?:day|days)(?:\s+(.*))?$/);
  if (everyDays) {
    const days = Number(everyDays[1]);
    const time = parseTimeText(everyDays[2] || '9am');
    if (days >= 1 && days <= 31 && time) {
      return {
        cron: `${time.minute} ${time.hour} ${days === 1 ? '*' : `*/${days}`} * *`,
        label: `Runs every ${days} day${days === 1 ? '' : 's'} at ${formatCronTime(String(time.hour), String(time.minute))}`,
        valid: true,
      };
    }
    return { cron: '', label: 'Use a day interval from 1 to 31 with a valid time.', valid: false };
  }

  const daily = normalized.match(/^(?:daily|every day)(?:\s+(.*))?$/);
  if (daily) {
    const time = parseTimeText(daily[1] || '9am');
    if (time) {
      return {
        cron: `${time.minute} ${time.hour} * * *`,
        label: `Runs daily at ${formatCronTime(String(time.hour), String(time.minute))}`,
        valid: true,
      };
    }
  }

  const weekdays = normalized.match(/^(?:weekdays|weekday|m-f|mon-fri|monday-friday)(?:\s+(.*))?$/);
  if (weekdays) {
    const time = parseTimeText(weekdays[1] || '9am');
    if (time) {
      return {
        cron: `${time.minute} ${time.hour} * * 1-5`,
        label: `Runs weekdays at ${formatCronTime(String(time.hour), String(time.minute))}`,
        valid: true,
      };
    }
  }

  const mondayFriday = normalized.match(/^(?:m\/f|mon\/fri|monday\/friday|mondays\/fridays)(?:\s+(.*))?$/);
  if (mondayFriday) {
    const time = parseTimeText(mondayFriday[1] || '9am');
    if (time) {
      return {
        cron: `${time.minute} ${time.hour} * * 1,5`,
        label: `Runs Monday and Friday at ${formatCronTime(String(time.hour), String(time.minute))}`,
        valid: true,
      };
    }
  }

  const weekday = normalized.match(/^(?:every\s+)?(sun|sunday|mon|monday|tue|tues|tuesday|wed|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday)s?(?:\s+(.*))?$/);
  if (weekday) {
    const day = weekdayToCron(weekday[1]);
    const time = parseTimeText(weekday[2] || '9am');
    if (day !== null && time) {
      return {
        cron: `${time.minute} ${time.hour} * * ${day}`,
        label: `Runs ${weekdayName(day)} at ${formatCronTime(String(time.hour), String(time.minute))}`,
        valid: true,
      };
    }
  }

  if (isFiveFieldCron(raw)) {
    return { cron: raw, label: humanizeCron(raw), valid: true };
  }

  return { cron: '', label: 'Try phrases like every 10 minutes, daily 6am, weekdays 8:30am, or mon/fri 7am.', valid: false };
}

function cronToInput(cron: string): string {
  const preset = schedulePresets.find((item) => item.cron === cron);
  if (preset) return preset.value;

  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [minute, hour, day, month, weekday] = parts;
  const minuteStep = minute.match(/^\*\/([1-9]\d*)$/);
  if (minuteStep && hour === '*' && day === '*' && month === '*' && weekday === '*') return `every ${minuteStep[1]} minutes`;
  const hourStep = hour.match(/^\*\/([1-9]\d*)$/);
  if (minute === '0' && hourStep && day === '*' && month === '*' && weekday === '*') return `every ${hourStep[1]} hours`;
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && day === '*' && month === '*' && weekday === '*') return `daily ${formatInputTime(hour, minute)}`;
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && day === '*' && month === '*' && weekday === '1-5') return `weekdays ${formatInputTime(hour, minute)}`;
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && day === '*' && month === '*' && weekday === '1,5') return `mon/fri ${formatInputTime(hour, minute)}`;
  return cron;
}

function humanizeCron(cron: string): string {
  const preset = schedulePresets.find((item) => item.cron === cron);
  if (preset) return preset.label;

  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [minute, hour, day, month, weekday] = parts;
  const minuteStep = minute.match(/^\*\/([1-9]\d*)$/);
  if (minuteStep && hour === '*' && day === '*' && month === '*' && weekday === '*') return `Every ${minuteStep[1]} min`;
  const hourStep = hour.match(/^\*\/([1-9]\d*)$/);
  if (minute === '0' && hourStep && day === '*' && month === '*' && weekday === '*') return `Every ${hourStep[1]} hours`;
  if (minute === '0' && hour === '*' && day === '*' && month === '*' && weekday === '*') return 'Hourly';
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && day === '*' && month === '*' && weekday === '*') return `Daily ${formatCronTime(hour, minute)}`;
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && day === '*' && month === '*' && weekday === '1-5') return `Weekdays ${formatCronTime(hour, minute)}`;
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && day === '*' && month === '*' && weekday === '1,5') return `M/F ${formatCronTime(hour, minute)}`;
  return 'Custom schedule';
}

function normalizeScheduleText(value: string): string {
  return value.trim().toLowerCase().replace(/\bat\s+/g, '').replace(/\s+/g, ' ');
}

function isFiveFieldCron(value: string): boolean {
  const parts = value.trim().split(/\s+/);
  return parts.length === 5 && parts.every((part) => /^[\d*,/-]+$/.test(part));
}

function parseTimeText(value: string): { hour: number; minute: number } | null {
  const normalized = normalizeScheduleText(value || '9am');
  const match = normalized.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3];
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute < 0 || minute > 59) return null;
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (hour < 0 || hour > 23) return null;
  return { hour, minute };
}

function formatCronTime(hour: string, minute: string): string {
  const hourNumber = Number(hour);
  const minuteNumber = Number(minute);
  if (!Number.isFinite(hourNumber) || !Number.isFinite(minuteNumber)) return `${hour}:${minute}`;
  const suffix = hourNumber >= 12 ? 'PM' : 'AM';
  const displayHour = hourNumber % 12 || 12;
  return `${displayHour}:${String(minuteNumber).padStart(2, '0')} ${suffix}`;
}

function formatInputTime(hour: string, minute: string): string {
  return formatCronTime(hour, minute).toLowerCase().replace(' ', '');
}

function weekdayToCron(day: string): number | null {
  const normalized = day.toLowerCase();
  if (normalized.startsWith('sun')) return 0;
  if (normalized.startsWith('mon')) return 1;
  if (normalized.startsWith('tue')) return 2;
  if (normalized.startsWith('wed')) return 3;
  if (normalized.startsWith('thu')) return 4;
  if (normalized.startsWith('fri')) return 5;
  if (normalized.startsWith('sat')) return 6;
  return null;
}

function weekdayName(day: number): string {
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][day] || 'weekday';
}

function shortRepo(repo?: string): string {
  if (!repo) return 'No repo';
  const parts = repo.split('/').filter(Boolean);
  return parts.at(-1) || repo;
}
