/** Classifiers for scheduled-routine noise in durable chat event logs.
 *  Used by unread counts, history previews, and team-recent so quiet
 *  automations never look like a teammate waiting on the user. */

import { isSyntheticApiErrorEvent } from './providerErrors.ts';

const GEAR = '\u2699';
const MODEL_EOS_TOKENS = new Set(['<|eos|>', '<|endoftext|>', '<|end_of_text|>', '<|im_end|>']);

export function eventInner(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const wrapped = (o.ev && typeof o.ev === 'object' ? o.ev : o) as Record<string, unknown>;
  if (wrapped.event && typeof wrapped.event === 'object') {
    return wrapped.event as Record<string, unknown>;
  }
  return wrapped;
}

export function eventType(raw: unknown): string | undefined {
  const inner = eventInner(raw);
  const t = inner?.type;
  return typeof t === 'string' ? t : undefined;
}

/** Every text payload on the event (assistant content can be an array). */
export function eventTexts(raw: unknown): string[] {
  // Claude Code emits upstream failures as assistant-shaped text. It is
  // transport output, not a reply, and must not become a preview or unread.
  if (isSyntheticApiErrorEvent(raw)) return [];
  const inner = eventInner(raw);
  if (!inner) return [];
  if (typeof inner.text === 'string') return inner.text ? [inner.text] : [];
  const msg = inner.message;
  if (msg && typeof msg === 'object') {
    const content = (msg as { content?: unknown }).content;
    if (typeof content === 'string') return content ? [content] : [];
    if (Array.isArray(content)) {
      const out: string[] = [];
      for (const c of content) {
        if (c && typeof c === 'object' && (c as { type?: string }).type === 'text' && typeof (c as { text?: string }).text === 'string') {
          out.push((c as { text: string }).text);
        }
      }
      return out;
    }
  }
  return [];
}

export function isRoutinePromptText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return /^\[routine:/i.test(t) || /\(Scheduled automation —/i.test(t);
}

function normalizeReply(text: string): string {
  return text.trim().replace(/[*`#]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Exact idle token. "NO_UPDATE — failed to reach X" must still show. */
export function isExactNoUpdate(text: string): boolean {
  return /^no_update[.!?]*$/.test(normalizeReply(text));
}

/** Provider end-of-sequence markers are wire protocol, never prose. Some
 *  OpenAI-compatible models serialize an intentionally empty routine reply as
 *  one of these literals instead of returning an empty content block. */
export function isModelEosToken(text: string): boolean {
  return MODEL_EOS_TOKENS.has(text.trim());
}

/** Negated failure phrase ("no jobs failed", "nothing failed", "zero
 *  errors"): the negator must sit within 3 words of the failure word —
 *  "No updates because the API failed" is NOT negated. */
const NEGATED_FAILURE = /\b(?:no|nothing|never|zero|without)\s+(?:[\w-]+\s+){0,3}(?:failed|failures?|errors?|broken|timed out|timeouts?)\b/;
const STATUS_QUERY = /\b(?:check(?:ing)?|looking|searching|querying|verifying|inspecting|pulling|finding)\b[^.;:!\n]{0,100}(?:(?:\b(?:whether|if|for|any)\b[^.;:!\n]{0,100}\b(?:failed|failures?|errors?|broken|timed out|timeouts?|posted|shipped|deployed|sent|published|refreshed)\b)|(?:\b(?:failed|failures?|errors?|broken|timeouts?|posted|shipped|deployed|sent|published|refreshed)\s+(?:rows?|items?|jobs?|records?|updates?)\b))/;
const ROUTINE_PROGRESS = /(?:^|[.!?]\s+)(?:i(?:'|’)ll|i will|i(?:'|’)m|i am)?\s*(?:check(?:ing)?|pulling|looking|searching|querying|verifying|inspecting|finding|hunting|posting|sending|updating|bumping)\b/;
const NEGATED_DELIVERY = /\b(?:no|nothing|zero|without|not|never|previously)\b[^.;!\n]{0,40}\b(?:posted|shipped|deployed|sent|published|refreshed)\b/;

/** Failure/delivery signals that always beat a quiet pattern. Negation- and
 *  context-aware: "no jobs failed" and "previously posted items are
 *  unchanged" are quiet, while "an API error" and "posted the summary" are not. */
export function hasFailureSignal(text: string): boolean {
  const lower = normalizeReply(text);
  if (/\b(needs you|needs matt|needs attention|action needed)\b/.test(lower)) return true;
  // Evaluate outcomes clause-by-clause. A prospective first sentence
  // ("Checking for failed jobs") must not hide a completed second sentence
  // ("Job 42 failed").
  const clauses = lower.split(/[.;!?\n]+/).map((part) => part.trim()).filter(Boolean);
  return clauses.some((clause) => {
    const statusQuery = STATUS_QUERY.test(clause);
    if (/\b(failed|failures?|errors?|broken|timed out|timeouts?)\b/.test(clause)
      && !NEGATED_FAILURE.test(clause)
      && !statusQuery) return true;
    return /\b(posted|shipped|deployed|sent|published|refreshed)\b/.test(clause)
      && !NEGATED_DELIVERY.test(clause)
      && !statusQuery
      && !/\b(posted|shipped|deployed|sent|published|refreshed)\b[^\n]{0,30}\bunchanged\b/.test(clause);
  });
}

/** No-op automation replies: hide these, keep real ship/fail/needs-user text. */
export function isQuietRoutineReply(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  const lower = normalizeReply(t);
  // Failure/delivery signals always win over the quiet patterns below —
  // "Stayed silent because of an API error" must surface, not vanish.
  if (hasFailureSignal(t)) return false;
  if (isExactNoUpdate(t) || isModelEosToken(t)) return true;
  if (ROUTINE_PROGRESS.test(lower) && lower.length < 600) return true;
  if (/^quiet\b/.test(lower)) return true;
  if (/\bstayed silent\b/.test(lower)) return true;
  if (/\bno new shipped rows\b/.test(lower)) return true;
  if (NEGATED_FAILURE.test(lower) && lower.length < 500) return true; // "no jobs failed"
  if (/\b(unchanged|no changes?|no updates?|up to date)\b/.test(lower) && lower.length < 500) return true;
  if (/\b(zero|no) (errors?|failures?|issues?|problems?)\b/.test(lower) && lower.length < 500) return true;
  if (/\bnothing (new|happened)\b/.test(lower) && lower.length < 500) return true;
  return false;
}

/** Last non-quiet text, else the last payload. Trailing NO_UPDATE must not
 *  steal unread / preview from real prose in the same event. */
export function eventText(raw: unknown): string {
  const texts = eventTexts(raw);
  const real = [...texts].reverse().find((t) => t.trim() && !isQuietRoutineReply(t));
  if (real) return real;
  const fallback = texts.length ? texts[texts.length - 1] : '';
  // Exact provider wire tokens are never conversation, even outside routines.
  return isModelEosToken(fallback) ? '' : fallback;
}

export function isAutomationPeerEvent(raw: unknown): boolean {
  if (eventType(raw) !== 'peer_message') return false;
  const inner = eventInner(raw);
  if (!inner) return false;
  const fromRole = typeof inner.fromRole === 'string' ? inner.fromRole : '';
  const from = typeof inner.from === 'string' ? inner.from : '';
  if (fromRole.trim().toLowerCase() === 'automation') return true;
  if (from.trim().startsWith(GEAR)) return true;
  return isRoutinePromptText(eventText(raw));
}

/** Grok/Claude persist tool results as `user` events. Those are not a human
 *  message and must not end an automation turn for unread counting. */
export function isToolResultUserEvent(raw: unknown): boolean {
  if (eventType(raw) !== 'user') return false;
  const inner = eventInner(raw);
  const msg = inner?.message;
  if (!msg || typeof msg !== 'object') return false;
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) return false;
  let sawTool = false;
  for (const item of content) {
    if (!item || typeof item !== 'object') return false;
    const t = (item as { type?: unknown }).type;
    if (t === 'tool_result') {
      sawTool = true;
      continue;
    }
    if (t === 'text' && typeof (item as { text?: unknown }).text === 'string'
      && (item as { text: string }).text.trim()) return false;
    if (t && t !== 'tool_result') return false;
  }
  return sawTool;
}

/** Skip this event when counting unread / picking a sidebar preview. */
export function isRoutineNoiseEvent(raw: unknown, afterAutomation: boolean): boolean {
  const t = eventType(raw);
  if (t === 'peer_message' && isAutomationPeerEvent(raw)) return true;
  const texts = eventTexts(raw);
  if (texts.some((text) => isRoutinePromptText(text))) return true;
  if (t === 'assistant' || t === 'result') {
    const nonempty = texts.map((x) => x.trim()).filter(Boolean);
    const quietAll = nonempty.length === 0 || nonempty.every(isQuietRoutineReply);
    const protocolNoop = nonempty.length > 0
      && nonempty.every((x) => isExactNoUpdate(x) || isModelEosToken(x));
    // Protocol idle tokens (exact NO_UPDATE / EOS) never badge, even if a
    // tool-result `user` event already closed the automation turn.
    if (protocolNoop) return true;
    if (afterAutomation && t === 'assistant' && quietAll) return true;
    if (t === 'result' && afterAutomation) return true;
    if (t === 'assistant' && !eventText(raw).trim()) return true;
  }
  return false;
}
