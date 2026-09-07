// Agent editor — create/edit a teammate: identity, canonical brain, voice, and scope.

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Loader2, Play, Square, X } from 'lucide-react';
import {
  DEFAULT_XAI_EFFORT,
  DEFAULT_XAI_MODEL,
  DEFAULT_ZAI_EFFORT,
  DEFAULT_ZAI_MODEL,
  WORKSPACE_COMPANIONS,
  XAI_EFFORTS,
  XAI_MODELS,
  ZAI_EFFORTS,
  ZAI_MODELS,
} from '../chat/hooks/useCompanionPicker';
import { CLAUDE_EFFORTS, CLAUDE_MODELS } from '../chat/components/CodexEnginePicker';
import { CODEX_MODELS, DEFAULT_CODEX_MODEL, codexEffortsForModel, codexModelSpec } from '../chat/codexModels';
import { FIREWORKS_PROVIDER, OPENROUTER_PROVIDER } from '../chat/hooks/useBananaModel';
import { AgentUpdateConflictError, createAgent, updateAgentReq, deleteAgentReq, uploadAgentAvatar, removeAgentAvatar, agentAvatarUrl, DISC_INK, agentColor, type Agent } from './agents';
import { GROK_VOICES } from '../voice/useGrokCall';

type BrainModelOption = { id: string; label: string };

const BANANA_EFFORTS = ['low', 'medium', 'high'];

function defaultBrainSelection(engine: string): { model: string; effort: string } {
  if (engine === 'claude') return { model: CLAUDE_MODELS[0].id, effort: 'xhigh' };
  if (engine === 'codex') {
    return { model: DEFAULT_CODEX_MODEL, effort: codexModelSpec(DEFAULT_CODEX_MODEL).defaultEffort };
  }
  if (engine === 'zai') return { model: DEFAULT_ZAI_MODEL, effort: DEFAULT_ZAI_EFFORT };
  if (engine === 'xai') return { model: DEFAULT_XAI_MODEL, effort: DEFAULT_XAI_EFFORT };
  if (engine === 'banana') return { model: OPENROUTER_PROVIDER.defaultModel, effort: 'medium' };
  if (engine === 'banana-fireworks') return { model: FIREWORKS_PROVIDER.defaultModel, effort: 'medium' };
  return { model: '', effort: 'medium' };
}

function effortOptions(engine: string, model: string): string[] {
  if (engine === 'claude') return CLAUDE_EFFORTS;
  if (engine === 'codex') return codexEffortsForModel(model);
  if (engine === 'zai') return ZAI_EFFORTS;
  if (engine === 'xai') return XAI_EFFORTS;
  return BANANA_EFFORTS;
}

function staticModelOptions(engine: string): BrainModelOption[] {
  if (engine === 'claude') return CLAUDE_MODELS;
  if (engine === 'codex') return CODEX_MODELS;
  if (engine === 'zai') return ZAI_MODELS;
  if (engine === 'xai') return XAI_MODELS;
  if (engine === 'banana') return OPENROUTER_PROVIDER.tiers;
  if (engine === 'banana-fireworks') return FIREWORKS_PROVIDER.tiers;
  return [];
}

function uniqueModels(options: BrainModelOption[]): BrainModelOption[] {
  const seen = new Set<string>();
  return options.filter((option) => {
    if (!option.id || seen.has(option.id)) return false;
    seen.add(option.id);
    return true;
  });
}

export type AgentEditorProps = {
  open: boolean;
  /** Present in edit mode. */
  agent?: Agent;
  onClose: () => void;
  onSaved: (agent: Agent) => void;
  onDeleted: (agent: Agent) => void;
};

export function AgentEditor({ open, agent, onClose, onSaved, onDeleted }: AgentEditorProps) {
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [engine, setEngine] = useState('xai');
  const [brainRevision, setBrainRevision] = useState(1);
  const [model, setModel] = useState(DEFAULT_XAI_MODEL);
  const [effort, setEffort] = useState(DEFAULT_XAI_EFFORT);
  const [dynamicModels, setDynamicModels] = useState<Record<string, BrainModelOption[]>>({});
  const [modelsLoading, setModelsLoading] = useState(false);
  const [voice, setVoice] = useState('ara');
  const [voiceListOpen, setVoiceListOpen] = useState(false);
  const [preview, setPreview] = useState<{ id: string; status: 'loading' | 'playing' } | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const voiceWrapRef = useRef<HTMLDivElement | null>(null);
  const voiceTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [pinned, setPinned] = useState(false);
  const [muted, setMuted] = useState(false);
  const [scope, setScope] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [avatarVersion, setAvatarVersion] = useState<number | undefined>(undefined);
  const [dropHover, setDropHover] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const agentRef = useRef('');
  const savingRef = useRef(false);

  // Reset the form when the editor OPENS, or when it retargets to a
  // different agent (by id — object identity changes every agents poll, and
  // re-running this mid-edit would wipe the fields and steal the cursor).
  const agentId = agent?.id ?? '';
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (!open) { wasOpenRef.current = false; return; }
    const reopened = !wasOpenRef.current;
    wasOpenRef.current = true;
    if (!reopened && agentRef.current === agentId) return;
    agentRef.current = agentId;
    setName(agent?.name ?? '');
    setRole(agent?.role ?? '');
    const nextEngine = agent?.engine ?? 'xai';
    const defaults = defaultBrainSelection(nextEngine);
    const nextModel = agent?.model ?? defaults.model;
    const allowedEfforts = effortOptions(nextEngine, nextModel);
    setEngine(nextEngine);
    setBrainRevision(agent?.brainRevision ?? 1);
    setModel(nextModel);
    setEffort(agent?.effort && allowedEfforts.includes(agent.effort) ? agent.effort : defaults.effort);
    setVoice(agent?.voice ?? 'ara');
    setPinned(Boolean(agent?.pinned));
    setMuted(Boolean(agent?.muted));
    setScope('');
    setErr(null);
    setAvatarVersion(undefined);
    if (agent) {
      fetch(`/api/agents/${encodeURIComponent(agent.id)}/scope`)
        .then((r) => r.text())
        .then(setScope)
        .catch(() => setScope(''));
    }
    if (reopened) nameRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, agentId]);

  useEffect(() => {
    if (!open) return;
    const source = engine === 'banana'
      ? { endpoint: '/api/banana/models', prefix: 'openrouter' }
      : engine === 'banana-fireworks'
        ? { endpoint: '/api/fireworks/models', prefix: 'fireworks' }
        : engine === 'banana-local'
          ? { endpoint: '/api/local/models', prefix: 'local' }
          : null;
    if (!source) {
      setModelsLoading(false);
      return;
    }
    let cancelled = false;
    setModelsLoading(true);
    fetch(`${source.endpoint}?_=${Date.now()}`, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`model catalog returned ${response.status}`);
        return response.json() as Promise<{ data?: Array<{ id?: unknown; name?: unknown }> }>;
      })
      .then((payload) => {
        if (cancelled) return;
        const options = uniqueModels((payload.data ?? []).flatMap((entry) => {
          if (typeof entry.id !== 'string' || !entry.id.trim()) return [];
          const rawId = entry.id.trim();
          const id = rawId.startsWith(`${source.prefix}/`) ? rawId : `${source.prefix}/${rawId}`;
          const label = typeof entry.name === 'string' && entry.name.trim()
            ? entry.name.trim()
            : rawId.split('/').pop() || rawId;
          return [{ id, label }];
        }));
        setDynamicModels((current) => ({ ...current, [engine]: options }));
        setModel((current) => current || options[0]?.id || '');
      })
      .catch(() => { /* Preserve the current/default model if a catalog is offline. */ })
      .finally(() => { if (!cancelled) setModelsLoading(false); });
    return () => { cancelled = true; };
  }, [open, engine]);

  const stopVoicePreview = () => {
    previewAudioRef.current?.pause();
    previewAudioRef.current = null;
    setPreview(null);
  };

  // Stop any voice preview when the editor closes (and on unmount).
  useEffect(() => {
    if (open) return;
    stopVoicePreview();
    setVoiceListOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => () => {
    previewAudioRef.current?.pause();
    previewAudioRef.current = null;
  }, []);

  // Focus the selected row when the list opens (roving-focus listbox).
  useEffect(() => {
    if (!voiceListOpen) return;
    voiceWrapRef.current
      ?.querySelector<HTMLButtonElement>('.bt-voice-row.sel .bt-voice-name')
      ?.focus();
  }, [voiceListOpen]);

  // Close the voice list on outside pointerdown (same pattern as the
  // conversation settings menu).
  useEffect(() => {
    if (!voiceListOpen) return;
    const onDown = (e: PointerEvent) => {
      if (voiceWrapRef.current && !voiceWrapRef.current.contains(e.target as Node)) setVoiceListOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [voiceListOpen]);

  const toggleVoicePreview = (id: string) => {
    if (preview?.id === id) {
      stopVoicePreview();
      return;
    }
    stopVoicePreview();
    setPreview({ id, status: 'loading' });
    const audio = new Audio(`/api/voice-preview?voice=${encodeURIComponent(id)}`);
    previewAudioRef.current = audio;
    // Guard callbacks by the CURRENT audio element, not the voice id — in an
    // A→B→A click sequence the first A's late events must not touch the new A.
    const isCurrent = () => previewAudioRef.current === audio;
    const fail = () => {
      if (!isCurrent()) return;
      previewAudioRef.current = null;
      setPreview(null);
      setErr('Voice preview failed — check the xAI key and try again.');
    };
    audio.onplaying = () => { if (isCurrent()) setPreview({ id, status: 'playing' }); };
    audio.onended = () => { if (isCurrent()) { previewAudioRef.current = null; setPreview(null); } };
    audio.onerror = fail;
    void audio.play().catch(fail);
  };

  const onVoiceListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const names = Array.from(
      (e.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('.bt-voice-name'),
    );
    if (!names.length) return;
    const idx = names.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = idx < 0
        ? (e.key === 'ArrowDown' ? 0 : names.length - 1)
        : (idx + (e.key === 'ArrowDown' ? 1 : -1) + names.length) % names.length;
      names[next]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      names[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      names[names.length - 1]?.focus();
    } else if (e.key === 'ArrowRight' || e.key.toLowerCase() === 'p') {
      // Preview the focused option's voice (play buttons stay out of tab order).
      if (idx >= 0) {
        e.preventDefault();
        const target = GROK_VOICES[idx];
        if (target) toggleVoicePreview(target.id);
      }
    } else if (e.key === 'Escape') {
      // Close just the list and return focus to the trigger (the dialog has
      // its own Esc handler — stopPropagation keeps it from closing too).
      e.preventDefault();
      e.stopPropagation();
      setVoiceListOpen(false);
      voiceTriggerRef.current?.focus();
    }
  };

  // Keyed on `open` ONLY — inline `onClose` from the parent changes identity
  // every agents poll, which re-ran this effect and yanked focus back to a
  // stale element mid-typing (the "cursor keeps jumping" bug).
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.activeElement as HTMLElement | null;
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open]);

  const configuredModels = uniqueModels([
    ...staticModelOptions(engine),
    ...(dynamicModels[engine] ?? []),
  ]);
  const modelOptions = model && !configuredModels.some((option) => option.id === model)
    ? [{ id: model, label: model }, ...configuredModels]
    : configuredModels;
  const availableEfforts = effortOptions(engine, model);
  const chooseEngine = (nextEngine: string) => {
    const defaults = defaultBrainSelection(nextEngine);
    setEngine(nextEngine);
    setModel(defaults.model);
    setEffort(defaults.effort);
  };
  const chooseModel = (nextModel: string) => {
    const options = effortOptions(engine, nextModel);
    const fallback = defaultBrainSelection(engine).effort;
    setModel(nextModel);
    setEffort((current) => options.includes(current) ? current : fallback);
  };

  if (!open) return null;

  const applyAvatar = async (file: File) => {
    if (!agent || !file.type.startsWith('image/')) { setErr('Pick an image file.'); return; }
    setBusy(true); setErr(null);
    try {
      const updated = await uploadAgentAvatar(agent.id, file);
      setAvatarVersion(updated.avatar ?? Date.now());
      onSaved(updated);
    } catch (e) {
      setErr((e as Error).message || 'Upload failed');
    } finally { setBusy(false); }
  };

  const save = async () => {
    if (!name.trim()) { setErr('Name is required.'); return; }
    if (savingRef.current) return; // synchronous double-submit guard (busy state flushes too late)
    savingRef.current = true;
    setBusy(true);
    setErr(null);
    try {
      const brain = { engine, model: model || undefined, effort };
      const saved = agent
        ? await updateAgentReq(agent.id, { name, role, ...brain, brainRevision, voice, pinned, muted, scope: scope.trim() || undefined })
        : await createAgent({ name, role, ...brain, voice, scope: scope.trim() || undefined });
      onSaved(saved);
      onClose();
    } catch (e) {
      if (e instanceof AgentUpdateConflictError) {
        const current = e.current;
        const defaults = defaultBrainSelection(current.engine);
        const currentModel = current.model ?? defaults.model;
        const options = effortOptions(current.engine, currentModel);
        setEngine(current.engine);
        setModel(currentModel);
        setEffort(current.effort && options.includes(current.effort) ? current.effort : defaults.effort);
        setBrainRevision(current.brainRevision ?? 1);
        onSaved(current);
        setErr('Brain settings changed on another device. Refreshed them here; review and save again.');
      } else {
        setErr((e as Error).message || 'Save failed');
      }
    } finally {
      savingRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="bt-legal-scrim" onClick={onClose} role="dialog" aria-modal="true" aria-label={agent ? 'Edit companion' : 'New companion'}>
      <div className="bt-agent-editor bt-fade" onClick={(e) => e.stopPropagation()}>
        <div className="bt-agent-editor-head">
          <span className="bt-agent-editor-title">{agent ? `Edit ${agent.name}` : 'New companion'}</span>
          <button className="bt-iconbtn" onClick={onClose} aria-label="Close" title="Close (Esc)">
            <X size={16} />
          </button>
        </div>

        {agent ? (
          <div className="bt-avatar-row">
            <div
              className={`bt-avatar-preview${dropHover ? ' bt-avatar-drop' : ''}`}
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDropHover(true); }}
              onDragLeave={() => setDropHover(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDropHover(false);
                const f = e.dataTransfer.files?.[0];
                if (f) void applyAvatar(f);
              }}
              role="button"
              aria-label="Upload avatar"
              title="Click or drop a picture"
            >
              {(() => {
                const version = avatarVersion === -1 ? undefined : avatarVersion ?? agent.avatar;
                return version
                  ? <img src={`/api/agents/${encodeURIComponent(agent.id)}/avatar?v=${version}`} alt={agent.name} />
                  : <span style={{ background: agentColor(agent.name), width: '100%', height: '100%', display: 'grid', placeItems: 'center', color: DISC_INK }}>{agent.name.slice(0, 1).toUpperCase()}</span>;
              })()}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void applyAvatar(f); e.target.value = ''; }}
            />
            <div>
              <div className="bt-avatar-hint">Avatar — click the disc or drop a picture. Square-cropped to a round badge.</div>
              <div className="bt-avatar-btns">
                <button className="bt-avatar-btn" disabled={busy} onClick={() => fileRef.current?.click()}>Upload photo</button>
                {(avatarVersion ?? agent.avatar) ? (
                  <button className="bt-avatar-btn" disabled={busy} onClick={async () => {
                    setBusy(true); setErr(null);
                    try {
                      const updated = await removeAgentAvatar(agent.id);
                      setAvatarVersion(updated?.avatar ?? -1);
                      onSaved(updated ?? agent);
                    } catch (e) {
                      setErr((e as Error).message || 'Remove failed');
                    } finally { setBusy(false); }
                  }}>Remove</button>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}

        <label className="bt-agent-field">
          <span>Name</span>
          <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} placeholder="Chief of Staff" maxLength={60} />
        </label>

        <label className="bt-agent-field">
          <span>Role — one line, shown under the name</span>
          <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Coordination, plans, delegation" maxLength={120} />
        </label>

        <label className="bt-agent-field">
          <span>Engine — the brain this agent runs on</span>
          <select value={engine} onChange={(e) => chooseEngine(e.target.value)}>
            {WORKSPACE_COMPANIONS.map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
        </label>

        <div className="bt-agent-brain-grid">
          <label className="bt-agent-field">
            <span>Model — the exact brain used everywhere</span>
            <select value={model} onChange={(e) => chooseModel(e.target.value)} disabled={modelsLoading && modelOptions.length === 0}>
              {modelOptions.length === 0 ? (
                <option value="">{modelsLoading ? 'Loading models…' : 'No model available'}</option>
              ) : modelOptions.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
          </label>

          <label className="bt-agent-field">
            <span>{engine === 'banana-local' || engine === 'zai' || engine === 'xai' ? 'Thinking' : 'Reasoning effort'}</span>
            <select value={effort} onChange={(e) => setEffort(e.target.value)}>
              {availableEfforts.map((option) => (
                <option key={option} value={option}>{option[0].toUpperCase() + option.slice(1)}</option>
              ))}
            </select>
          </label>
        </div>

        {agent ? (
          <>
            <label className="bt-agent-checkrow" title="Pinned companions show as bubbles at the top of the sidebar">
              <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
              <span>
                Pin to top
                <small>Show as a bubble above the list</small>
              </span>
            </label>
            <label className="bt-agent-checkrow" title="Muted companions keep working with the crew but never badge">
              <input type="checkbox" checked={muted} onChange={(e) => setMuted(e.target.checked)} />
              <span>
                Mute notifications
                <small>Hide unread badges — for companions that talk to other agents, not you</small>
              </span>
            </label>
          </>
        ) : null}

        <div className="bt-agent-field">
          <span>Voice — how this agent sounds on calls</span>
          <div className="bt-voice-wrap" ref={voiceWrapRef}>
            <button
              type="button"
              ref={voiceTriggerRef}
              className="bt-voice-current"
              onClick={() => setVoiceListOpen((o) => !o)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setVoiceListOpen(true); }
              }}
              aria-haspopup="listbox"
              aria-expanded={voiceListOpen}
            >
              <span>{GROK_VOICES.find((v) => v.id === voice)?.label ?? voice}</span>
              <ChevronDown size={14} />
            </button>
            <button
              type="button"
              className="bt-voice-play"
              onClick={() => toggleVoicePreview(voice)}
              aria-label={`Preview ${GROK_VOICES.find((v) => v.id === voice)?.label ?? voice}`}
              title="Hear this voice"
            >
              {preview?.id === voice && preview.status === 'loading'
                ? <Loader2 size={14} className="bt-spin" />
                : preview?.id === voice
                  ? <Square size={13} />
                  : <Play size={14} />}
            </button>
            {voiceListOpen ? (
              <div className="bt-voice-list" role="listbox" aria-label="Voices" onKeyDown={onVoiceListKeyDown}>
                {GROK_VOICES.map((v) => (
                  <div key={v.id} className={`bt-voice-row${v.id === voice ? ' sel' : ''}`}>
                    <button
                      type="button"
                      className="bt-voice-name"
                      role="option"
                      aria-selected={v.id === voice}
                      onClick={() => { setVoice(v.id); setVoiceListOpen(false); stopVoicePreview(); }}
                    >
                      {v.label}
                    </button>
                    <button
                      type="button"
                      className="bt-voice-play"
                      tabIndex={-1}
                      onClick={() => toggleVoicePreview(v.id)}
                      aria-label={`Preview ${v.label}`}
                      title={`Hear ${v.label}`}
                    >
                      {preview?.id === v.id && preview.status === 'loading'
                        ? <Loader2 size={14} className="bt-spin" />
                        : preview?.id === v.id
                          ? <Square size={13} />
                          : <Play size={14} />}
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        <label className="bt-agent-field">
          <span>Scope — who they are and what they do (markdown, editable here or in ~/.rivendell/personas/&lt;id&gt;.md)</span>
          <textarea
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            rows={9}
            placeholder={'# Name\n\nYou are …\n\n## What you do\n- …'}
            spellCheck={false}
          />
        </label>

        {err ? <div className="bt-agent-err">{err}</div> : null}

        <div className="bt-agent-editor-actions">
          {agent ? (
            <button
              className="bt-agent-btn danger"
              disabled={busy}
              onClick={async () => {
                if (!window.confirm(`Delete ${agent.name}? Its thread history stays on disk but the agent is removed.`)) return;
                setBusy(true);
                setErr(null);
                try {
                  await deleteAgentReq(agent.id);
                  onDeleted(agent);
                  onClose();
                } catch (e) {
                  setErr((e as Error).message || 'Delete failed');
                } finally {
                  setBusy(false);
                }
              }}
            >
              Delete agent
            </button>
          ) : null}
          <button className="bt-agent-btn primary" disabled={busy || !name.trim()} onClick={save}>
            {busy ? 'Saving…' : agent ? 'Save changes' : 'Create agent'}
          </button>
        </div>
      </div>
    </div>
  );
}
