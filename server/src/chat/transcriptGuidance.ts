/** A person's message is answered in visible text before the next tool call.
 * Shared with the per-turn guidance, the only place Codex (no system prompt of
 * ours) receives it. */
export const REPLY_FIRST_RULE = 'When the person asks a question, gives new information, or changes direction, the answer goes out as visible text before your next tool call. Thinking is never where a reply lives: they cannot see it. A plain task with nothing to answer needs no acknowledgement and no "on it" opener, but never run more than about a minute of tool calls with nothing visible on screen.';

