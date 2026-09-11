import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatBlock, ChatImagePreview, CompanionId, Repo } from '../data/types';
import { contextWindowForCodexModel } from '../codexModels';
import { automationTurnInFlight, filterAutomationNoise } from '../utils/automationNoise';
import { isAutomationPeer } from '../utils/routineNoise';

type Status = 'idle' | 'connecting' | 'ready' | 'streaming' | 'closed' | 'error';
type ChatSendImage = { mediaType: string; base64: string; previewDataUrl?: string };

export type ServerBrainState = {
  cli: CompanionId;
  model?: string;
  effort?: string;
  activeCli: CompanionId;
  activeModel?: string;
  activeEffort?: string;
  revision?: number;
  pending: boolean;
};

export type ContextUsage = {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  outputTokens: number;
  /** How full the context window is, 0..1. */
  fraction: number;
  /** Window size in tokens (claude default). */
  windowTokens: number;
};

const DEFAULT_WINDOW_TOKENS = 200_000;
const LARGE_WINDOW_TOKENS = 1_000_000;
const BANANA_WINDOW_TOKENS = 200_000; // banana default model context
const GROK_WINDOW_TOKENS = 500_000; // Grok 4.x context window

// Pick the starting context window for a given CLI before we've seen any model
// id. Codex uses the selected catalog entry; current Claude (Opus 4.6/4.7/4.8,
// Sonnet 4.6) is 1M; GLM 5.3/5.2 is 1M; xAI/Grok is 500K; banana/OpenRouter defaults to 200K.
function defaultWindowForCli(cli: CompanionId, model?: string): number {
  if (isCodexCli(cli)) return contextWindowForCodexModel(model);
  if (cli === 'banana' || cli === 'banana-local' || cli === 'banana-fireworks') return BANANA_WINDOW_TOKENS;
  // xAI always runs Grok (500K). Pin before system/init arrives so the meter
  // never flashes the 200K non-claude default.
  if (cli === 'xai') return GROK_WINDOW_TOKENS;
  return windowForClaudeModel(model); // Claude/Z.ai model ids carry the real window.
}

function contextWindowOverride(value: number | null | undefined): number | undefined {
  if (!Number.isFinite(value) || !value || value <= 0) return undefined;
  return Math.floor(value);
}

function windowForCli(cli: CompanionId, model: string | undefined, override?: number | null): number {
  return contextWindowOverride(override) ?? defaultWindowForCli(cli, model);
}

function isCodexCli(cli: CompanionId): boolean {
  return cli === 'codex';
}

function shouldReadResultUsage(cli: CompanionId): boolean {
  return isCodexCli(cli)
    || cli === 'banana'
    || cli === 'banana-local'
    || cli === 'banana-fireworks';
}

// Map a model id to its real context window. Current Opus (4.6/4.7/4.8),
// Sonnet 4.6, and Fable/Mythos 5 are all 1M; Haiku and older models are 200K;
// GLM 5.3 / 5.2 are 1M on Z.ai's coding API; GLM 5.1 stays 200K.
function windowForClaudeModel(model: string | undefined): number {
  if (!model) return LARGE_WINDOW_TOKENS;
  const m = model.toLowerCase();
  if (m.includes('[1m]') || m.includes('-1m')) return LARGE_WINDOW_TOKENS;
  if (m.includes('haiku')) return DEFAULT_WINDOW_TOKENS;
  if (m.includes('glm-5.3') || m.includes('glm-5.2')) return LARGE_WINDOW_TOKENS;
  if (m.includes('glm')) return DEFAULT_WINDOW_TOKENS;
  // Any Grok id (grok-4.5, grok-4-5, future grok-*) is 500K on xAI.
  if (m.includes('grok')) return GROK_WINDOW_TOKENS;
  if (m.includes('opus') || m.includes('sonnet') || m.includes('fable') || m.includes('mythos')) return LARGE_WINDOW_TOKENS;
  return DEFAULT_WINDOW_TOKENS;
}

let nextId = 1;
const id = () => `b${nextId++}`;

function isProviderSyntheticErrorText(text: string): boolean {
  return /^\s*API Error:\s*(?:Request rejected|.*\(\d{3}\))/i.test(text);
}

function isSyntheticApiErrorEvent(ev: any): boolean {
  if (!ev || ev.type !== 'assistant') return false;
  if (ev.is_api_error_message === true) return true;
  if (ev.message?.model !== '<synthetic>') return false;
  const content = ev.message?.content;
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n')
      : '';
  return isProviderSyntheticErrorText(text);
}

// Pure reducer — all per-turn state lives on the blocks themselves
// (turnId + cbIndex). This keeps it safe under React Strict Mode, which
// invokes reducers twice for purity-checking.
type ReducerCursor = { current: string; peerId?: string };

export function reduce(blocks: ChatBlock[], ev: any, turnIdRef: ReducerCursor): ChatBlock[] {
  if (!ev || typeof ev !== 'object') return blocks;

  if ((ev.type === 'stream_event' || ev.type === 'event') && ev.event) {
    return reduce(blocks, ev.event, turnIdRef);
  }

  if (ev.type === 'system' && (ev.subtype === 'commands_changed' || ev.subtype === 'hook_response' || ev.subtype === 'hook_started' || ev.subtype === 'hook_progress')) {
    return blocks;
  }

  if (ev.type === '_terminal_error' && typeof ev.message === 'string') {
    const currentTurnId = turnIdRef.current;
    const closed = blocks.flatMap((b): ChatBlock[] => {
      // Older server versions could stream the raw synthetic "API Error"
      // prose before the durable notice arrived. Remove only that protocol
      // block; preserve any useful partial response from the same turn.
      if (
        ev.discardSynthetic === true
        && b.kind === 'text'
        && isProviderSyntheticErrorText(b.text)
        && (!currentTurnId || b.turnId === currentTurnId)
      ) return [];
      if (b.kind === 'text' && b.open) return [{ ...b, open: false }];
      if (b.kind === 'tool' && (b.open || b.running)) return [{ ...b, open: false, running: false }];
      return [b];
    });
    const ts = typeof ev.ts === 'number' ? ev.ts : Date.now();
    if (closed.some((b) => b.kind === 'terminal-error' && b.ts === ts && b.message === ev.message)) return closed;
    return [...closed, {
      kind: 'terminal-error',
      id: id(),
      message: ev.message,
      code: typeof ev.code === 'string' ? ev.code : undefined,
      retryable: ev.retryable === true || undefined,
      ts,
    }];
  }

  if (ev.type === '_engine_switch') {
    return [...blocks, {
      kind: 'switch',
      id: id(),
      from: typeof ev.from === 'string' ? ev.from : 'unknown',
      to: typeof ev.to === 'string' ? ev.to : 'unknown',
      model: typeof ev.model === 'string' ? ev.model : undefined,
      ts: typeof ev.ts === 'number' ? ev.ts : Date.now(),
    }];
  }

  // Service-restart marker (assistant-shaped so the agent reads it in seeds;
  // rendered as a divider, not a bubble). Killed the in-flight turn, so close
  // its open/running blocks too — otherwise a dead tool card ticks "working"
  // forever after replay.
  if ((ev.type === 'assistant' && ev._serviceRestart) || ev.type === '_service_restart') {
    turnIdRef.current = '';
    turnIdRef.peerId = undefined;
    const ts = typeof ev.ts === 'number' ? ev.ts : Date.now();
    const reason = typeof ev.reason === 'string' ? ev.reason : undefined;
    const closed = blocks.map((b) => {
      if (b.kind === 'text' && b.open) return { ...b, open: false };
      if (b.kind === 'tool' && (b.open || b.running)) return { ...b, open: false, running: false };
      return b;
    });
    return [...closed, { kind: 'restart', id: id(), ts, reason }];
  }

  // Completed voice bubbles must not change the text runner's streaming IDs,
  // busy state, or optimistic-send acknowledgement state.
  if (ev.type === '_voice_transcript' && typeof ev.text === 'string'
    && (ev.role === 'user' || ev.role === 'assistant')) {
    const blockId = `voice-${ev.id}`;
    if (blocks.some((block) => block.id === blockId)) return blocks;
    const ts = typeof ev.ts === 'number' ? ev.ts : Date.now();
    return ev.role === 'user'
      ? [...blocks, { kind: 'user', id: blockId, text: ev.text, ts }]
      : [...blocks, { kind: 'text', id: blockId, text: ev.text, ts, turnId: blockId, cbIndex: -1, open: false }];
  }

  // Voice handoffs are control envelopes for an already-visible spoken user
  // request, not a second teammate conversation. Replies belong in main chat.
  if (ev.type === 'peer_message' && ev.fromRole === 'voice') {
    turnIdRef.peerId = undefined;
    return blocks;
  }

  // Agent-to-agent delivery: a teammate's message landing in this thread.
  if (ev.type === 'peer_message' && typeof ev.text === 'string') {
    const from = typeof ev.from === 'string' ? ev.from : 'Companion';
    const fromRole = typeof ev.fromRole === 'string' ? ev.fromRole : undefined;
    const deliveryId = typeof ev.deliveryId === 'string' ? ev.deliveryId : undefined;
    const existing = deliveryId
      ? blocks.find((block) => block.kind === 'peer' && block.deliveryId === deliveryId)
      : undefined;
    if (existing?.kind === 'peer') {
      turnIdRef.peerId = isAutomationPeer(from, fromRole, ev.text) ? undefined : existing.id;
      return blocks;
    }
    const blockId = id();
    turnIdRef.peerId = isAutomationPeer(from, fromRole, ev.text) ? undefined : blockId;
    return [...blocks, {
      kind: 'peer',
      id: blockId,
      from,
      fromRole,
      deliveryId,
      text: ev.text,
      ts: typeof ev.ts === 'number' ? ev.ts : Date.now(),
    }];
  }

  // Server-injected echo of the user's prompt — keeps the user's message in
  // the visible thread when a client reconnects and replays the buffer.
  if (ev.type === '_user_echo' && typeof ev.text === 'string') {
    turnIdRef.peerId = undefined;
    const attachments: Array<{ id: string; mediaType: string }> = Array.isArray(ev.attachments) ? ev.attachments : [];
    const echoImages = attachments.length
      ? attachments.map((a) => ({ mediaType: a.mediaType, dataUrl: `/api/chat/attachments/${a.id}` }))
      : undefined;
    // Dedupe: match the optimistic local user block by clientMsgId (stable
    // across identical back-to-back prompts), falling back to the legacy
    // text match for events that predate the id. A match is never doubled,
    // but DO upgrade it with the server's attachment URLs — those survive
    // storage (the optimistic data: URLs get stripped).
    const cmid = typeof ev.clientMsgId === 'string' && ev.clientMsgId ? ev.clientMsgId : null;
    const match = cmid
      ? blocks.find((b) => b.kind === 'user' && b.clientMsgId === cmid)
      : [...blocks].reverse().find((b) => b.kind === 'user' && b.text === ev.text);
    if (match && match.kind === 'user' && (cmid || match.text === ev.text)) {
      // A queued steer becomes genuinely delivered only when the runner emits
      // its durable user echo. Fold that acknowledgement into the optimistic
      // bubble instead of adding a duplicate.
      const nextMatch: Extract<ChatBlock, { kind: 'user' }> = {
        ...match,
        deliveryState: undefined,
        ...(echoImages && !match.images?.some((i) => i.dataUrl.startsWith('/')) ? { images: echoImages } : {}),
        ...(imageCountFlag(ev) && Array.isArray(ev.attachments) && ev.attachments.length === 0
          ? { attachmentsLost: true }
          : {}),
      };
      if (
        match.deliveryState === undefined
        && nextMatch.images === match.images
        && nextMatch.attachmentsLost === match.attachmentsLost
      ) return blocks;
      return blocks.map((b) => (b.id === match.id ? nextMatch : b));
    }
    const ts = typeof ev.ts === 'number' ? ev.ts : Date.now();
    const imageCount = typeof ev.imageCount === 'number' && ev.imageCount > 0 ? ev.imageCount : undefined;
    // Feature-present echo with zero kept attachments: every image failed to
    // persist — say "not kept", not "attached".
    const attachmentsLost = Boolean(imageCount && Array.isArray(ev.attachments) && ev.attachments.length === 0) || undefined;
    return [...blocks, { kind: 'user', id: id(), text: ev.text, imageCount, images: echoImages, clientMsgId: cmid ?? undefined, attachmentsLost, ts }];
  }

  if (ev.type === 'message_start') {
    // New assistant turn. Mint a fresh turnId; close out any open blocks from
    // a prior turn so their cbIndex correlation can no longer match. Tool
    // blocks also drop `running`: an interrupted turn never emits
    // content_block_stop, and one stale running/open flag suppresses the
    // typing indicator forever (hasOpen scans the whole history).
    turnIdRef.current = `t${nextId++}`;
    return blocks.map((b) => {
      if (b.kind === 'text' && b.open) return { ...b, open: false };
      if (b.kind === 'tool' && (b.open || b.running)) return { ...b, open: false, running: false };
      return b;
    });
  }

  // Turn over (result) or killed (interrupted): nothing stays open/running.
  if (ev.type === 'result' || ev.type === '_interrupted') {
    const finalTurnId = turnIdRef.current || `t${nextId++}`;
    const finalPeerId = turnIdRef.peerId;
    turnIdRef.current = '';
    turnIdRef.peerId = undefined;
    const closed = blocks.map((b) => {
      if (b.kind === 'text' && b.open) return { ...b, open: false };
      if (b.kind === 'tool' && (b.open || b.running)) return { ...b, open: false, running: false };
      return b;
    });
    // `result.result` is the provider's canonical final answer. A mobile tab
    // can reconnect after message_start but before the final assistant event;
    // its cursor then resumes inside the turn with no reducer turnId. The old
    // fallback compared against every legacy `turnId:""` block and silently
    // discarded that final response. Recover it from the terminal result when
    // no identical text block made it into the visible transcript.
    const finalText = ev.type === 'result' && ev.is_error !== true && typeof ev.result === 'string'
      ? ev.result.trim()
      : '';
    const finalTurnParts = closed
      .filter((b): b is Extract<ChatBlock, { kind: 'text' }> => b.kind === 'text' && b.turnId === finalTurnId)
      .map((b) => b.text);
    const finalAlreadyRendered = finalTurnParts.some((part) => part.trim() === finalText)
      || ['', '\n', '\n\n'].some((separator) => finalTurnParts.join(separator).trim() === finalText);
    if (finalText && !finalAlreadyRendered) {
      return [...closed, {
        kind: 'text',
        id: id(),
        text: finalText,
        ts: Date.now(),
        turnId: finalTurnId,
        peerId: finalPeerId,
        cbIndex: -1,
        open: false,
      }];
    }
    return closed;
  }

  if (ev.type === 'message_delta') {
    const reason = ev.delta?.stop_reason;
    const presentation = reason === 'tool_use' ? 'update' : reason === 'end_turn' ? 'answer' : undefined;
    if (!presentation) return blocks;
    return blocks.map((b) => b.kind === 'text' && b.turnId === turnIdRef.current
      ? { ...b, presentation } : b);
  }

  if (ev.type === 'content_block_start') {
    const idx: number = ev.index;
    const cb = ev.content_block;
    // Reconnect may resume after message_start. Never correlate new content to
    // the empty legacy turn id shared by old cached blocks.
    if (!turnIdRef.current) turnIdRef.current = `t${nextId++}`;
    const turnId = turnIdRef.current;
    if (cb?.type === 'text') {
      const block: ChatBlock = {
        kind: 'text', id: id(), text: '', ts: Date.now(),
        turnId, peerId: turnIdRef.peerId, cbIndex: idx, open: true,
        presentation: cb.phase === 'commentary' ? 'update' : cb.phase === 'final_answer' ? 'answer' : undefined,
      };
      return [...blocks, block];
    }
    if (cb?.type === 'tool_use') {
      const block: ChatBlock = {
        kind: 'tool', id: id(),
        toolUseId: cb.id, tool: cb.name, args: '',
        running: true, ts: Date.now(),
        turnId, peerId: turnIdRef.peerId, cbIndex: idx, open: true,
      };
      return [...blocks, block];
    }
    return blocks;
  }

  if (ev.type === 'content_block_delta') {
    const idx: number = ev.index;
    const turnId = turnIdRef.current;
    const delta = ev.delta;
    return blocks.map((b) => {
      if (b.kind !== 'text' && b.kind !== 'tool') return b;
      if (b.cbIndex !== idx || b.turnId !== turnId || !b.open) return b;
      if (delta?.type === 'text_delta' && b.kind === 'text' && typeof delta.text === 'string') {
        return { ...b, text: b.text + delta.text };
      }
      if (delta?.type === 'input_json_delta' && b.kind === 'tool' && typeof delta.partial_json === 'string') {
        return { ...b, args: b.args + delta.partial_json };
      }
      return b;
    });
  }

  if (ev.type === 'content_block_stop') {
    const idx: number = ev.index;
    const turnId = turnIdRef.current;
    return blocks.flatMap((b) => {
      if (b.kind !== 'text' && b.kind !== 'tool') return b;
      if (b.cbIndex !== idx || b.turnId !== turnId) return b;
      if (b.kind === 'tool') {
        return [{ ...b, args: prettifyJson(b.args), open: false }];
      }
      return [{ ...b, open: false }];
    });
  }

  // Tool result: claude emits a `user` message containing tool_result content.
  if (ev.type === 'user' && ev.message?.content) {
    let next = blocks;
    for (const c of ev.message.content as Array<any>) {
      if (c?.type === 'tool_result') {
        const summary = stringifyResult(c.content);
        next = next.map((b) =>
          b.kind === 'tool' && b.toolUseId === c.tool_use_id
            ? { ...b, result: summary, running: false }
            : b,
        );
      }
    }
    return next;
  }

  // Final `assistant` event. Backends that stream Anthropic-format deltas
  // (Anthropic, Z.ai) deliver text via content_block_delta above, so the
  // block is already full and this is a no-op. xAI's Anthropic-compatible
  // stream, however, emits message_start + content_block_start(thinking) and
  // then skips every content_block_delta, delivering the full text only in
  // this final assistant event. Without this fallback xAI replies render as a
  // blank bubble. Guard on "no text yet for this turn" so delta-backed
  // backends never double-render.
  if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
    if (!turnIdRef.current) turnIdRef.current = `t${nextId++}`;
    const turnId = turnIdRef.current;
    const presentation = ev.message.stop_reason === 'tool_use' ? 'update'
      : ev.message.stop_reason === 'end_turn' ? 'answer' : undefined;
    const annotated: ChatBlock[] = presentation ? blocks.map((b): ChatBlock => b.kind === 'text' && b.turnId === turnId
      ? { ...b, presentation } : b) : blocks;
    const fullText = (ev.message.content as Array<any>)
      .filter((c) => c?.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('');
    if (fullText) {
      if (isSyntheticApiErrorEvent(ev)) return blocks;
      const hasText = blocks.some((b) => b.kind === 'text' && b.turnId === turnId && b.text !== '');
      if (!hasText) {
        return [...annotated, { kind: 'text', id: id(), text: fullText, ts: Date.now(), turnId, peerId: turnIdRef.peerId, cbIndex: -1, open: false, presentation }];
      }
    }
    return annotated;
  }

  return blocks;
}

function imageCountFlag(ev: any): boolean {
  return typeof ev?.imageCount === 'number' && ev.imageCount > 0;
}

function prettifyJson(raw: string): string {
  if (!raw) return '';
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const entries = Object.entries(obj as Record<string, unknown>);
      if (entries.length === 0) return '';
      return entries
        .slice(0, 3)
        .map(([k, v]) => {
          const s = typeof v === 'string' ? v : JSON.stringify(v);
          return `${k}=${s.length > 60 ? s.slice(0, 60) + '…' : s}`;
        })
        .join(' ');
    }
    return raw;
  } catch {
    return raw.length > 60 ? raw.slice(0, 60) + '…' : raw;
  }
}

function stringifyResult(content: unknown): string {
  if (typeof content === 'string') return summarize(content);
  if (Array.isArray(content)) {
    const text = content
      .map((c: any) => (c?.type === 'text' ? c.text : ''))
      .filter(Boolean)
      .join(' ');
    return summarize(text);
  }
  return '';
}

function summarize(s: string): string {
  const trimmed = s.trim();
  const firstLine = trimmed.split('\n')[0];
  if (trimmed.length <= 80) return trimmed;
  return `${firstLine.slice(0, 80)}…`;
}

function isLegacyCompactionSummaryText(text: string): boolean {
  const lower = text.trimStart().toLowerCase();
  if (!lower.startsWith('<summary>')) return false;
  return (
    lower.includes('primary request and intent') ||
    lower.includes('key technical concepts') ||
    lower.includes('files and code sections') ||
    lower.includes('current work') ||
    lower.includes('pending tasks') ||
    lower.includes('optional next step')
  );
}

function bareChatId(chatId: string): string {
  return (chatId || 'main').replace(/__acct__[a-z0-9-]+$/i, '');
}

function isAgentHome(chatId: string): boolean {
  return /^bot-[a-z0-9][a-z0-9-]*$/i.test(bareChatId(chatId));
}

function conversationKey(cli: CompanionId, repoPath: string, chatId = 'main'): string {
  const normalized = chatId || 'main';
  // Agent home threads share one durable log across engines. Key the client
  // cache the same way so changing models does not wipe the visible thread.
  if (isAgentHome(normalized)) return `thread|${repoPath}|${bareChatId(normalized)}`;
  return normalized === 'main'
    ? `${cli}|${repoPath}`
    : `${cli}|${repoPath}|${normalized}`;
}

/** Outbound turns waiting for a live `ready` socket. Module-level so a click
 *  to another agent (unmount) does not drop a message the user already sent —
 *  coming back to the thread flushes it. */
type QueuedOutbound = { text: string; images?: ChatSendImage[]; clientMsgId: string };
const outboundQueue = new Map<string, QueuedOutbound[]>();

function enqueueOutbound(key: string, item: QueuedOutbound): void {
  const q = outboundQueue.get(key) ?? [];
  q.push(item);
  outboundQueue.set(key, q);
}

function peekOutbound(key: string): QueuedOutbound | undefined {
  return outboundQueue.get(key)?.[0];
}

/** Remove only the item whose durable `_user_echo` proved server admission.
 * Keeping the head until that acknowledgement lets a reconnect safely retry a
 * send that raced an engine-switch handshake instead of losing it. */
function acknowledgeOutbound(key: string, clientMsgId: string): void {
  const q = outboundQueue.get(key);
  if (!q?.length) return;
  const index = q.findIndex((item) => item.clientMsgId === clientMsgId);
  if (index < 0) return;
  q.splice(index, 1);
  if (!q.length) outboundQueue.delete(key);
  else outboundQueue.set(key, q);
}

function hasOutbound(key: string, clientMsgId: string): boolean {
  return outboundQueue.get(key)?.some((item) => item.clientMsgId === clientMsgId) === true;
}

function cancelOutbound(key: string): QueuedOutbound[] {
  const queued = outboundQueue.get(key) ?? [];
  outboundQueue.delete(key);
  return queued;
}

/** Steers already accepted by the socket. Module-level so leaving the thread
 *  does not drop the optimistic bubble before `_user_echo`. */
type PendingSteer = {
  text: string;
  images?: ChatSendImage[];
  clientMsgId: string;
  ts: number;
};
const pendingSteerQueue = new Map<string, PendingSteer[]>();

function rememberPendingSteer(key: string, item: PendingSteer): void {
  const q = pendingSteerQueue.get(key) ?? [];
  if (q.some((steer) => steer.clientMsgId === item.clientMsgId)) return;
  q.push(item);
  pendingSteerQueue.set(key, q);
}

function forgetPendingSteer(key: string, clientMsgId: string): void {
  const q = pendingSteerQueue.get(key);
  if (!q?.length) return;
  const next = q.filter((item) => item.clientMsgId !== clientMsgId);
  if (!next.length) pendingSteerQueue.delete(key);
  else pendingSteerQueue.set(key, next);
}

function pendingSteersFor(key: string): PendingSteer[] {
  return pendingSteerQueue.get(key) ?? [];
}

function cancelPendingSteers(key: string): PendingSteer[] {
  const queued = pendingSteerQueue.get(key) ?? [];
  pendingSteerQueue.delete(key);
  return queued;
}

// Rebuild once from durable events to recover provider message boundaries and
// update/answer metadata missing from older flattened browser snapshots.
const CHAT_CACHE_VERSION = 'v8';

function blocksStorageKey(cli: CompanionId, repoPath: string, chatId = 'main'): string {
  // Browser snapshots are disposable; transcript history remains on the server.
  return `rivendell:chat-blocks:${CHAT_CACHE_VERSION}:${conversationKey(cli, repoPath, chatId)}`;
}

type StoredChatSnapshot = {
  version: typeof CHAT_CACHE_VERSION;
  blocks: ChatBlock[];
  seq: number;
  resetAt: number;
};

function parseStoredSnapshot(raw: string | null): StoredChatSnapshot | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredChatSnapshot>;
    if (parsed.version !== CHAT_CACHE_VERSION || !Array.isArray(parsed.blocks)) return null;
    if (typeof parsed.seq !== 'number' || !Number.isFinite(parsed.seq) || parsed.seq < 0) return null;
    // A persisted snapshot is settled: normalize stale streaming flags from
    // interrupted legacy turns so they cannot suppress the typing indicator.
    const blocks = parsed.blocks.map((block) => {
      if (block.kind === 'text' && block.open) return { ...block, open: false };
      if (block.kind === 'tool' && (block.open || block.running)) return { ...block, open: false, running: false };
      return block;
    });
    const resetAt = typeof parsed.resetAt === 'number' && Number.isFinite(parsed.resetAt) && parsed.resetAt > 0
      ? parsed.resetAt
      : 0;
    return { version: CHAT_CACHE_VERSION, blocks, seq: parsed.seq, resetAt };
  } catch {
    return null;
  }
}

function readStoredSnapshot(cli: CompanionId, repoPath: string, chatId = 'main'): StoredChatSnapshot | null {
  if (typeof window === 'undefined') return null;
  try {
    return parseStoredSnapshot(localStorage.getItem(blocksStorageKey(cli, repoPath, chatId)));
  } catch {
    return null;
  }
}

function readStoredBlocks(cli: CompanionId, repoPath: string, chatId = 'main'): ChatBlock[] {
  return readStoredSnapshot(cli, repoPath, chatId)?.blocks ?? [];
}

function blocksForStorage(blocks: ChatBlock[]): ChatBlock[] {
  // Never persist raw automation internals. A quiet routine is suppressed only
  // after its terminal NO_UPDATE/EOS arrives; storing the raw mid-turn list let
  // a tab switch restore an orphaned "Checking…" block without the automation
  // trigger/terminal boundary that hides it. Real routine deliverables survive
  // filterAutomationNoise as ordinary text.
  return filterAutomationNoise(blocks)
    .filter((block) => !(block.kind === 'text' && isLegacyCompactionSummaryText(block.text)))
    .slice(-200)
    .map((block) => {
      // A snapshot is never live: strip streaming flags so a reload can't
      // resurrect a phantom "working" block from an interrupted turn (a stale
      // open/running flag suppresses the typing indicator via hasOpen).
      if (block.kind === 'text' && block.open) return { ...block, open: false };
      if (block.kind === 'tool' && (block.open || block.running)) return { ...block, open: false, running: false };
      if (block.kind === 'user' && (block.images?.length || block.deliveryState === 'queued')) {
        // URL-backed images are cheap to keep. Optimistic data: URLs are not.
        // Keep imageCount so a tab switch still shows that a picture was queued.
        const keepable = (block.images ?? []).filter((img) => img.dataUrl.startsWith('/'));
        const { images: _images, ...rest } = block;
        return {
          ...rest,
          images: keepable.length ? keepable : undefined,
          imageCount: block.imageCount ?? block.images?.length,
        };
      }
      return block;
    });
}

function writeStoredState(
  cli: CompanionId,
  repoPath: string,
  chatId: string,
  blocks: ChatBlock[],
  seq: number,
  resetAt = 0,
): void {
  if (typeof window === 'undefined') return;
  const key = blocksStorageKey(cli, repoPath, chatId);
  const snapshot: StoredChatSnapshot = {
    version: CHAT_CACHE_VERSION,
    blocks: blocksForStorage(blocks),
    seq: Math.max(0, seq),
    resetAt: Math.max(0, resetAt),
  };
  try {
    // One atomic localStorage value: another tab can never observe filtered
    // blocks paired with a cursor from a different replay state.
    localStorage.setItem(key, JSON.stringify(snapshot));
  } catch (err) {
    // A transient write failure (quota, serialization) must NEVER destroy the
    // existing cache. Keep whatever was last stored; a missing snapshot asks
    // the durable server log for a full replay.
    console.warn('[chat] persist failed, keeping prior cache:', (err as Error).message);
  }
}

function restoreBlocksWithUniqueIds(blocks: ChatBlock[]): ChatBlock[] {
  let maxSeen = 0;
  const visibleBlocks = blocks.filter((block) => !(block.kind === 'text' && isLegacyCompactionSummaryText(block.text)));
  for (const block of visibleBlocks) {
    const blockMatch = /^b(\d+)$/.exec(block.id);
    if (blockMatch) maxSeen = Math.max(maxSeen, Number(blockMatch[1]));
    if ('turnId' in block && block.turnId) {
      const turnMatch = /^t(\d+)$/.exec(block.turnId);
      if (turnMatch) maxSeen = Math.max(maxSeen, Number(turnMatch[1]));
    }
  }
  if (maxSeen >= nextId) nextId = maxSeen + 1;

  const seen = new Set<string>();
  return visibleBlocks.map((block) => {
    if (!seen.has(block.id)) {
      seen.add(block.id);
      return block;
    }
    let nextBlockId = id();
    while (seen.has(nextBlockId)) nextBlockId = id();
    seen.add(nextBlockId);
    return { ...block, id: nextBlockId };
  });
}

function imagePreviews(images: ChatSendImage[] | undefined): ChatImagePreview[] | undefined {
  if (!images?.length) return undefined;
  const previews = images
    .map((image) => image.previewDataUrl ? { mediaType: image.mediaType, dataUrl: image.previewDataUrl } : null)
    .filter((image): image is ChatImagePreview => Boolean(image));
  return previews.length ? previews : undefined;
}

function payloadImages(images: ChatSendImage[] | undefined): Array<{ mediaType: string; base64: string }> | undefined {
  if (!images?.length) return undefined;
  return images.map((image) => ({ mediaType: image.mediaType, base64: image.base64 }));
}

/** Sync restore so the first paint of a remounted thread already has the
 *  transcript (Grok unmounts the feed while blocks are empty; an effect-only
 *  restore would flash the empty state and leave scrollTop at 0). */
function initialStoredBlocks(
  enabled: boolean | undefined,
  repo: Repo | undefined,
  cli: CompanionId,
  chatId: string,
): ChatBlock[] {
  if (enabled === false || !repo) return [];
  return restoreBlocksWithUniqueIds(readStoredBlocks(cli, repo.path, chatId));
}

export function useChat(opts: {
  repo: Repo | undefined;
  cli: CompanionId;
  chatId?: string;
  enabled: boolean;
  initialMessage?: string | null;
  onInitialMessageSent?: () => void;
  /** Model id (Banana + Codex). Rides on every send/steer. */
  model?: string;
  /** Optional known context window for engines whose model id does not encode it. */
  contextWindowTokens?: number | null;
  /** Reasoning/thinking effort for engines that expose one. */
  effort?: string;
  /** Process-local counter advanced only by an explicit picker action. Device
   * defaults never advance it, so a new computer cannot recycle a warm lane. */
  selectionRevision?: number;
  /** Explicitly account-pinned login for a custom lane, or undefined for the
   *  repo-resolved default. Rides inside the chatId so the server spawns the
   *  CLI under that account. Personal Claude/Codex lanes are gone. */
  account?: string;
}) {
  const {
    repo,
    cli,
    enabled,
    initialMessage,
    onInitialMessageSent,
    model,
    contextWindowTokens,
    effort,
    selectionRevision,
  } = opts;
  // Encode the account into the chatId (same `__acct__` separator the server
  // parses in accountResolver.ts). Every WS message + storage key then keys off
  // this, so switching account rebinds to that account's own session.
  const baseChatId = opts.chatId ?? 'main';
  const chatId = opts.account ? `${baseChatId}__acct__${opts.account}` : baseChatId;
  // Mirror the model into a ref so the WS send path always reads the latest
  // pick without re-subscribing the connection effect on every change.
  const modelRef = useRef<string | undefined>(model);
  modelRef.current = model;
  const effortRef = useRef<string | undefined>(effort);
  effortRef.current = effort;
  const selectionRevisionRef = useRef(selectionRevision ?? 0);
  selectionRevisionRef.current = selectionRevision ?? 0;
  const appliedSelectionRevisionRef = useRef(selectionRevision ?? 0);
  const selectionLane = `${cli}|${repo?.path ?? ''}|${chatId}`;
  const selectionLaneRef = useRef(selectionLane);
  /** A WebSocket being OPEN is not enough: after an engine/tab switch the
   * server must finish its hello/replay and answer `ready` before sends can use
   * that socket. Invalidate synchronously during render so a fast click cannot
   * leak through the prior lane before the connection effect cleans it up. */
  const socketReadyRef = useRef(false);
  const sentOutboundRef = useRef<{ key: string; clientMsgId: string } | null>(null);
  /** The server may temporarily keep this thread attached to a still-busy
   * previous engine after the picker changes. Stop must target that owner. */
  const serverCliRef = useRef<CompanionId>(cli);
  const serverThreadRef = useRef(`${repo?.path ?? ''}|${chatId}`);
  const serverThread = `${repo?.path ?? ''}|${chatId}`;
  if (serverThreadRef.current !== serverThread) {
    serverThreadRef.current = serverThread;
    serverCliRef.current = cli;
  }
  if (selectionLaneRef.current !== selectionLane) {
    selectionLaneRef.current = selectionLane;
    appliedSelectionRevisionRef.current = selectionRevisionRef.current;
    socketReadyRef.current = false;
    sentOutboundRef.current = null;
  }
  const selectionIntent = () => ({
    selectionRevision: selectionRevisionRef.current,
    reconfigure: selectionRevisionRef.current !== appliedSelectionRevisionRef.current,
  });
  const [blocks, setBlocks] = useState<ChatBlock[]>(() => initialStoredBlocks(enabled, repo, cli, chatId));
  // Cursor committed in the same React batch as the corresponding block
  // reductions. Persistence must use this state, never the receive-ahead ref.
  const [appliedSeq, setAppliedSeq] = useState(() => (
    enabled && repo ? readStoredSnapshot(cli, repo.path, chatId)?.seq ?? 0 : 0
  ));
  const cacheResetAtRef = useRef(
    enabled && repo ? readStoredSnapshot(cli, repo.path, chatId)?.resetAt ?? 0 : 0,
  );
  /** True between a user send/steer and the next turnStart/turnEnd/error. */
  const pendingSendRef = useRef(false);
  /** Guidance waiting behind a natural turnEnd. Keep the UI streaming across
   * that preceding turnEnd until the server accepts/rejects every queued steer.
   * A Set, not a single id: stacked mid-turn messages must all stay queued. */
  const queuedSteerRef = useRef<Set<string>>(new Set());
  // `chatId` already carries `__acct__<account>` when the lane is pinned.
  const restoreKey = enabled && repo ? conversationKey(cli, repo.path, chatId) : '';
  const restoreKeyRef = useRef(restoreKey);
  if (restoreKeyRef.current !== restoreKey) {
    restoreKeyRef.current = restoreKey;
    const snapshot = enabled && repo ? readStoredSnapshot(cli, repo.path, chatId) : null;
    const restored = restoreBlocksWithUniqueIds(snapshot?.blocks ?? []);
    queuedSteerRef.current = new Set(
      restored.flatMap((block) => (
        block.kind === 'user' && block.deliveryState === 'queued' && block.clientMsgId
          ? [block.clientMsgId]
          : []
      )),
    );
    pendingSendRef.current = queuedSteerRef.current.size > 0;
    setBlocks(restored);
    setAppliedSeq(snapshot?.seq ?? 0);
    cacheResetAtRef.current = snapshot?.resetAt ?? 0;
  }
  const [status, setStatus] = useState<Status>('idle');
  // Mirror status into a ref so WS handlers can read the latest value
  // without depending on render closure (used by error-suppression logic).
  const statusRef = useRef<Status>('idle');
  statusRef.current = status;
  const [error, setError] = useState<string | null>(null);
  const [serverBrain, setServerBrain] = useState<ServerBrainState | null>(null);
  const [usage, setUsage] = useState<ContextUsage | null>(null);
  // Window size for the active CLI. Seeded from the per-CLI default and
  // refined by the `system/init` event (claude) or by the safety ratchet
  // when observed usage exceeds the assumed window.
  const windowTokensRef = useRef<number>(windowForCli(cli, model, contextWindowTokens));
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const teardownRef = useRef(false);
  const connectionIdRef = useRef(0);
  /** Wall-clock of the last server message on the current socket. The stream
   *  watchdog uses it to detect a silently stalled turn, and the live "working"
   *  banner uses it to show "last token Ns ago". */
  const lastMessageAtRef = useRef<number>(Date.now());
  /** When the current turn started — ref powers watchdog math; state powers UI. */
  const turnStartRef = useRef<number>(0);
  const [turnStartedAt, setTurnStartedAt] = useState(0);
  const markTurnStarted = (at = Date.now(), force = false) => {
    if (!force && turnStartRef.current > 0) return;
    turnStartRef.current = at;
    setTurnStartedAt(at);
  };
  const clearTurnStarted = () => {
    turnStartRef.current = 0;
    setTurnStartedAt(0);
  };
  /** True while the CLI is compacting context (a quiet phase that would
   *  otherwise look like a hang). */
  const compactingRef = useRef<boolean>(false);
  const turnIdRef = useRef('') as ReducerCursor;
  /** Set by the connection effect so the returned `reconnect()` can force a
   *  close-and-reopen even when auto-reconnect is mid-backoff. */
  const forceReconnectRef = useRef<() => void>(() => {});
  // Mirror the initial message into a ref so the WS onmessage handler can
  // read the latest value without re-subscribing every render.
  const initialMessageRef = useRef<string | null>(initialMessage ?? null);
  const initialClientMsgIdRef = useRef<string | null>(null);
  const initialSendInFlightRef = useRef(false);
  const onInitialMessageSentRef = useRef(onInitialMessageSent);
  onInitialMessageSentRef.current = onInitialMessageSent;
  /** Latest event seq received from server. Sent on reconnect for replay. */
  const lastSeqRef = useRef(-1);
  /** Key (`${cli}|${repoPath}|${chatId}`) of the conversation we've already restored from
   *  storage. Writes are gated on this so we don't wipe a saved chat with the
   *  empty initial state on the first render after repos load. */
  const restoredKeyRef = useRef<string | null>(null);
  const flushOutboundRef = useRef<() => void>(() => {});
  const settleInitialMessage = (clientMsgId?: string) => {
    if (!initialSendInFlightRef.current) return;
    if (clientMsgId && initialClientMsgIdRef.current !== clientMsgId) return;
    initialSendInFlightRef.current = false;
    initialMessageRef.current = null;
    initialClientMsgIdRef.current = null;
    onInitialMessageSentRef.current?.();
  };
  const markBlockDelivered = (clientMsgId: string) => {
    if (repo) forgetPendingSteer(conversationKey(cli, repo.path, chatId), clientMsgId);
    setBlocks((prev) => prev.map((block) => (
      block.kind === 'user'
      && block.clientMsgId === clientMsgId
      && block.deliveryState !== undefined
        ? { ...block, deliveryState: undefined }
        : block
    )));
  };
  /** Reconcile optimistic bubbles with both sides of the server lifecycle.
   * `queuedClientMsgIds` contains guidance still waiting for a boundary;
   * `deliveredClientMsgIds` contains durable _user_echo receipts. A missing
   * queue id while the lane is busy can mean it is the ACTIVE turn, never a
   * failure. Older servers omit receipt fields, so only arrays are authoritative. */
  const reconcileQueuedState = (rawQueuedIds: unknown, rawDeliveredIds: unknown, serverBusy: boolean) => {
    const hasQueuedState = Array.isArray(rawQueuedIds);
    const hasDeliveredState = Array.isArray(rawDeliveredIds);
    if (!hasQueuedState && !hasDeliveredState) return;
    const queuedIds = new Set(
      hasQueuedState
        ? (rawQueuedIds as unknown[]).filter((value): value is string => typeof value === 'string')
        : [],
    );
    const deliveredIds = new Set(
      hasDeliveredState
        ? (rawDeliveredIds as unknown[]).filter((value): value is string => typeof value === 'string')
        : [],
    );
    setBlocks((prev) => prev.map((block) => {
      if (block.kind !== 'user' || !block.clientMsgId) return block;
      if (deliveredIds.has(block.clientMsgId) && block.deliveryState !== undefined) {
        return { ...block, deliveryState: undefined };
      }
      if (
        hasQueuedState
        && !serverBusy
        && block.deliveryState === 'queued'
        && !queuedIds.has(block.clientMsgId)
      ) return { ...block, deliveryState: 'failed' as const };
      return block;
    }));
    const current = [...queuedSteerRef.current];
    let droppedUnretained = false;
    for (const id of current) {
      if (deliveredIds.has(id)) {
        if (repo) forgetPendingSteer(conversationKey(cli, repo.path, chatId), id);
        queuedSteerRef.current.delete(id);
      } else if (hasQueuedState && !serverBusy && !queuedIds.has(id)) {
        if (repo) forgetPendingSteer(conversationKey(cli, repo.path, chatId), id);
        queuedSteerRef.current.delete(id);
        droppedUnretained = true;
      }
    }
    pendingSendRef.current = queuedSteerRef.current.size > 0 || Boolean(peekOutbound(conversationKey(cli, repo?.path ?? '', chatId)));
    if (droppedUnretained && queuedSteerRef.current.size === 0) {
      setError('Queued guidance was not retained by the server. Please send it again.');
      setStatus('ready');
    } else if (current.some((id) => deliveredIds.has(id)) && queuedSteerRef.current.size === 0) {
      setError(null);
    }
  };
  const flushOutbound = () => {
    if (!repo || !socketReadyRef.current) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const key = conversationKey(cli, repo.path, chatId);
    const item = peekOutbound(key);
    if (!item || sentOutboundRef.current?.clientMsgId === item.clientMsgId) return;
    pendingSendRef.current = true;
    setError(null);
    markTurnStarted();
    lastMessageAtRef.current = Date.now();
    compactingRef.current = false;
    setStatus('streaming');
    // Do not dequeue until the durable _user_echo arrives. A socket can be OPEN
    // before its asynchronous hello/replay is ready; retaining this item makes
    // a handshake rejection or disconnect safely retryable.
    sentOutboundRef.current = { key, clientMsgId: item.clientMsgId };
    try {
      ws.send(JSON.stringify({
        type: 'send',
        cli,
        repo: repo.path,
        chatId,
        sinceSeq: lastSeqRef.current,
        text: item.text,
        images: payloadImages(item.images),
        clientMsgId: item.clientMsgId,
        model: modelRef.current,
        effort: effortRef.current,
        ...selectionIntent(),
      }));
    } catch {
      sentOutboundRef.current = null;
      socketReadyRef.current = false;
      window.setTimeout(() => forceReconnectRef.current(), 0);
    }
  };
  flushOutboundRef.current = flushOutbound;

  const rejectOutbound = (clientMsgId: string, message: string, serverBusy: boolean): boolean => {
    if (!repo) return false;
    const key = conversationKey(cli, repo.path, chatId);
    const owned = hasOutbound(key, clientMsgId)
      || sentOutboundRef.current?.clientMsgId === clientMsgId
      || initialClientMsgIdRef.current === clientMsgId
      || pendingSteersFor(key).some((item) => item.clientMsgId === clientMsgId);
    if (!owned) return false;
    acknowledgeOutbound(key, clientMsgId);
    forgetPendingSteer(key, clientMsgId);
    if (sentOutboundRef.current?.clientMsgId === clientMsgId) sentOutboundRef.current = null;
    settleInitialMessage(clientMsgId);
    setBlocks((prev) => prev.map((block) => (
      block.kind === 'user' && block.clientMsgId === clientMsgId
        ? { ...block, deliveryState: 'failed' as const }
        : block
    )));
    const hasMore = Boolean(peekOutbound(key));
    pendingSendRef.current = hasMore || queuedSteerRef.current.size > 0;
    setError(message);
    if (serverBusy || hasMore || queuedSteerRef.current.size > 0) {
      markTurnStarted();
      setStatus('streaming');
      if (!serverBusy && hasMore) window.setTimeout(() => flushOutboundRef.current(), 0);
    } else {
      clearTurnStarted();
      setStatus('ready');
    }
    return true;
  };

  useEffect(() => {
    const nextWindow = windowForCli(cli, model, contextWindowTokens);
    windowTokensRef.current = nextWindow;
    setUsage((prev) => {
      if (!prev) return prev;
      const total = prev.inputTokens + prev.cacheReadTokens + prev.cacheCreateTokens;
      return {
        ...prev,
        windowTokens: nextWindow,
        fraction: Math.min(total / nextWindow, 1),
      };
    });
  }, [cli, model, contextWindowTokens]);

  useEffect(() => {
    if (!initialMessage) {
      if (!initialSendInFlightRef.current) {
        initialMessageRef.current = null;
        initialClientMsgIdRef.current = null;
      }
      return;
    }
    if (!repo) return;
    if (initialMessageRef.current !== initialMessage) {
      initialMessageRef.current = initialMessage;
      initialClientMsgIdRef.current = null;
      initialSendInFlightRef.current = false;
    }
    if (initialSendInFlightRef.current) return;

    // Suggestions/threshold initial prompts use the exact same stable-ID,
    // durable-echo admission path as composer sends. A reconnect can retry the
    // same ID, never invent a second user turn.
    const clientMsgId = initialClientMsgIdRef.current
      ?? `cm-${Date.now().toString(36)}-${nextId++}`;
    initialClientMsgIdRef.current = clientMsgId;
    initialSendInFlightRef.current = true;
    const key = conversationKey(cli, repo.path, chatId);
    if (!hasOutbound(key, clientMsgId)) {
      enqueueOutbound(key, { text: initialMessage, clientMsgId });
    }
    setBlocks((prev) => {
      if (prev.some((block) => block.kind === 'user' && block.clientMsgId === clientMsgId)) return prev;
      return [...prev, { kind: 'user', id: id(), text: initialMessage, clientMsgId, ts: Date.now() }];
    });
    pendingSendRef.current = true;
    markTurnStarted(Date.now(), true);
    setError(null);
    setStatus('streaming');
    flushOutboundRef.current();
  }, [chatId, cli, initialMessage, repo?.path]);

  // Save to localStorage whenever blocks change, so a refresh restores them.
  // CRITICAL: skip until the read-and-restore effect below has run for the
  // current (cli, repo) — otherwise the first render after repos resolve
  // writes blocks=[] over saved history before we get a chance to load it.
  useEffect(() => {
    if (!repo) return;
    const key = conversationKey(cli, repo.path, chatId);
    if (restoredKeyRef.current !== key) return;
    // Cache settled turns. Also cache while a user message is still queued so
    // leaving the tab does not wipe the optimistic bubble (especially images).
    const hasQueuedUser = blocks.some((block) => block.kind === 'user' && block.deliveryState === 'queued');
    if (status !== 'ready' && !hasQueuedUser) return;
    writeStoredState(cli, repo.path, chatId, blocks, appliedSeq, cacheResetAtRef.current);
  }, [blocks, appliedSeq, status, repo?.path, cli, chatId]);

  useEffect(() => {
    if (!enabled || !repo) return;

    teardownRef.current = false;
    const connectionId = ++connectionIdRef.current;
    const isCurrentConnection = () => connectionIdRef.current === connectionId && !teardownRef.current;
    // Reset the assumed context window to the selected model each time we
    // (re)connect. The system/init event will refine it for Claude.
    windowTokensRef.current = windowForCli(cli, modelRef.current, contextWindowTokens);
    setUsage(null);
    setServerBrain(null);
    // Restore prior blocks from localStorage so a page reload doesn't wipe
    // the chat. Server replay then fills in events newer than what we have.
    const snapshot = readStoredSnapshot(cli, repo.path, chatId);
    const stored = restoreBlocksWithUniqueIds(snapshot?.blocks ?? []);
    const key = conversationKey(cli, repo.path, chatId);
    const remembered = pendingSteersFor(key);
    const rememberedById = new Map(remembered.map((item) => [item.clientMsgId, item]));
    const knownIds = new Set(
      stored.flatMap((block) => (
        block.kind === 'user' && block.clientMsgId ? [block.clientMsgId] : []
      )),
    );
    const withRememberedImages = remembered.length
      ? stored.map((block) => {
        if (block.kind !== 'user' || !block.clientMsgId) return block;
        const item = rememberedById.get(block.clientMsgId);
        if (!item?.images?.length) return block;
        return {
          ...block,
          images: imagePreviews(item.images) ?? block.images,
          imageCount: item.images.length,
          deliveryState: block.deliveryState ?? 'queued' as const,
        };
      })
      : stored;
    const restored = remembered.length
      ? [
        ...withRememberedImages,
        ...remembered
          .filter((item) => !knownIds.has(item.clientMsgId))
          .map((item) => ({
            kind: 'user' as const,
            id: id(),
            text: item.text,
            images: imagePreviews(item.images),
            imageCount: item.images?.length,
            clientMsgId: item.clientMsgId,
            deliveryState: 'queued' as const,
            ts: item.ts,
          })),
      ]
      : stored;
    setBlocks(restored);
    queuedSteerRef.current = new Set(
      restored.flatMap((block) => (
        block.kind === 'user' && block.deliveryState === 'queued' && block.clientMsgId
          ? [block.clientMsgId]
          : []
      )),
    );
    pendingSendRef.current = queuedSteerRef.current.size > 0;
    turnIdRef.current = '';
    turnIdRef.peerId = undefined;
    clearTurnStarted();
    reconnectAttemptRef.current = 0;
    // The atomic envelope distinguishes a valid, fully-filtered empty thread
    // from a missing/corrupt cache. Missing state asks for a full replay;
    // an intentionally empty settled snapshot safely resumes at its cursor.
    lastSeqRef.current = snapshot?.seq ?? 0;
    setAppliedSeq(snapshot?.seq ?? 0);
    cacheResetAtRef.current = snapshot?.resetAt ?? 0;
    // Mark this conversation as restored so the persistence-write effect can
    // safely begin saving updates back to storage.
    restoredKeyRef.current = conversationKey(cli, repo.path, chatId);

    /** Strip handlers and close a socket so it can't fire onopen/onclose into
     *  the new connection's state. Used before replacing wsRef during a
     *  forced reconnect or a fall-through reconcile, where the prior socket
     *  may still be CONNECTING or CLOSING. */
    const detachSocket = (socket: WebSocket | null) => {
      if (!socket) return;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try { socket.close(); } catch {}
    };

    const connect = () => {
      if (!isCurrentConnection()) return;
      // Detach whatever is still parked in wsRef. A socket left CONNECTING or
      // CLOSING keeps its handlers: its onopen fires a duplicate hello and its
      // onclose schedules a competing reconnect. That is how one tab
      // accumulated dozens of live sockets, each re-helloing the same lane.
      if (wsRef.current) detachSocket(wsRef.current);
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${window.location.host}/api/ws`);
      wsRef.current = ws;
      // Mid-turn reconnects must not flip 'streaming' → 'connecting' or the
      // thinking UI dies and a tool/think pause looks like a crashed line.
      const keepStreaming = statusRef.current === 'streaming' || pendingSendRef.current;
      if (!keepStreaming) setStatus('connecting');
      // Replay guard lives at effect scope (declared below connect) — see
      // reconcileNow for the second hello path.
      socketReady = false;
      socketReadyRef.current = false;
      sentOutboundRef.current = null;
      lastMessageAtRef.current = Date.now();

      ws.onopen = () => {
        if (!isCurrentConnection()) return;
        ws.send(JSON.stringify({
          type: 'hello',
          cli,
          repo: repo.path,
          chatId,
          sinceSeq: lastSeqRef.current,
          resetAt: cacheResetAtRef.current,
          model: modelRef.current,
          effort: effortRef.current,
          ...selectionIntent(),
          visible: document.visibilityState === 'visible',
        }));
      };
      ws.onmessage = (e) => {
        if (!isCurrentConnection()) return;
        lastMessageAtRef.current = Date.now();
        let msg: any;
        try { msg = JSON.parse(String(e.data)); }
        catch { return; }
        // Track every server event's sequence so reconnect can resume. A
        // cross-tab snapshot may jump this cursor ahead while this socket still
        // drains an older replay queue; discard those covered events instead of
        // reducing them twice into duplicate blocks.
        if (typeof msg.seq === 'number') {
          if (msg.seq <= lastSeqRef.current) return;
          lastSeqRef.current = msg.seq;
          setAppliedSeq((current) => Math.max(current, msg.seq));
        }
        if (typeof msg.latestSeq === 'number' && msg.latestSeq > lastSeqRef.current) {
          lastSeqRef.current = msg.latestSeq;
          // `latestSeq` is emitted only after hello replay has sent every
          // durable event through that boundary, so it is safe to commit.
          setAppliedSeq((current) => Math.max(current, msg.latestSeq));
        }
        if (msg.type === 'working') {
          // Transport keepalive while the engine is on a tool/think pause.
          // It also carries authoritative queued-steer ownership so a cached
          // bubble cannot remain "will run next" after a lost operation.
          reconcileQueuedState(msg.queuedClientMsgIds, msg.deliveredClientMsgIds, msg.busy === true);
          // Server busy state is authoritative. If a re-hello or transient
          // transport error briefly painted this lane idle, restore liveness
          // instead of leaving the user with no indicator while work continues.
          if (typeof msg.activeCli === 'string') serverCliRef.current = msg.activeCli as CompanionId;
          if (socketReady && msg.busy === true) {
            setError(null);
            markTurnStarted();
            setStatus('streaming');
          }
          return;
        }
        if (msg.type === 'ready') {
          socketReady = true;
          if (typeof msg.resetAt === 'number' && Number.isFinite(msg.resetAt)) {
            cacheResetAtRef.current = Math.max(cacheResetAtRef.current, msg.resetAt);
          }
          socketReadyRef.current = true;
          serverCliRef.current = typeof msg.activeCli === 'string'
            ? msg.activeCli as CompanionId
            : cli;
          if (typeof msg.cli === 'string') {
            setServerBrain({
              cli: msg.cli as CompanionId,
              model: typeof msg.model === 'string' ? msg.model : undefined,
              effort: typeof msg.effort === 'string' ? msg.effort : undefined,
              activeCli: serverCliRef.current,
              activeModel: typeof msg.activeModel === 'string' ? msg.activeModel : undefined,
              activeEffort: typeof msg.activeEffort === 'string' ? msg.activeEffort : undefined,
              revision: Number.isSafeInteger(msg.brainRevision) ? msg.brainRevision : undefined,
              pending: msg.brainPending === true,
            });
          }
          reconcileQueuedState(msg.queuedClientMsgIds, msg.deliveredClientMsgIds, msg.busy === true);
          // If the server says we attached to a busy session (Sam is mid-turn
          // because the user reconnected from a phone unlock or tab switch),
          // jump straight to 'streaming' so the UI shows tending instead of
          // looking idle while events stream in via replay.
          setError(null);
          reconnectAttemptRef.current = 0;
          // Every composer and threshold send waits in the same stable-ID FIFO
          // until this ready boundary, then remains there until durable echo.
          const queued = outboundQueue.get(conversationKey(cli, repo.path, chatId));
          if (queued && queued.length > 0 && ws.readyState === WebSocket.OPEN) {
            setStatus('streaming');
            // If the server is already busy, this may be the very send whose
            // durable echo has not replayed yet. Wait for echo/turnEnd instead
            // of submitting the same user message as mid-turn guidance.
            if (!msg.busy) flushOutboundRef.current();
          } else {
            // A server-owned steer can outlive the socket that accepted it.
            // Keep its visible queued state across reconnect; the durable
            // _user_echo will clear it when the next turn is actually admitted.
            const steerQueued = queuedSteerRef.current.size > 0;
            setStatus(msg.busy || steerQueued ? 'streaming' : 'ready');
            if (!msg.busy && !steerQueued) {
              pendingSendRef.current = false;
              compactingRef.current = false;
              clearTurnStarted();
            }
          }
        }
        else if (msg.type === 'selectionApplied') {
          if (Number.isSafeInteger(msg.selectionRevision) && msg.selectionRevision >= 0) {
            appliedSelectionRevisionRef.current = msg.selectionRevision;
          }
          setServerBrain((current) => {
            const appliedCli = typeof msg.cli === 'string'
              ? msg.cli as CompanionId
              : current?.cli;
            if (!appliedCli) return current;
            const appliedModel = Object.prototype.hasOwnProperty.call(msg, 'model')
              ? typeof msg.model === 'string' ? msg.model : undefined
              : current?.model;
            const appliedEffort = Object.prototype.hasOwnProperty.call(msg, 'effort')
              ? typeof msg.effort === 'string' ? msg.effort : undefined
              : current?.effort;
            return {
              cli: appliedCli,
              model: appliedModel,
              effort: appliedEffort,
              activeCli: appliedCli,
              activeModel: appliedModel,
              activeEffort: appliedEffort,
              revision: Number.isSafeInteger(msg.brainRevision) ? msg.brainRevision : current?.revision,
              pending: false,
            };
          });
        }
        else if (msg.type === 'replayReset') {
          // Server detected an impossible/stale browser generation and is about
          // to replay the durable thread from its beginning. Retire every local
          // outbound owner too: an offline device must never flush a pre-Fresh
          // draft into the newly reset conversation after ready arrives.
          cancelOutbound(conversationKey(cli, repo.path, chatId));
          sentOutboundRef.current = null;
          settleInitialMessage();
          queuedSteerRef.current = new Set();
          pendingSendRef.current = false;
          setBlocks([]);
          setUsage(null);
          setError(null);
          turnIdRef.current = '';
          turnIdRef.peerId = undefined;
          clearTurnStarted();
          lastSeqRef.current = 0;
          setAppliedSeq(0);
          if (typeof msg.resetAt === 'number' && Number.isFinite(msg.resetAt)) {
            cacheResetAtRef.current = Math.max(cacheResetAtRef.current, msg.resetAt);
          }
          writeStoredState(cli, repo.path, chatId, [], 0, cacheResetAtRef.current);
        }
        else if (msg.type === 'sessionRebound') {
          lastSeqRef.current = 0;
          setAppliedSeq(0);
          setError(null);
        }
        else if (msg.type === 'turnStart') {
          if (!socketReady) return; // replayed control message from the hello buffer
          const beginsQueuedSteer = Boolean(
            msg.clientMsgId && queuedSteerRef.current.has(msg.clientMsgId),
          );
          if (beginsQueuedSteer && msg.clientMsgId) queuedSteerRef.current.delete(msg.clientMsgId);
          if (beginsQueuedSteer || statusRef.current !== 'streaming' || turnStartRef.current === 0) {
            markTurnStarted(Date.now(), beginsQueuedSteer);
          }
          settleInitialMessage(msg.clientMsgId);
          pendingSendRef.current = queuedSteerRef.current.size > 0;
          compactingRef.current = false;
          setError(null);
          setStatus('streaming');
        }
        else if (msg.type === 'turnEnd') {
          if (!socketReady) return; // replayed control message from the hello buffer
          window.dispatchEvent(new Event('rivendell:history-changed'));
          compactingRef.current = false;
          if (queuedSteerRef.current.size > 0) {
            // This closes the PRECEDING turn. The server still owns queued
            // guidance and will send a correlated turnStart or rejection.
            setStatus('streaming');
            return;
          }
          clearTurnStarted();
          pendingSendRef.current = false;
          const leftover = outboundQueue.get(conversationKey(cli, repo.path, chatId));
          if (leftover && leftover.length > 0) {
            if (serverCliRef.current !== cli) {
              // A prior engine owned the turn while the picker had already
              // moved. Re-hello on the selected engine at the natural boundary,
              // then flush the retained FIFO only after its ready frame.
              socketReadyRef.current = false;
              sentOutboundRef.current = null;
              setStatus('streaming');
              window.setTimeout(() => forceReconnectRef.current(), 0);
            } else {
              flushOutboundRef.current();
            }
          } else {
            setStatus('ready');
          }
        }
        else if (msg.type === 'compacted') {
          // Auto-compaction marker: the model's context rotated (juicy summary
          // banked to RAG). The visible thread lives on — just draw the line.
          setBlocks((prev) => {
            const id = `compact-${msg.seq}`;
            if (prev.some((b) => b.id === id)) return prev;
            return [...prev, {
              kind: 'compact',
              id,
              ts: msg.at ?? Date.now(),
              words: msg.words ?? 0,
              turns: msg.turns ?? 0,
              count: msg.count ?? 1,
              savedToRag: msg.savedToRag,
            } as ChatBlock];
          });
        }
        else if (msg.type === 'freshStarted') {
          const key = conversationKey(cli, repo.path, chatId);
          cancelOutbound(key);
          sentOutboundRef.current = null;
          settleInitialMessage();
          queuedSteerRef.current = new Set();
          pendingSendRef.current = false;
          socketReadyRef.current = msg.remote !== true;
          setBlocks([]);
          setUsage(null);
          setError(null);
          setStatus(msg.remote === true ? 'connecting' : 'ready');
          turnIdRef.current = '';
          turnIdRef.peerId = undefined;
          clearTurnStarted();
          lastSeqRef.current = 0;
          setAppliedSeq(0);
          if (typeof msg.resetAt === 'number' && Number.isFinite(msg.resetAt)) {
            cacheResetAtRef.current = Math.max(cacheResetAtRef.current, msg.resetAt);
          }
          writeStoredState(cli, repo.path, chatId, [], 0, cacheResetAtRef.current);
          if (msg.remote === true) {
            window.setTimeout(() => forceReconnectRef.current(), 0);
          }
        }
        else if (msg.type === 'sessionClosed') {
          queuedSteerRef.current = new Set();
          // The CLI idle-closed (or exited mid-turn). Don't strand the user on
          // a dead-looking "asleep" banner — re-bind transparently, exactly
          // like samwise-2. bindSession replies with a fresh ready/streaming.
          pendingSendRef.current = false;
          clearTurnStarted();
          setError(null);
          setStatus('closed');
          window.setTimeout(() => forceReconnectRef.current(), 250);
        }
        else if (msg.type === 'stream') {
          // Track compaction so the working banner can say "compacting context"
          // instead of looking hung. The claude CLI signals compaction START with
          // a system/status event (status:"compacting") and the END boundary with
          // system/compact_boundary. CRUCIAL: with --include-partial-messages the
          // CLI wraps real content under a `stream_event` envelope, so the content
          // type lives at event.event.type, NOT event.type. The old code checked
          // the top-level type, which is always 'stream_event' for content, so the
          // flag NEVER cleared and "compacting context" stuck for the whole turn.
          const ev = msg.event;
          const evType = ev?.type;
          if (evType === '_terminal_error') setError(null);
          if (evType === '_user_echo' && typeof ev?.clientMsgId === 'string') {
            const key = conversationKey(cli, repo.path, chatId);
            acknowledgeOutbound(key, ev.clientMsgId);
            if (sentOutboundRef.current?.clientMsgId === ev.clientMsgId) {
              sentOutboundRef.current = null;
            }
            settleInitialMessage(ev.clientMsgId);
            setError(null);
            if (queuedSteerRef.current.has(ev.clientMsgId)) {
              queuedSteerRef.current.delete(ev.clientMsgId);
              pendingSendRef.current = queuedSteerRef.current.size > 0;
            }
          }
          const innerType = evType === 'stream_event' ? ev?.event?.type : evType;
          const provesActiveTurn = evType === '_user_echo'
            || evType === 'assistant'
            || innerType === 'message_start'
            || innerType === 'content_block_start'
            || innerType === 'content_block_delta';
          if (socketReady && provesActiveTurn) {
            setError(null);
            markTurnStarted();
            setStatus('streaming');
          }
          if (evType === 'system' && ev?.subtype === 'status' && ev?.status === 'compacting') {
            compactingRef.current = true;
          } else if (
            (evType === 'system' && ev?.subtype === 'compact_boundary') ||
            innerType === 'message_start' ||
            innerType === 'content_block_start' ||
            innerType === 'content_block_delta'
          ) {
            compactingRef.current = false;
          }
          setBlocks((prev) => reduce(prev, msg.event, turnIdRef));
          // Pick up the model id from claude's system/init event so the
          // context meter knows which window to divide against. Opus 4.7
          // with the `[1m]` suffix is 1M; defaults stay at 200K.
          if (
            cli !== 'codex' &&
            msg.event?.type === 'system' &&
            msg.event?.subtype === 'init' &&
            typeof msg.event?.model === 'string'
          ) {
            // Prefer CLI-aware window (xai -> 500K) over bare model match so a
            // future grok id rename can't drop the meter back to 200K.
            windowTokensRef.current = windowForCli(cli, msg.event.model, contextWindowTokens);
          }
          // Power the context meter from per-API-call usage.
          //
          // Claude Code's `result.usage` is cumulative across every API
          // call in a turn — a turn that uses N tools makes N+1 calls and
          // cache_read_input_tokens gets summed N+1 times, inflating the
          // displayed total by roughly Nx. So for claude we track usage
          // from `assistant` events instead, where each event corresponds
          // to one API call and `message.usage` is that call's real input
          // size. Taking the most recent assistant event in a turn gives
          // us the true context size of the most recent call.
          //
          // Codex/Banana don't have this Claude cumulative-result bug:
          // Codex and Banana synthesize one result usage payload per turn.
          // Z.ai emits zeroes on assistant.message.usage but real per-call
          // numbers on the final message_delta, so read that instead.
          const messageDeltaUsage =
            cli === 'zai' &&
            msg.event?.type === 'stream_event' &&
            msg.event?.event?.type === 'message_delta' &&
            msg.event.event.usage
              ? (msg.event.event.usage as Record<string, number | undefined>)
              : null;
          const usagePayload =
            messageDeltaUsage ??
            (cli !== 'zai' &&
            !shouldReadResultUsage(cli) &&
            msg.event?.type === 'assistant' &&
            msg.event?.message?.usage
              ? (msg.event.message.usage as Record<string, number | undefined>)
              : shouldReadResultUsage(cli) &&
                  msg.event?.type === 'result' &&
                  msg.event?.usage
                ? (msg.event.usage as Record<string, number | undefined>)
                : null);

          if (usagePayload) {
            const input = usagePayload.input_tokens ?? 0;
            const cacheRead = usagePayload.cache_read_input_tokens ?? 0;
            const cacheCreate = usagePayload.cache_creation_input_tokens ?? 0;
            const output = usagePayload.output_tokens ?? 0;
            const total = input + cacheRead + cacheCreate;
            // Safety net (claude only): if observed usage exceeds the known
            // window, ratchet up to 1M. Covers the case where init didn't
            // carry a model id but the session is plainly running on the
            // large-context variant. Codex windows come from the model catalog,
            // so the meter clamps at 100% if reported usage somehow exceeds one.
            if (
              !isCodexCli(cli) &&
              total > windowTokensRef.current &&
              windowTokensRef.current < LARGE_WINDOW_TOKENS
            ) {
              windowTokensRef.current = LARGE_WINDOW_TOKENS;
            }
            const windowTokens = windowTokensRef.current;
            setUsage({
              inputTokens: input,
              cacheReadTokens: cacheRead,
              cacheCreateTokens: cacheCreate,
              outputTokens: output,
              fraction: Math.min(total / windowTokens, 1),
              windowTokens,
            });
          }
        }
        else if (msg.type === 'sendAdmission') {
          if (typeof msg.activeCli === 'string') serverCliRef.current = msg.activeCli as CompanionId;
          if (typeof msg.clientMsgId !== 'string') return;
          const key = conversationKey(cli, repo.path, chatId);
          const owned = hasOutbound(key, msg.clientMsgId)
            || sentOutboundRef.current?.clientMsgId === msg.clientMsgId
            || initialClientMsgIdRef.current === msg.clientMsgId;
          if (!owned) return;
          if (msg.state === 'pending') {
            pendingSendRef.current = true;
            setError(null);
            markTurnStarted();
            setStatus('streaming');
            return;
          }
          if (msg.state === 'accepted') {
            acknowledgeOutbound(key, msg.clientMsgId);
            markBlockDelivered(msg.clientMsgId);
            if (sentOutboundRef.current?.clientMsgId === msg.clientMsgId) {
              sentOutboundRef.current = null;
            }
            settleInitialMessage(msg.clientMsgId);
            setError(null);
            const hasMore = Boolean(peekOutbound(key));
            pendingSendRef.current = hasMore || queuedSteerRef.current.size > 0;
            if (msg.busy === true || hasMore || queuedSteerRef.current.size > 0) {
              markTurnStarted();
              setStatus('streaming');
              if (msg.busy !== true && hasMore) window.setTimeout(() => flushOutboundRef.current(), 0);
            } else {
              clearTurnStarted();
              setStatus('ready');
            }
          }
        }
        else if (msg.type === 'sendRejected') {
          if (typeof msg.clientMsgId === 'string') {
            rejectOutbound(
              msg.clientMsgId,
              msg.message || 'The message was not delivered.',
              msg.busy === true,
            );
          }
        }
        else if (msg.type === 'steerRejected') {
          if (typeof msg.clientMsgId === 'string') {
            setBlocks((prev) => prev.map((block) => (
              block.kind === 'user' && block.clientMsgId === msg.clientMsgId
                ? { ...block, deliveryState: 'failed' as const }
                : block
            )));
          }
          if (typeof msg.clientMsgId === 'string' && queuedSteerRef.current.has(msg.clientMsgId)) {
            queuedSteerRef.current.delete(msg.clientMsgId);
            pendingSendRef.current = queuedSteerRef.current.size > 0;
            setError(msg.message || 'Queued guidance was not delivered.');
            setStatus(msg.busy || queuedSteerRef.current.size > 0 ? 'streaming' : 'ready');
          }
        }
        else if (msg.type === 'error') {
          const handshakePending = msg.code === 'HANDSHAKE_PENDING'
            || msg.message === 'no session - send hello first';
          if (handshakePending) {
            // Engine switches can leave an OPEN socket a few milliseconds ahead
            // of its hello/replay. Keep the unacknowledged outbound item, hide
            // the internal protocol error, and reconnect; ready will retry it.
            const hadPendingSend = Boolean(sentOutboundRef.current || initialSendInFlightRef.current);
            sentOutboundRef.current = null;
            socketReadyRef.current = false;
            setError(null);
            if (hadPendingSend) {
              pendingSendRef.current = true;
              markTurnStarted();
              setStatus('streaming');
              window.setTimeout(() => forceReconnectRef.current(), 50);
            }
            return;
          }
          // Claude Code writes this once per unknown model id per process.
          // xAI/Z.ai ids are off its registry by design; the turn still runs.
          if (typeof msg.message === 'string' && /^\s*\[claude-code:unrecognized_model\]/.test(msg.message)) {
            console.warn('[chat] ignored unrecognized_model warning');
            return;
          }
          const outboundFailureId = typeof msg.clientMsgId === 'string'
            ? msg.clientMsgId
            : sentOutboundRef.current?.clientMsgId;
          if (
            outboundFailureId
            && rejectOutbound(
              outboundFailureId,
              msg.message || 'The message was not delivered.',
              msg.busy === true,
            )
          ) return;
          // Surface errors when a turn is in flight OR when the user just
          // sent and we're still waiting on the server to flip to
          // 'streaming' (covers respawn failures after an idle CLI close).
          // Otherwise it's idle CLI chatter and the server has already
          // filtered the worst of it; just log.
          const inFlight =
            statusRef.current === 'streaming' ||
            statusRef.current === 'connecting' ||
            pendingSendRef.current;
          if (inFlight) {
            if (msg.code === 'STEER_REJECTED' && (!msg.clientMsgId || queuedSteerRef.current.has(msg.clientMsgId))) {
              if (typeof msg.clientMsgId === 'string') queuedSteerRef.current.delete(msg.clientMsgId);
              else queuedSteerRef.current = new Set();
              if (typeof msg.clientMsgId === 'string') {
                setBlocks((prev) => prev.map((block) => (
                  block.kind === 'user' && block.clientMsgId === msg.clientMsgId
                    ? { ...block, deliveryState: 'failed' as const }
                    : block
                )));
              }
              pendingSendRef.current = queuedSteerRef.current.size > 0;
              if (queuedSteerRef.current.size > 0) {
                setError(msg.message);
                setStatus('streaming');
                return;
              }
            }
            pendingSendRef.current = false;
            setError(msg.message);
          } else {
            console.warn('[chat] suppressed idle error:', msg.message);
          }
        }
      };
      ws.onclose = () => {
        if (!isCurrentConnection()) return;
        socketReadyRef.current = false;
        sentOutboundRef.current = null;
        // Only the socket currently owned by wsRef drives reconnects. An
        // orphan closing later must not open yet another connection.
        if (wsRef.current && wsRef.current !== ws) return;
        // Queued guidance is owned by the server after acceptance and survives
        // this transport. Do not falsely mark it canceled when a phone sleeps
        // or the user visits another teammate.
        const keepStreaming =
          (statusRef.current === 'streaming' || pendingSendRef.current) &&
          reconnectAttemptRef.current < 3;
        if (!keepStreaming) {
          pendingSendRef.current = false;
          setStatus('closed');
          clearTurnStarted();
        }
        const attempt = Math.min(reconnectAttemptRef.current, 3);
        const delay = Math.min(1000 * 2 ** attempt, 8000);
        reconnectAttemptRef.current += 1;
        // Replace, never stack: overwriting the ref without clearing left the
        // previous timer live, so two connects raced and one socket leaked.
        if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = window.setTimeout(connect, delay);
      };
      ws.onerror = () => {
        if (!isCurrentConnection()) return;
        // Browsers fire onerror on every abnormal close (process restart,
        // proxy blip). onclose already reconnects. A red pill here makes a
        // Grok tool/think pause look like a dead line.
        if (
          statusRef.current !== 'streaming' &&
          !pendingSendRef.current &&
          reconnectAttemptRef.current >= 3
        ) {
          setError('the line went quiet, reconnecting…');
        } else {
          console.warn('[chat] socket error; reconnecting');
        }
      };
    };

    // Replay guard: the server's hello replay includes the PREVIOUS turn's
    // control messages (turnStart/turnEnd/errors). Processing them as live
    // flips status and kills the typing indicator mid-send. Handshake-scoped:
    // reset on every hello (new socket AND same-socket reconcile re-hello),
    // and the `ready` message that follows each replay carries the true busy
    // state. A legit live turnStart/turnEnd dropped mid-handshake is re-taught
    // by that ready (busy flag) and its queued-outbound flush.
    let socketReady = false;

    // Backgrounded tabs get their WebSocket throttled or silently killed by
    // the browser, and the setTimeout-based reconnect can be deferred for
    // minutes. When the tab comes back we force a reconcile: if the socket
    // is still open, re-send hello so the server replays anything missed
    // via sinceSeq; otherwise reconnect immediately.
    const reconcileNow = () => {
      if (!isCurrentConnection()) return;
      const live = wsRef.current;
      // A CONNECTING handshake must not be killed on window focus (clicking
      // from another app back into TARDIS). That loop is how messages
      // never reached hello, so every agent looked dead.
      // CLOSING counts too: its onclose is about to run the reconnect, and
      // opening one here would leave the closing socket orphaned.
      if (
        live
        && (live.readyState === WebSocket.CONNECTING || live.readyState === WebSocket.CLOSING)
      ) return;
      if (live && live.readyState === WebSocket.OPEN) {
        try {
          // Ignore replayed control events locally, but keep transport-ready:
          // the server serializes any send behind this re-hello's completion.
          socketReady = false;
          live.send(JSON.stringify({
            type: 'hello',
            cli,
            repo: repo.path,
            chatId,
            sinceSeq: lastSeqRef.current,
            resetAt: cacheResetAtRef.current,
            model: modelRef.current,
            effort: effortRef.current,
            ...selectionIntent(),
            visible: document.visibilityState === 'visible',
          }));
          return;
        } catch {
          // fall through to a forced reconnect below
        }
      }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      reconnectAttemptRef.current = 0;
      // Detach the stale socket so its pending onopen/onclose can't fire a
      // duplicate hello or schedule a competing reconnect timer alongside
      // the new connection we're about to open.
      detachSocket(wsRef.current);
      wsRef.current = null;
      connect();
    };
    // Restoring a window fires visibilitychange, focus and often pageshow in
    // the same tick, and each one used to send its own hello. Coalesce them.
    let reconcileTimer: number | null = null;
    const reconcile = () => {
      if (!isCurrentConnection()) return;
      if (reconcileTimer !== null) return;
      reconcileTimer = window.setTimeout(() => {
        reconcileTimer = null;
        reconcileNow();
      }, 150);
    };
    const onVisibility = () => {
      // Tell the server whether this tab counts as watching (unread badges
      // must not clear for backgrounded tabs, on any device).
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'watch', visible: document.visibilityState === 'visible' })); } catch { /* socket racing close */ }
      }
      if (document.visibilityState === 'visible') reconcile();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', reconcile);
    window.addEventListener('online', reconcile);
    window.addEventListener('pageshow', reconcile);

    // Cross-browser-tab sync: blocks + cursor are one atomic envelope, so a
    // tab can adopt another tab's settled snapshot without mixing replay states.
    // Any older events still queued on this socket are discarded by the seq
    // guard in onmessage above.
    const snapshotStorageKey = blocksStorageKey(cli, repo.path, chatId);
    const onStorage = (e: StorageEvent) => {
      if (!isCurrentConnection()) return;
      if (e.key !== snapshotStorageKey || e.newValue == null) return;
      const snapshot = parseStoredSnapshot(e.newValue);
      if (!snapshot || snapshot.resetAt < cacheResetAtRef.current) return;
      const newerReset = snapshot.resetAt > cacheResetAtRef.current;
      if (!newerReset && snapshot.seq <= lastSeqRef.current) return;
      if (!newerReset && (statusRef.current === 'streaming' || pendingSendRef.current)) return;
      if (newerReset) {
        cancelOutbound(conversationKey(cli, repo.path, chatId));
        sentOutboundRef.current = null;
        settleInitialMessage();
        queuedSteerRef.current = new Set();
        pendingSendRef.current = false;
        socketReadyRef.current = false;
        cacheResetAtRef.current = snapshot.resetAt;
        setError(null);
        setStatus('connecting');
      }
      setBlocks(restoreBlocksWithUniqueIds(snapshot.blocks));
      lastSeqRef.current = snapshot.seq;
      setAppliedSeq(snapshot.seq);
      if (newerReset) window.setTimeout(() => forceReconnectRef.current(), 0);
    };
    window.addEventListener('storage', onStorage);

    forceReconnectRef.current = () => {
      if (!isCurrentConnection()) return;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      reconnectAttemptRef.current = 0;
      // Same trap as reconcile: a CONNECTING/CLOSING socket whose handlers
      // are still attached will fire onopen/onclose against the new
      // connection's state. Detach handlers before replacing.
      detachSocket(wsRef.current);
      wsRef.current = null;
      connect();
    };

    // Stream watchdog: if a turn is streaming but the socket has been silent
    // for STREAM_SILENCE_MS, the connection is almost certainly stale (the
    // server already emitted turnEnd, it just never arrived). Force a fresh WS
    // so bindSession replies with a fresh ready{busy:false} (or replays the
    // missed turnEnd) and the "tending" dots clear instead of hanging forever.
    // 90s (not 45s): Grok/Claude tool calls, MCP, and thinking can sit quiet
    // well past 45s. Server `working` keepalives should refresh lastMessageAt
    // well before this; the extra room covers keepalive loss during compaction.
    const STREAM_SILENCE_MS = 90_000;
    const COMPACT_SILENCE_MS = 180_000;
    const WATCHDOG_TICK_MS = 5_000;
    const watchdog = window.setInterval(() => {
      if (!isCurrentConnection()) return;
      if (statusRef.current !== 'streaming') return;
      const silenceMs = compactingRef.current ? COMPACT_SILENCE_MS : STREAM_SILENCE_MS;
      if (Date.now() - lastMessageAtRef.current < silenceMs) return;
      // eslint-disable-next-line no-console
      console.warn(`[useChat] stream watchdog: silent ${silenceMs}ms, forcing reconnect`);
      lastMessageAtRef.current = Date.now();
      forceReconnectRef.current();
    }, WATCHDOG_TICK_MS);

    connect();

    return () => {
      teardownRef.current = true;
      socketReadyRef.current = false;
      sentOutboundRef.current = null;
      queuedSteerRef.current = new Set();
      pendingSendRef.current = false;
      forceReconnectRef.current = () => {};
      window.clearInterval(watchdog);
      if (reconcileTimer !== null) {
        clearTimeout(reconcileTimer);
        reconcileTimer = null;
      }
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', reconcile);
      window.removeEventListener('online', reconcile);
      window.removeEventListener('pageshow', reconcile);
      window.removeEventListener('storage', onStorage);
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [enabled, repo?.path, cli, chatId]);

  const send = (
    text: string,
    images?: ChatSendImage[],
  ) => {
    if (!repo) {
      setError('Sam is not on the line. Please wait a moment.');
      return;
    }
    const clientMsgId = `cm-${Date.now().toString(36)}-${nextId++}`;
    setBlocks((prev) => [
      ...prev,
      { kind: 'user', id: id(), text, images: imagePreviews(images), imageCount: images?.length, clientMsgId, ts: Date.now() },
    ]);
    const key = conversationKey(cli, repo.path, chatId);
    const inFlight = pendingSendRef.current || statusRef.current === 'streaming';
    enqueueOutbound(key, { text, images, clientMsgId });
    pendingSendRef.current = true;
    setError(null);
    if (!inFlight) markTurnStarted(Date.now(), true);
    lastMessageAtRef.current = Date.now();
    compactingRef.current = false;
    setStatus('streaming');
    const ws = wsRef.current;
    if (
      !inFlight
      && socketReadyRef.current
      && ws
      && ws.readyState === WebSocket.OPEN
      && (statusRef.current === 'ready' || statusRef.current === 'closed')
    ) {
      // 'closed' means the engine idled out, not that the socket is gone: the
      // server respawns on demand. Waiting for a 'ready' that only arrives on
      // the next reconnect is how a typed message sat in the queue unsent.
      flushOutbound();
    }
  };

  const freshStart = () => {
    if (!repo) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setError('Sam is not on the line. Please wait a moment.');
      return;
    }
    ws.send(JSON.stringify({
      type: 'freshStart',
      cli,
      repo: repo.path,
      chatId,
      model: modelRef.current,
      effort: effortRef.current,
      ...selectionIntent(),
    }));
  };

  const stop = () => {
    if (!repo) return;
    const key = conversationKey(cli, repo.path, chatId);
    const canceled = cancelOutbound(key);
    const canceledSteers = cancelPendingSteers(key);
    const canceledIds = new Set([
      ...canceled.map((item) => item.clientMsgId),
      ...canceledSteers.map((item) => item.clientMsgId),
    ]);
    if (initialClientMsgIdRef.current) canceledIds.add(initialClientMsgIdRef.current);
    if (canceledIds.size > 0 || queuedSteerRef.current.size > 0) {
      setBlocks((prev) => prev.map((block) => (
        block.kind === 'user'
        && (block.deliveryState === 'queued' || Boolean(block.clientMsgId && canceledIds.has(block.clientMsgId)))
          ? { ...block, deliveryState: 'failed' as const }
          : block
      )));
    }
    sentOutboundRef.current = null;
    settleInitialMessage(initialClientMsgIdRef.current ?? undefined);
    queuedSteerRef.current = new Set();
    pendingSendRef.current = false;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      clearTurnStarted();
      setStatus('ready');
      return;
    }
    ws.send(JSON.stringify({ type: 'stop', cli: serverCliRef.current, repo: repo.path, chatId }));
  };

  /** Queue guidance through the server's non-destructive steer path. Claude-
   *  family engines use native streamed steering after the current tool/safe
   *  point; Codex/Banana receive it after the current turn. Only Stop kills. */
  const steer = (
    text: string,
    images?: ChatSendImage[],
  ) => {
    if (!repo) return;
    const ws = wsRef.current;
    const key = conversationKey(cli, repo.path, chatId);
    const waiting = (outboundQueue.get(key)?.length ?? 0) > 0
      || !socketReadyRef.current
      || !ws
      || ws.readyState !== WebSocket.OPEN;
    if (waiting) {
      send(text, images);
      return;
    }
    const clientMsgId = `cm-${Date.now().toString(36)}-${nextId++}`;
    // Show the user's words immediately, but label them honestly as queued
    // until the runner's durable _user_echo proves the model received them.
    // The echo dedupes by clientMsgId and clears deliveryState.
    setBlocks((prev) => [
      ...prev,
      {
        kind: 'user',
        id: id(),
        text,
        images: imagePreviews(images),
        imageCount: images?.length,
        clientMsgId,
        deliveryState: 'queued',
        ts: Date.now(),
      },
    ]);
    queuedSteerRef.current.add(clientMsgId);
    pendingSendRef.current = true;
    rememberPendingSteer(key, { text, images, clientMsgId, ts: Date.now() });
    setError(null);
    ws.send(JSON.stringify({ type: 'steer', cli, repo: repo.path, chatId, text, images: payloadImages(images), clientMsgId, model: modelRef.current, effort: effortRef.current, ...selectionIntent() }));
    lastMessageAtRef.current = Date.now();
    compactingRef.current = false;
    setStatus('streaming');
  };

  const reconnect = () => forceReconnectRef.current();

  // Automation turns (routines) stay silent unless the turn produced a real
  // deliverable message. Persistence stores this same visible projection.
  const visibleBlocks = useMemo(() => filterAutomationNoise(blocks), [blocks]);
  const automationBusy = useMemo(() => automationTurnInFlight(blocks), [blocks]);

  return {
    chatId,
    blocks: visibleBlocks, status, error, send, steer, freshStart, stop, reconnect, usage, serverBrain, automationBusy,
    turnStartedAt,
    lastActivityRef: lastMessageAtRef, turnStartRef, compactingRef,
  };
}
