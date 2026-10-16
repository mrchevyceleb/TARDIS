// reply-quote: the one shared shape of a reply-to-message target (card-cbb4af).
//
// One place decides what a safe reply target looks like and what the agent
// sees, so the steer path, the send path, the channel bundle, and every
// engine echo can never disagree (review 1, P1 2 and P2 8). The stored and
// echoed event carries the raw text plus `replyTo` as its own field; only the
// engine prompt gets the quote, and when the text is a slash command the
// quote goes after it so the command head still parses.

export interface ReplyToRef {
  from: string;
  snippet: string;
}

/** Anything in, a safe target out - or null when it is not one. */
export function normalizeReplyTo(raw: unknown): ReplyToRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const from = (raw as { from?: unknown }).from;
  const snippet = (raw as { snippet?: unknown }).snippet;
  if (typeof from !== 'string' || !from.trim()) return null;
  return {
    from: clipCodePoints(from.trim(), 80),
    snippet: typeof snippet === 'string' ? clipSnippet(snippet) : '',
  };
}

/** Slice by code points, never UTF-16 units: a surrogate pair split at the
 *  boundary leaves a lone high surrogate that Anthropic rejects with a 400 on
 *  every later turn of the lane (verify P1 9), and a trailing lone surrogate
 *  is stripped before it can reach any engine. */
function clipCodePoints(value: string, max: number): string {
  return Array.from(value).slice(0, max).join('').replace(/[\uD800-\uDBFF]$/, '');
}

function clipSnippet(snippet: string): string {
  return clipCodePoints(snippet.replace(/\s+/g, ' ').trim(), 400);
}

/** The quote block the agent sees. Empty string when there is no target. */
export function formatReplyQuote(replyTo: unknown): string {
  const ref = normalizeReplyTo(replyTo);
  if (!ref) return '';
  return `Replying to ${ref.from}${ref.snippet ? `:\n"${ref.snippet}"` : ''}\n\n`;
}

/**
 * The engine text: the quote goes in front, except a slash command keeps its
 * head — the quote follows it instead, so `/skill …` still parses as a
 * command (review 1, P1 3).
 */
export function withReplyQuote(text: string, replyTo: unknown): string {
  const quote = formatReplyQuote(replyTo);
  if (!quote) return text;
  if (text.trimStart().startsWith('/')) return `${text}\n\n${quote.trimEnd()}`;
  return `${quote}${text}`;
}
