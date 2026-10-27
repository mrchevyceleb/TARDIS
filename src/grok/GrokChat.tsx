// Bot-shell chat host — GrokApp's equivalent of the Studio's ChatTab.
// Owns the companion picker + useChat transport for one conversation
// (chatId), hoists useChatShell state, renders GrokConversation, and reports
// a ChatMeta snapshot up to the right pane (Session card: model, status,
// context meter, compaction).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useChat } from '../chat/hooks/useChat';
import {
  normalizeAgyEffort,
  normalizeAgyModel,
  normalizeCompanion,
  normalizeXaiEffort,
  normalizeXaiModel,
  normalizeZaiEffort,
  normalizeZaiModel,
  useCompanionPicker,
} from '../chat/hooks/useCompanionPicker';
import { codexModelChange, normalizeCodexEffort, normalizeCodexModel } from '../chat/codexModels';
import { normalizeFireworksEffort, normalizeFireworksModel } from '../chat/fireworksModels';
import { normalizeOpenRouterEffort, normalizeOpenRouterModel } from '../chat/openrouterModels';
import { normalizeMetaEffort, normalizeMetaModel } from '../chat/metaModels';
import { normalizeMuseEffort, normalizeMuseModel } from '../chat/museModels';
import { CLAUDE_EFFORTS, normalizeClaudeModel } from '../chat/components/CodexEnginePicker';
import { useChatShell } from '../chat/components/reimagine/useChatShell';
import { companionAgentLabel } from '../shell/studio/ChatTab';
import type { CompanionId, Repo } from '../chat/data/types';
import { GrokConversation, type ConversationDock } from './GrokConversation';
import type { ChatMeta } from './BotPanel';
import type { Agent } from './agents';
import { AgentUpdateConflictError, markAgentRead, updateAgentReq } from './agents';
import { onPresenceChange, userPresent } from '../chat/utils/userPresence';

type BrainDraft = { engine: string; model?: string; effort?: string };

// Keep the write-side draft consistent with the lane displayed by the picker,
// including while an older server snapshot still carries a retired provider.
function canonicalBrain(brain: BrainDraft): BrainDraft {
  const engine = normalizeCompanion(brain.engine);
  const compatible = engine === brain.engine || brain.engine === 'assistant';
  const model = compatible ? brain.model : undefined;
  const effort = compatible ? brain.effort : undefined;
  if (engine === 'claude') return {
    engine, model: normalizeClaudeModel(model),
    effort: effort && CLAUDE_EFFORTS.includes(effort) ? effort : 'xhigh',
  };
  if (engine === 'codex') {
    const nextModel = normalizeCodexModel(model ?? '');
    return { engine, model: nextModel, effort: normalizeCodexEffort(nextModel, effort ?? '') };
  }
  if (engine === 'zai') {
    return { engine, model: normalizeZaiModel(model ?? ''), effort: normalizeZaiEffort(effort ?? '') };
  }
  if (engine === 'fireworks') {
    const nextModel = normalizeFireworksModel(model ?? '');
    return { engine, model: nextModel, effort: normalizeFireworksEffort(nextModel, effort ?? '') };
  }
  if (engine === 'openrouter' || engine === 'openrouter2') {
    const nextModel = normalizeOpenRouterModel(model ?? '');
    return { engine, model: nextModel, effort: normalizeOpenRouterEffort(nextModel, effort ?? '') };
  }
  if (engine === 'agy') {
    return { engine, model: normalizeAgyModel(model ?? ''), effort: normalizeAgyEffort(effort ?? '') };
  }
  if (engine === 'meta') {
    return { engine, model: normalizeMetaModel(model ?? ''), effort: normalizeMetaEffort(normalizeMetaModel(model ?? ''), effort ?? '') };
  }
  if (engine === 'muse') {
    return { engine, model: normalizeMuseModel(model ?? ''), effort: normalizeMuseEffort(effort ?? '') };
  }
  return { engine, model: normalizeXaiModel(model ?? ''), effort: normalizeXaiEffort(effort ?? '') };
}

export type GrokChatProps = {
  chatId: string;
  cli?: CompanionId;
  /** Persona lane id ('xai', 'claude', …) — seeds the picker lane. */
  lane?: string;
  agent?: Agent;
  repo?: Repo;
  paneOpen: boolean;
  onTogglePane: () => void;
  onVoice: () => void;
  voiceActive: boolean;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  onOpenStudio: () => void;
  onOpenAgentEditor: () => void;
  onAgentBrainSaved: () => void;
  onMeta: (meta: ChatMeta) => void;
  /** Docked beside a room instead of filling the center pane. */
  dock?: ConversationDock;
  /** The repo list is still loading, so there is no lane to connect to yet. */
  reposLoading?: boolean;
};

export function GrokChat(props: GrokChatProps) {
  const [brainSaveError, setBrainSaveError] = useState<string | null>(null);
  const [brainSaveNotice, setBrainSaveNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!brainSaveNotice) return;
    const timer = window.setTimeout(() => setBrainSaveNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [brainSaveNotice]);
  const savedBrain = useRef<BrainDraft>({ engine: props.agent?.engine ?? 'claude', model: props.agent?.model, effort: props.agent?.effort });
  useEffect(() => {
    if (props.agent) savedBrain.current = { engine: props.agent.engine, model: props.agent.model, effort: props.agent.effort };
  }, [props.agent?.engine, props.agent?.model, props.agent?.effort, props.agent?.brainRevision]);
  const { chatId, cli, lane, repo } = props;
  // Seed the picker lane SYNCHRONOUSLY (before the hook's useState initializer
  // reads localStorage) so persona threads never connect on the wrong lane.
  const storageKey = `rivendell:studio-companion:${chatId}`;
  const seededRef = useRef(false);
  if (!seededRef.current && typeof window !== 'undefined') {
    seededRef.current = true;
    const seed = props.agent?.engine ?? lane ?? cli;
    if (seed) {
      try {
        if (localStorage.getItem(storageKey) !== seed) localStorage.setItem(storageKey, seed);
        const model = props.agent?.model;
        const effort = props.agent?.effort;
        const modelKey = seed === 'claude' ? 'rivendell:claude-model'
          : seed === 'codex' ? 'rivendell:codex-model'
          : seed === 'xai' ? 'rivendell:xai-model'
          : seed === 'zai' ? 'rivendell:zai-model'
          : seed === 'fireworks' ? 'rivendell:fireworks-model'
          : seed === 'openrouter' ? 'rivendell:openrouter-model'
          : seed === 'openrouter2' ? 'rivendell:openrouter2-model'
          : seed === 'agy' ? 'rivendell:agy-model'
          : seed === 'meta' ? 'rivendell:meta-model'
          : seed === 'muse' ? 'rivendell:muse-model'
          : null;
        if (model && modelKey) localStorage.setItem(modelKey, model);
        if (effort) {
          const effortKey = seed === 'claude' ? 'rivendell:claude-effort'
            : seed === 'codex' ? 'rivendell:codex-effort'
            : seed === 'xai' ? 'rivendell:xai-effort'
            : seed === 'zai' ? 'rivendell:zai-effort'
            : seed === 'fireworks' ? 'rivendell:fireworks-effort'
            : seed === 'openrouter' ? 'rivendell:openrouter-effort'
            : seed === 'openrouter2' ? 'rivendell:openrouter2-effort'
            : seed === 'agy' ? 'rivendell:agy-effort'
            : seed === 'meta' ? 'rivendell:meta-effort'
            : seed === 'muse' ? 'rivendell:muse-effort'
            : null;
          if (effortKey) localStorage.setItem(effortKey, effort);
        }
      } catch { /* storage unavailable — server brain still wins */ }
    }
  }
  const picker = useCompanionPicker(storageKey);

  const chat = useChat({
    repo,
    cli: picker.cli,
    account: picker.account ?? undefined,
    chatId,
    enabled: Boolean(repo),
    model: picker.model,
    effort: picker.effort,
    selectionRevision: picker.selectionRevision,
  });

  const appliedBrainRevision = useRef<number | null>(null);
  const serverBrainRevision = useRef(props.agent?.brainRevision ?? 1);
  const desiredBrain = useRef<BrainDraft>(canonicalBrain({
    engine: props.agent?.engine ?? picker.companion,
    model: props.agent?.model ?? picker.model,
    effort: props.agent?.effort ?? picker.effort,
  }));
  useEffect(() => {
    if (!props.agent) return;
    const revision = props.agent.brainRevision ?? 1;
    if (revision < serverBrainRevision.current || appliedBrainRevision.current === revision) return;
    appliedBrainRevision.current = revision;
    serverBrainRevision.current = revision;
    desiredBrain.current = canonicalBrain({
      engine: props.agent.engine,
      model: props.agent.model,
      effort: props.agent.effort,
    });
    picker.applyAuthoritativeBrain(props.agent.engine, props.agent.model, props.agent.effort);
    if (chat.serverBrain && chat.serverBrain.revision !== revision) {
      window.setTimeout(chat.reconnect, 0);
    }
  }, [chat.reconnect, chat.serverBrain, picker.applyAuthoritativeBrain, props.agent?.brainRevision, props.agent?.effort, props.agent?.engine, props.agent?.model]);

  useEffect(() => {
    if (!props.agent || !chat.serverBrain?.revision) return;
    const revision = chat.serverBrain.revision;
    if (revision <= serverBrainRevision.current) return;
    serverBrainRevision.current = revision;
    appliedBrainRevision.current = revision;
    desiredBrain.current = canonicalBrain({
      engine: chat.serverBrain.cli,
      model: chat.serverBrain.model,
      effort: chat.serverBrain.effort,
    });
    picker.applyAuthoritativeBrain(
      chat.serverBrain.cli,
      chat.serverBrain.model,
      chat.serverBrain.effort,
    );
    props.onAgentBrainSaved();
  }, [chat.serverBrain, picker.applyAuthoritativeBrain, props.agent, props.onAgentBrainSaved]);

  // Esc stops a streaming turn. Not when docked: there Escape belongs to the
  // room (closing a card), and only an explicit Stop may end a turn.
  const docked = Boolean(props.dock);
  useEffect(() => {
    if (docked) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && chat.status === 'streaming') {
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return;
        chat.stop();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chat.status, chat.stop, docked]);

  const agentId = props.agent?.id;
  const persistGen = useRef(0);
  const persistChain = useRef(Promise.resolve());
  const selectionForLane = (engine: string, modelOverride?: string, effortOverride?: string) => {
    const model = modelOverride ?? (
      engine === 'claude' ? picker.claudeModel
      : engine === 'codex' ? picker.codexModel
      : engine === 'xai' ? picker.xaiModel
      : engine === 'zai' ? picker.zaiModel
      : engine === 'fireworks' ? picker.fireworksModel
      : engine === 'openrouter' ? picker.openRouterModel
      : engine === 'openrouter2' ? picker.openRouter2Model
      : engine === 'agy' ? picker.agyModel
      : engine === 'meta' ? picker.metaModel
      : engine === 'muse' ? picker.museModel
      : undefined
    );
    const effort = effortOverride ?? (
      engine === 'claude' ? picker.claudeEffort
      : engine === 'codex' ? picker.codexEffort
      : engine === 'xai' ? picker.xaiEffort
      : engine === 'zai' ? picker.zaiEffort
      : engine === 'fireworks' ? picker.fireworksEffort
      : engine === 'openrouter' ? picker.openRouterEffort
      : engine === 'openrouter2' ? picker.openRouter2Effort
      : engine === 'agy' ? picker.agyEffort
      : engine === 'meta' ? picker.metaEffort
      : engine === 'muse' ? picker.museEffort
      : undefined
    );
    return { engine, model, effort };
  };
  const persistBrain = useCallback((patch: Partial<BrainDraft>, notice: string | null = null) => {
    setBrainSaveError(null);
    setBrainSaveNotice(null);
    const next = canonicalBrain({ ...desiredBrain.current, ...patch });
    desiredBrain.current = next;
    if (!agentId) {
      picker.applyAuthoritativeBrain(next.engine, next.model, next.effort);
      return;
    }
    const gen = ++persistGen.current;
    persistChain.current = persistChain.current.catch(() => {}).then(async () => {
      if (gen !== persistGen.current) return;
      const wanted = { ...desiredBrain.current };
      try {
        const saved = await updateAgentReq(agentId, {
          ...wanted,
          brainRevision: serverBrainRevision.current,
        });
        serverBrainRevision.current = saved.brainRevision ?? serverBrainRevision.current + 1;
        if (gen === persistGen.current) {
          savedBrain.current = { engine: saved.engine, model: saved.model, effort: saved.effort };
          desiredBrain.current = canonicalBrain({ engine: saved.engine, model: saved.model, effort: saved.effort });
          picker.applyAuthoritativeBrain(saved.engine, saved.model, saved.effort);
          setBrainSaveNotice(notice ?? 'Selection saved. New replies will use it.');
        }
        props.onAgentBrainSaved();
      } catch (error) {
        // A 409 means another device won. Never overwrite it with stale fields;
        // reload the central brain and let the explicit next click retry.
        props.onAgentBrainSaved();
        if (gen === persistGen.current) {
          if (error instanceof AgentUpdateConflictError) {
            const current = error.current;
            savedBrain.current = { engine: current.engine, model: current.model, effort: current.effort };
            serverBrainRevision.current = current.brainRevision ?? serverBrainRevision.current;
            picker.applyAuthoritativeBrain(current.engine, current.model, current.effort);
          }
          desiredBrain.current = canonicalBrain(savedBrain.current);
          setBrainSaveError(error instanceof AgentUpdateConflictError
            ? 'Settings changed on another device. Refreshed them here; try your change again.'
            : `Change wasn’t saved. ${error instanceof Error ? error.message : 'Please try again.'}`);
        }
      }
    });
  }, [agentId, picker.applyAuthoritativeBrain, props.onAgentBrainSaved]);

  const pickerForUi = !agentId ? picker : {
    ...picker,
    selectionNotice: brainSaveNotice,
    selectionError: brainSaveError,
    dismissSelectionFeedback: () => { setBrainSaveError(null); setBrainSaveNotice(null); },
    brainPending: chat.serverBrain?.pending ?? false,
    setCompanion: (engine: string) => persistBrain(selectionForLane(engine)),
    setClaudeModel: (value: string) => persistBrain({
      engine: 'claude',
      model: normalizeClaudeModel(value),
    }),
    setClaudeEffort: (effort: string) => persistBrain({ engine: 'claude', effort }),
    setCodexModel: (value: string) => {
      const model = normalizeCodexModel(value);
      const { effort, notice } = codexModelChange(model, desiredBrain.current.effort ?? picker.codexEffort);
      persistBrain({
        engine: 'codex',
        model,
        effort,
      }, notice);
    },
    setCodexEffort: (value: string) => persistBrain({
      engine: 'codex',
      effort: normalizeCodexEffort(
        desiredBrain.current.model ?? picker.codexModel,
        value,
      ),
    }),
    setXaiModel: (value: string) => persistBrain({ engine: 'xai', model: normalizeXaiModel(value) }),
    setXaiEffort: (value: string) => persistBrain({ engine: 'xai', effort: normalizeXaiEffort(value) }),
    setZaiModel: (value: string) => persistBrain({ engine: 'zai', model: normalizeZaiModel(value) }),
    setZaiEffort: (value: string) => persistBrain({ engine: 'zai', effort: normalizeZaiEffort(value) }),
    setFireworksModel: (value: string) => persistBrain({ engine: 'fireworks', model: normalizeFireworksModel(value) }),
    setFireworksEffort: (value: string) => persistBrain({ engine: 'fireworks', effort: normalizeFireworksEffort(picker.fireworksModel, value) }),
    setOpenRouterModel: (value: string) => persistBrain({ engine: 'openrouter', model: normalizeOpenRouterModel(value) }),
    setOpenRouterEffort: (value: string) => persistBrain({ engine: 'openrouter', effort: normalizeOpenRouterEffort(picker.openRouterModel, value) }),
    setOpenRouter2Model: (value: string) => persistBrain({ engine: 'openrouter2', model: normalizeOpenRouterModel(value) }),
    setOpenRouter2Effort: (value: string) => persistBrain({ engine: 'openrouter2', effort: normalizeOpenRouterEffort(picker.openRouter2Model, value) }),
    setAgyModel: (value: string) => persistBrain({ engine: 'agy', model: normalizeAgyModel(value) }),
    setAgyEffort: (value: string) => persistBrain({ engine: 'agy', effort: normalizeAgyEffort(value) }),
    setMetaModel: (value: string) => persistBrain({ engine: 'meta', model: normalizeMetaModel(value) }),
    setMetaEffort: (value: string) => persistBrain({ engine: 'meta', effort: normalizeMetaEffort(picker.metaModel, value) }),
    setMuseModel: (value: string) => persistBrain({ engine: 'muse', model: normalizeMuseModel(value) }),
    setMuseEffort: (value: string) => persistBrain({ engine: 'muse', effort: normalizeMuseEffort(value) }),
  };

  const s = useChatShell({ chat, picker: pickerForUi });

  // Report the Session-card snapshot upward. compactingRef is a ref, so poll
  // it lightly while the session is live.
  const onMeta = props.onMeta;
  const agentLabel = props.agent?.name ?? companionAgentLabel(picker.cli);
  useEffect(() => {
    const report = () => {
      onMeta({
        agentLabel,
        model: picker.model ?? null,
        status: chat.status,
        fraction: chat.usage?.fraction,
        compacting: Boolean(chat.compactingRef?.current),
      });
    };
    report();
    const iv = window.setInterval(report, 1500);
    return () => window.clearInterval(iv);
  }, [onMeta, agentLabel, picker.model, chat.status, chat.usage?.fraction, chat.compactingRef]);

  // Unread badge hygiene: while someone is actually looking at this agent's
  // thread, keep the server's read marker at the log head. "Looking" is
  // userPresent(): a visible window that has focus or saw real input in the
  // last two minutes. An Electron window left open behind others (or with
  // nobody at the machine) must not clear badges meant for other devices.
  useEffect(() => {
    if (!props.agent) return;
    const agentId = props.agent.id;
    const post = () => {
      if (userPresent()) void markAgentRead(agentId);
    };
    post();
    const t = window.setTimeout(post, 400);
    const iv = window.setInterval(post, 4000);
    const unsubscribe = onPresenceChange((present) => { if (present) post(); });
    return () => {
      window.clearTimeout(t);
      window.clearInterval(iv);
      unsubscribe();
    };
  }, [props.agent?.id, chat.status]);

  return (
    <><GrokConversation
      // No repo yet on first load: catching up, not an empty conversation.
      s={!repo && props.reposLoading ? { ...s, hydrating: true } : s}
      picker={pickerForUi}
      repo={repo}
      agent={agentLabel}
      agentRecord={props.agent}
      paneOpen={props.paneOpen}
      onTogglePane={props.onTogglePane}
      onVoice={props.onVoice}
      voiceActive={props.voiceActive}
      theme={props.theme}
      onToggleTheme={props.onToggleTheme}
      onOpenStudio={props.onOpenStudio}
      onOpenAgentEditor={props.onOpenAgentEditor}
      dock={props.dock}
    />
    </>
  );
}
