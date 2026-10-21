import type { SeqEvent } from './runner.ts';
import { extractVisibleTurns } from './threadWindow.ts';
import { isBackgroundChatId } from './threadKey.ts';
import { eventInner, isNoopToken } from './routineNoise.ts';

export type LiveActivity = { text: string; source: 'update' | 'task' | 'tool'; at: number; detail?: string };

/** Only visible speech, never thinking, tool arguments, output or system prompts. */
function activityDetail(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '').replace(/```[\s\S]*$/, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/^[#*> \-]+/gm, '').replace(/[`*_]/g, '').replace(/[ \t]+/g, ' ').trim().replace(/\.{2,}$/, '…');
}

function shortLine(text: string): string {
  const chars = Array.from(activityDetail(text).split(/\n\s*\n/).filter((s) => s.trim()).at(-1)?.replace(/\s+/g, ' ') ?? '');
  return chars.length > 420 ? `${chars.slice(0, 417).join('')}…` : chars.join('');
}

function toolLabel(name: string): string {
  name = name.split('__').at(-1) ?? name;
  if (/todo|plan/i.test(name)) return 'Planning next steps';
  if (/browser|playwright|computer|chrome/i.test(name)) return 'Working in the browser';
  if (/sql|database/i.test(name)) return 'Working with data';
  if (/edit|write|patch/i.test(name)) return 'Editing files';
  if (/read|search|grep|glob|find/i.test(name)) return 'Reading and researching';
  if (/bash|shell|exec|terminal/i.test(name)) return 'Running a command';
  if (/team_message|channel_post/i.test(name)) return 'Coordinating with the team';
  return 'Using a tool';
}

export function liveActivityFromEvents(events: readonly SeqEvent[], since: number, chatId: string): LiveActivity | undefined {
  // Home and background processes share a transcript. A busy process must
  // never borrow its sibling's work, or text from the previous turn.
  const current = events.filter((e) => e.at !== undefined && e.at >= since && Boolean(e.lane === 'bg') === isBackgroundChatId(chatId));
  const turns = extractVisibleTurns(current, Number.POSITIVE_INFINITY);
  const update = turns.filter((t) => t.role === 'assistant' && !isNoopToken(t.text)).at(-1);
  const task = turns.filter((t) => t.role === 'user').at(-1);
  // Receiving a request is not evidence of doing the requested work. Until
  // the agent reports progress, describe the message handling itself.
  const taskEvent = task ? eventInner(current.find((e) => e.seq === task.seq)) : undefined;
  const sender = typeof taskEvent?.from === 'string' && !taskEvent.from.startsWith('##') ? shortLine(taskEvent.from) : undefined;
  const context = (update && shortLine(update.text)) || (task ? sender ? `Reading a message from ${sender}` : taskEvent?.type === '_user_echo' ? 'Reading your request' : 'Reading a team message' : '');
  const detail = (update && activityDetail(update.text)) || context;
  const tools = new Map<string, { label: string; seq: number; at: number }>();
  for (const e of current) {
    const inner = eventInner(e);
    const stream = inner?.type === 'stream_event' ? inner.event as Record<string, any> | undefined : undefined;
    const content = (inner?.message as { content?: unknown } | undefined)?.content;
    const blocks: Record<string, any>[] = Array.isArray(content) ? content.filter((b) => b && typeof b === 'object') : [];
    const started = stream?.type === 'content_block_start' ? [stream.content_block] : inner?.type === 'assistant' ? blocks : [];
    for (const block of started) {
      if (block?.type === 'tool_use' && typeof block.name === 'string') tools.set(block.id ?? `seq-${e.seq}`, { label: toolLabel(block.name), seq: e.seq, at: e.at! });
    }
    if (inner?.type === 'user') {
      for (const block of blocks) if (block.type === 'tool_result') tools.delete(block.tool_use_id);
    }
  }
  const tool = [...tools.values()].at(-1);
  if (tool && tool.seq >= (update?.seq ?? 0)) {
    return { text: context ? `${tool.label} · ${context}` : tool.label, source: 'tool', at: tool.at, detail: detail ? `${tool.label} · ${detail}` : tool.label };
  }
  if (!context) return undefined;
  const seq = update?.seq ?? task?.seq;
  // A visible turn can span multiple streamed/provider rounds. Its seq points
  // to the first text, so freshness must use the latest visible text event.
  const latestText = update ? current.findLast((e) => {
    const inner = eventInner(e);
    if (inner?.type === '_voice_transcript') return inner.role === 'assistant';
    if (inner?.type === 'stream_event') {
      const stream = inner.event as { type?: string; delta?: { type?: string } } | undefined;
      return stream?.type === 'content_block_delta' && stream.delta?.type === 'text_delta';
    }
    if (inner?.type !== 'assistant') return false;
    const content = (inner.message as { content?: unknown } | undefined)?.content;
    return typeof content === 'string' ? Boolean(content.trim()) : Array.isArray(content) && content.some((block) => block?.type === 'text' && block.text?.trim());
  }) : undefined;
  return { text: context, source: update ? 'update' : 'task', at: latestText?.at ?? current.find((e) => e.seq === seq)?.at ?? since, detail };
}

/** Synchronous replay of the existing bounded memory buffer. No disk scan,
 * viewer count, activity-clock change, process start or persistent listener. */
export function sessionLiveActivity(session: {
  chatId: string;
  isBusy(): boolean;
  activeTurnStartedAt(): number | null;
  subscribe(fn: (e: SeqEvent) => void, sinceSeq: number, countSubscriber: boolean): () => void;
}): LiveActivity | undefined {
  const since = session.activeTurnStartedAt();
  if (!session.isBusy() || since === null) return undefined;
  try {
    const events: SeqEvent[] = [];
    const unsubscribe = session.subscribe((e) => events.push(e), 0, false);
    unsubscribe();
    return liveActivityFromEvents(events, since, session.chatId);
  } catch {
    // Optional display enrichment must never affect liveness or routing.
    return undefined;
  }
}
