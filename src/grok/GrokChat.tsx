// Bot-shell chat host — GrokApp's equivalent of the Studio's ChatTab.
// Owns the companion picker + useChat transport for one conversation
// (chatId), hoists useChatShell state, renders GrokConversation, and reports
// a ChatMeta snapshot up to the right pane (Session card: model, status,
// context meter, compaction).

import { useCallback, useEffect, useRef } from 'react';
import { useChat } from '../chat/hooks/useChat';
import {
  normalizeCompanion,
  normalizeXaiEffort,
  normalizeXaiModel,
  useCompanionPicker,
} from '../chat/hooks/useCompanionPicker';
import { normalizeCodexEffort, normalizeCodexModel } from '../chat/codexModels';
import { CLAUDE_EFFORTS, normalizeClaudeModel } from '../chat/components/CodexEnginePicker';
import { useChatShell } from '../chat/components/reimagine/useChatShell';
import { companionAgentLabel } from '../shell/studio/ChatTab';
import type { CompanionId, Repo } from '../chat/data/types';
import { GrokConversation } from './GrokConversation';
import type { ChatMeta } from './BotPanel';
import type { Agent } from './agents';
import { markAgentRead, updateAgentReq } from './agents';

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
};

export function GrokChat(props: GrokChatProps) {
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
          : null;
        if (model && modelKey) localStorage.setItem(modelKey, model);
        if (effort) {
          const effortKey = seed === 'claude' ? 'rivendell:claude-effort'
            : seed === 'codex' ? 'rivendell:codex-effort'
            : seed === 'xai' ? 'rivendell:xai-effort'
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

  // Esc stops a streaming turn.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && chat.status === 'streaming') {
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return;
        chat.stop();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chat.status, chat.stop]);

  const agentId = props.agent?.id;
  const persistGen = useRef(0);
  const persistChain = useRef(Promise.resolve());
  const selectionForLane = (engine: string, modelOverride?: string, effortOverride?: string) => {
    const model = modelOverride ?? (
      engine === 'claude' ? picker.claudeModel
      : engine === 'codex' ? picker.codexModel
      : engine === 'xai' ? picker.xaiModel
      : undefined
    );
    const effort = effortOverride ?? (
      engine === 'claude' ? picker.claudeEffort
      : engine === 'codex' ? picker.codexEffort
      : engine === 'xai' ? picker.xaiEffort
      : undefined
    );
    return { engine, model, effort };
  };
  const persistBrain = useCallback((patch: Partial<BrainDraft>) => {
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
          desiredBrain.current = canonicalBrain({ engine: saved.engine, model: saved.model, effort: saved.effort });
          picker.applyAuthoritativeBrain(saved.engine, saved.model, saved.effort);
        }
        props.onAgentBrainSaved();
      } catch {
        // A 409 means another device won. Never overwrite it with stale fields;
        // reload the central brain and let the explicit next click retry.
        props.onAgentBrainSaved();
      }
    });
  }, [agentId, picker.applyAuthoritativeBrain, props.onAgentBrainSaved]);

  const pickerForUi = !agentId ? picker : {
    ...picker,
    brainPending: chat.serverBrain?.pending ?? false,
    setCompanion: (engine: string) => persistBrain(selectionForLane(engine)),
    setClaudeModel: (value: string) => persistBrain({
      engine: 'claude',
      model: normalizeClaudeModel(value),
    }),
    setClaudeEffort: (effort: string) => persistBrain({ engine: 'claude', effort }),
    setCodexModel: (value: string) => {
      const model = normalizeCodexModel(value);
      persistBrain({
        engine: 'codex',
        model,
        effort: normalizeCodexEffort(model, desiredBrain.current.effort),
      });
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

  // Unread badge hygiene: while this agent's thread is on a visible tab, keep
  // the server's read marker at the log head. A backgrounded tab must not
  // clear badges for replies it never showed — visibilityState covers that.
  // document.hasFocus() is too strict (devtools / another pane steals focus
  // and the badge sticks while the user is looking at the thread).
  useEffect(() => {
    if (!props.agent) return;
    const agentId = props.agent.id;
    const post = () => {
      if (document.visibilityState === 'visible') void markAgentRead(agentId);
    };
    post();
    const t = window.setTimeout(post, 400);
    const iv = window.setInterval(post, 4000);
    document.addEventListener('visibilitychange', post);
    window.addEventListener('focus', post);
    return () => {
      window.clearTimeout(t);
      window.clearInterval(iv);
      document.removeEventListener('visibilitychange', post);
      window.removeEventListener('focus', post);
    };
  }, [props.agent?.id, chat.status]);

  return (
    <GrokConversation
      s={s}
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
    />
  );
}
