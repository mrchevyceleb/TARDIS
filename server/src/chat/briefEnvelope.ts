// Brief envelope (card-e9b846, Matt Oct 20 2026): every brief a coder gets
// arrives as one Core Experience Goal sentence (how the customer should feel
// and what they get) plus a card link, even when the lead is rushed and
// writes a wall of steps. Persona lines do not stick under pressure, so the
// envelope is built here, in the delivery path itself: no sender can skip
// it, and the goal line always comes first.
//
// Rules (Max, Oct 20): the lead's own goal sentence wins when it reads as
// one; otherwise a cheap model distills one from the brief. The card link
// is read from the Desk card the brief names — never invented; a brief
// naming no card gets a plain "no card named, card it first" line instead.
// The lead's raw text stays below as detail. Steering turns (wait:true
// replies) skip the envelope so it never delays a live exchange, and any
// failure anywhere falls open to the raw brief exactly as today.

import { Agent, fetch as undiciFetch } from 'undici';
import { redactSecrets } from './secretRedaction.ts';

/** Coders whose briefs always carry the envelope. Roster ids. */
const CODER_IDS = new Set([
  'naomi', 'christina', 'maria', 'adam', 'pippin', 'ivy',
  'tim', 'piper', 'felix',
]);

/** Leads who brief coders. Roster ids. */
const LEAD_IDS = new Set(['kip', 'chief-of-staff', 'samwise', 'riley']);

/** True when this handoff is a brief from a lead to a coder. */
export function isCoderBrief(senderId: string, recipientId: string): boolean {
  return LEAD_IDS.has(senderId) && CODER_IDS.has(recipientId);
}

const CARD_RE = /\[desk:(card-[A-Za-z0-9_-]+)\]|(?<!desk:)(card-[A-Za-z0-9_-]*[A-Za-z0-9_])/g;
/** Terminal punctuation of a real sentence (never a step number). */
const SENTENCE_PUNCT = /[.!?。！？]/;

/** Crude technical/command shape: file paths, version strings, code or CLI
 *  fragments. Such an opening is an instruction, never a goal sentence. */
const TECHNICAL_FRAGMENT = /(?:[A-Za-z]:\\|[\w./-]+\.[a-z]{1,5}\b|\bv?\d+\.\d+(?:\.\d+)?\b|`[^`]+`|\b(?:npm|node|git|systemctl|curl|ssh|python\d?|cd|rm|mv|cp|ls|cat|sed|awk|grep|rg)\b)/i;

/** True when the opening word is an imperative verb aimed at the recipient
 *  ("Edit foo.ts", "Fix the login", "Ship it tonight."). A goal sentence
 *  describes how a person should feel or what they should get, not a command
 *  to the coder. */
const IMPERATIVE_STARTERS = new Set([
  'add', 'apply', 'build', 'bump', 'change', 'check', 'clean', 'commit', 'configure', 'copy', 'create', 'delete', 'deploy', 'disable', 'edit', 'enable', 'ensure', 'extend', 'fix', 'implement', 'install', 'make', 'merge', 'migrate', 'move', 'patch', 'push', 'read', 'rebuild', 'refactor', 'remove', 'rename', 'replace', 'restart', 'revert', 'review', 'run', 'send', 'set', 'ship', 'stop', 'test', 'update', 'use', 'verify', 'wire', 'write',
]);

function startsAsInstruction(t: string): boolean {
  const first = /^[A-Za-z]+/.exec(t)?.[0]?.toLowerCase() ?? '';
  return IMPERATIVE_STARTERS.has(first) || TECHNICAL_FRAGMENT.test(t);
}

/** Split text into sentences at real sentence boundaries: terminal
 *  punctuation preceded by a letter (so a step number "1." or a version
 *  "v1.2" never splits) and followed by whitespace or the end. */
function splitSentences(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < t.length; i++) {
    if (!SENTENCE_PUNCT.test(t[i])) continue;
    const prev = i > 0 ? t[i - 1] : '';
    const end = i + 1 >= t.length || /\s/.test(t[i + 1]);
    if (end && /\p{L}/u.test(prev)) {
      const s = t.slice(start, i + 1).trim();
      if (s) out.push(s);
      start = i + 1;
    }
  }
  const rest = t.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}

/** True when the text reads as one goal sentence: exactly one sentence,
 *  one line, under 280 chars, no list or step markers (a numbered step or
 *  a "Step N" opener is an instruction, never a goal). */
export function readsAsGoalSentence(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 280) return false;
  if (/\n/.test(t)) return false;
  if (/^(?:[-*•]|\d+[.)])\s/.test(t)) return false;
  if (/^step\s+\d+\b/i.test(t)) return false;
  if (startsAsInstruction(t)) return false;
  if (splitSentences(t).length !== 1) return false;
  return SENTENCE_PUNCT.test(t);
}

/** The lead's own goal sentence, or null: the whole text when it is one
 *  goal sentence; otherwise the opening sentence when the text *starts*
 *  with one (a goal line followed by steps). A numbered or bulleted
 *  opener is a step list, not a goal, so it never qualifies. */
export function ownGoalSentence(text: string): string | null {
  const t = text.trim();
  if (readsAsGoalSentence(t)) return t;
  const [first, second] = splitSentences(t);
  if (first && second && !first.includes('\n') && readsAsGoalSentence(first) && first.length <= 200) {
    return first;
  }
  return null;
}

/** Every card the brief names, in the form the recipient should see. */
export function cardRefsIn(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(CARD_RE)) {
    const id = m[1] ?? m[2];
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** The envelope header: goal sentence, then card link (or the no-card line). */
export function envelopeHeader(goal: string | null, cardId: string | null): string[] | null {
  if (!goal) return null;
  const cardLine = cardId
    ? `Card: [desk:${cardId}]`
    : 'No card named in this brief — card it first: nothing is invented here.';
  return [goal, cardLine];
}

/** Cheap model route for distillation (same route the compact checker uses). */
const DISTILL_AGENT = new Agent({ headersTimeout: 8_000, bodyTimeout: 8_000 });
const DISTILL_TIMEOUT_MS = 8_000;
const DISTILL_MAX_CHARS = 8_000;
let distillConfigWarned = false;

export function distillConfig(): { base: string; key: string } | null {
  const base = process.env.RIVENDELL_OPENROUTER_ANTHROPIC_BASE_URL?.trim() || 'https://openrouter.ai/api';
  const key = process.env.RIVENDELL_OPENROUTER_API_KEY?.trim() || process.env.OPENROUTER_API_KEY?.trim() || '';
  if (!key) return null;
  return { base, key };
}

/** Distill one goal sentence from a brief. Null on any failure (caller
 *  falls open to the raw brief). Never throws. */
export async function distillGoalSentence(brief: string, _agentName: string): Promise<string | null> {
  const cfg = distillConfig();
  if (!cfg) {
    if (!distillConfigWarned) {
      distillConfigWarned = true;
      console.warn('[brief] goal distillation unavailable: no OpenRouter key');
    }
    return null;
  }
  const body = redactSecrets(brief).slice(0, DISTILL_MAX_CHARS);
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(() => deadline.abort(), DISTILL_TIMEOUT_MS);
  deadlineTimer.unref?.();
  try {
    const res = await undiciFetch(`${cfg.base.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      dispatcher: DISTILL_AGENT,
      signal: deadline.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.key}`,
      },
      body: JSON.stringify({
        model: process.env.RIVENDELL_BRIEF_DISTILL_MODEL?.trim() || 'google/gemini-4-argon',
        max_tokens: 512,
        system: 'You distill one work brief into ONE sentence: how the customer or user should feel and what they get, like a vibe-coding prompt. No technical steps, no file names, no internal ids. Output only the sentence.',
        thinking: { type: 'adaptive' },
        output_config: { effort: 'low' },
        messages: [{ role: 'user', content: body }],
      }),
    });
    if (!res.ok || deadline.signal.aborted) return null;
    const parsed = (await res.json()) as {
      content?: Array<{ type?: string; text?: string }>;
      stop_reason?: string;
    };
    if (deadline.signal.aborted || parsed.stop_reason === 'max_tokens') return null;
    const text = (parsed.content ?? [])
      .filter((b) => b?.type === 'text')
      .map((b) => b.text ?? '')
      .join('\n')
      .trim();
    return readsAsGoalSentence(text) ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(deadlineTimer);
  }
}

/**
 * Wrap a brief in its envelope, or return null when no envelope applies
 * (caller delivers the raw text). Fail-open everywhere: a model or
 * transport failure returns null, never throws, never delays past 8s.
 */
export async function briefEnvelopeForHandoff(opts: {
  senderId: string;
  recipientId: string;
  recipientName: string;
  text: string;
  wait: boolean;
  /** True when this delivery may steer a live turn. A model call must never
   *  delay that path; only an already-written goal sentence may ride it. */
  maySteer?: boolean;
}): Promise<string | null> {
  if (opts.wait || opts.maySteer) return null;
  if (!isCoderBrief(opts.senderId, opts.recipientId)) return null;
  const text = opts.text.trim();
  if (!text) return null;
  const cards = cardRefsIn(text);
  const cardId = cards[0] ?? null;
  const own = ownGoalSentence(text);
  const goal = own ?? (await distillGoalSentence(text, opts.recipientName));
  const header = envelopeHeader(goal, cardId);
  if (!header) return null;
  return [...header, '', 'Detail from the brief (original text):', text].join('\n');
}
