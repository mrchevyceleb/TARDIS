import type { PersistedEvent } from './event-log-store.ts';

/** A cached transcript may need no replay, but its context meter still needs
 * the latest real API call. Result usage is cumulative, not context size. */
export function latestAgyContextUsage(events: readonly PersistedEvent[]) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const entry = events[i];
    if (entry.lane === 'bg') continue;
    if (entry.eng && entry.eng !== 'agy') return null;
    const frame = entry.ev.type === 'event' ? entry.ev.event : null;
    if (entry.eng !== 'agy' || frame?.type !== 'stream_event' || frame.parent_tool_use_id) continue;
    const delta = frame.event;
    if (delta?.type !== 'message_delta' || !delta.usage) continue;
    const usage = delta.usage as Record<string, number | undefined>;
    // Tool-only frames carry zeroes; they do not replace the last model call.
    if ((usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) <= 0) continue;
    return { model: entry.mdl, usage };
  }
  return null;
}
