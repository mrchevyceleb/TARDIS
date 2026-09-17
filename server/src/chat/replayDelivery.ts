// History is transcript data, not a command to close/restart the current
// transport. In particular, -1 means no replay; clamping it to zero replays
// every historical close/error while admitting a new user message.
export function subscriptionReplayCursor(requested: number, repairedThrough: number): number {
  return requested < 0 ? -1 : Math.max(requested, repairedThrough);
}

// A replayed tool_result exists only to fill in a tool card that already
// rendered. The transcript shows its first line capped at 80 characters and
// ignores non-text parts entirely, so shipping the raw payload costs a mobile
// client megabytes to render a few hundred characters. Historical tool output
// above this budget is therefore trimmed on the way out. Live frames never
// pass through here, so an in-flight tool result still arrives whole.
const HISTORICAL_TOOL_RESULT_BUDGET = 1000;

/** Trim a historical tool_result payload without changing what renders.
 *  Returns the original reference when nothing had to be dropped, so an
 *  untouched frame is not needlessly copied. */
function trimHistoricalToolResult(item: Record<string, any>): Record<string, any> {
  const content = item.content;
  if (typeof content === 'string') {
    if (content.length <= HISTORICAL_TOOL_RESULT_BUDGET) return item;
    return { ...item, content: content.slice(0, HISTORICAL_TOOL_RESULT_BUDGET) };
  }
  if (!Array.isArray(content)) return item;
  // Keep text parts in order until the budget runs out. The client joins them
  // and reads the first line, so order matters and the tail never renders.
  let budget = HISTORICAL_TOOL_RESULT_BUDGET;
  let changed = content.length > 0 && content.some((part) => part?.type !== 'text');
  const parts: unknown[] = [];
  for (const part of content) {
    if (part?.type !== 'text' || typeof part.text !== 'string') continue;
    if (budget <= 0) { changed = true; continue; }
    if (part.text.length <= budget) {
      parts.push(part);
      budget -= part.text.length;
      continue;
    }
    parts.push({ ...part, text: part.text.slice(0, budget) });
    budget = 0;
    changed = true;
  }
  if (!changed) return item;
  return { ...item, content: parts };
}

/** Shrink replayed tool output. Copies only the containers it rewrites: the
 *  durable log array is shared in memory and must never be mutated. */
function trimHistoricalToolOutput(event: Record<string, any>): Record<string, any> {
  const inner = event.event;
  if (!inner || typeof inner !== 'object' || inner.type !== 'user') return event;
  const content = inner.message?.content;
  if (!Array.isArray(content)) return event;
  let changed = false;
  const trimmed = content.map((item: any) => {
    if (item?.type !== 'tool_result') return item;
    const next = trimHistoricalToolResult(item);
    if (next !== item) changed = true;
    return next;
  });
  if (!changed) return event;
  return { ...event, event: { ...inner, message: { ...inner.message, content: trimmed } } };
}

// A tool call's arguments stream in as hundreds of one-or-two-character
// `input_json_delta` frames so the live card can type them out. On a
// forever-thread that is the single largest cost of attaching: tens of
// thousands of frames and tens of megabytes to redraw cards the transcript
// renders as three keys clipped to sixty characters each. Replay therefore
// collapses each run into one frame carrying an equivalent compact object.
const HISTORICAL_TOOL_ARGS_KEYS = 3;
// One char over the client's 60-char display clip, so every rendered value is
// byte-identical whether it was compacted or not.
const HISTORICAL_TOOL_ARGS_VALUE_CHARS = 80;
const HISTORICAL_TOOL_ARGS_FALLBACK_CHARS = 200;

function toolArgsDeltaIndex(ev: unknown): number | null {
  const event = (ev as Record<string, any> | null)?.event;
  if (!event || event.type !== 'stream_event') return null;
  const inner = event.event;
  if (!inner || inner.type !== 'content_block_delta') return null;
  if (inner.delta?.type !== 'input_json_delta') return null;
  if (typeof inner.delta.partial_json !== 'string') return null;
  return typeof inner.index === 'number' ? inner.index : null;
}

/** Rewrite accumulated tool arguments so the card renders the same text from a
 *  fraction of the bytes. The client shows the first three keys with each
 *  value clipped, so keeping exactly that much is not a visible loss. */
function compactToolArgs(raw: string): string {
  if (raw.length <= HISTORICAL_TOOL_ARGS_FALLBACK_CHARS) return raw;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return raw.slice(0, HISTORICAL_TOOL_ARGS_FALLBACK_CHARS);
    }
    const compact: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed).slice(0, HISTORICAL_TOOL_ARGS_KEYS)) {
      // The client stringifies non-strings before clipping, so pre-stringifying
      // here keeps the rendered characters identical.
      const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
      compact[key] = text.slice(0, HISTORICAL_TOOL_ARGS_VALUE_CHARS);
    }
    return JSON.stringify(compact);
  } catch {
    // A malformed or truncated arg stream never parsed for the client either;
    // it falls back to a clipped raw string, so clipping here matches.
    return raw.slice(0, HISTORICAL_TOOL_ARGS_FALLBACK_CHARS);
  }
}

/** Collapse each run of streamed tool-argument deltas into a single frame.
 *  Frames must be ascending by seq. Only history is collapsed: anything above
 *  `historyThrough` is still streaming to a live card. */
export function collapseHistoricalToolArgs<T extends { seq: number; ev: unknown }>(
  frames: T[],
  historyThrough: number,
): T[] {
  let runIndex: number | null = null;
  let runFrames: T[] = [];
  const out: T[] = [];
  let changed = false;

  const flush = () => {
    if (runFrames.length === 0) return;
    const last = runFrames[runFrames.length - 1];
    if (runFrames.length === 1) {
      // A single delta is already one frame; only its payload may be oversized.
      const inner = (last.ev as any).event.event;
      const compact = compactToolArgs(inner.delta.partial_json);
      if (compact === inner.delta.partial_json) out.push(last);
      else {
        changed = true;
        out.push(rewriteArgsFrame(last, compact));
      }
    } else {
      changed = true;
      // Emit at the last seq of the run so the collapsed frame still lands
      // between this block's content_block_start and content_block_stop.
      out.push(rewriteArgsFrame(last, compactToolArgs(runFrames.map(
        (f) => (f.ev as any).event.event.delta.partial_json,
      ).join(''))));
    }
    runIndex = null;
    runFrames = [];
  };

  for (const frame of frames) {
    const index = frame.seq <= historyThrough ? toolArgsDeltaIndex(frame.ev) : null;
    if (index === null) {
      flush();
      out.push(frame);
      continue;
    }
    if (runIndex !== null && index !== runIndex) flush();
    runIndex = index;
    runFrames.push(frame);
  }
  flush();
  return changed ? out : frames;
}

function rewriteArgsFrame<T extends { seq: number; ev: unknown }>(frame: T, partialJson: string): T {
  const ev = frame.ev as Record<string, any>;
  const event = ev.event;
  const inner = event.event;
  return {
    ...frame,
    ev: { ...ev, event: { ...event, event: { ...inner, delta: { ...inner.delta, partial_json: partialJson } } } },
  };
}

// Attaching a browser should cost one screen of history, not the whole durable
// log. A forever-thread reaches tens of thousands of events, and replay pushes
// one frame per event, so a cold attach on a phone spends minutes rendering
// history nobody scrolled back to. The log on disk stays authoritative and
// untrimmed; these bounds only limit what a single attach streams.
// The byte budget is the real protection on a phone; the event cap only stops
// a pathological thread of tiny frames from costing thousands of renders.
// Measured against real forever-threads, bytes bind first above ~4000 events,
// so raising the count cap past that buys nothing.
export const REPLAY_MAX_EVENTS = 4000;
export const REPLAY_MAX_BYTES = 1_500_000;

/** Keep the newest slice of a replay. Frames must be ascending by seq.
 *  Anything above `historyThrough` is live rather than history and is always
 *  kept: those are the events this socket has not seen yet. */
export function clampReplayWindow<T extends { seq: number; ev: unknown }>(
  frames: T[],
  historyThrough: number,
): T[] {
  let events = 0;
  let bytes = 0;
  // Walk back from the newest so the scan stops at the budget instead of
  // measuring a 40MB log we are about to discard anyway.
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const frame = frames[i];
    if (frame.seq > historyThrough) continue;
    events += 1;
    bytes += JSON.stringify(frame.ev)?.length ?? 0;
    if (events > REPLAY_MAX_EVENTS || bytes > REPLAY_MAX_BYTES) return frames.slice(i + 1);
  }
  return frames;
}

export function historicalDelivery<T extends { seq: number; ev: unknown }>(frame: T): T | null {
  const event = frame.ev as Record<string, any> | null;
  if (!event || typeof event !== 'object') return frame;
  if (['closed', 'turnStart', 'turnEnd'].includes(event.type)) return null;
  if (event.type === 'event') {
    const slim = trimHistoricalToolOutput(event);
    return slim === event ? frame : { ...frame, ev: slim };
  }
  if (event.type !== 'error') return frame;
  // Claude-family failures already have a durable _terminal_error event.
  // Older Banana turns stored only a transport error; retain that as a
  // transcript notice without rejecting the current outbound message.
  if (typeof event.code === 'string' && event.code.startsWith('BANANA_') && typeof event.message === 'string') {
    return { ...frame, ev: { type: 'event', event: {
      type: '_terminal_error', message: event.message, code: event.code, retryable: event.retryable === true,
    } } };
  }
  return null;
}
