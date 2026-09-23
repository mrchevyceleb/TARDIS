// Client mirror of server/src/chat/routineNoise.ts — keep the classifiers in
// sync. Automation (routine) turns are silent in the chat thread unless the
// turn's final text is a real deliverable: something shipped, failed, or
// needs the user. The durable event log keeps everything; this only filters the
// rendered blocks (live stream, replay, and the localStorage cache alike).

import type { ChatBlock } from '../data/types';
import { isModelEosToken } from './routineNoise';

const GEAR = '⚙';

function normalizeReply(text: string): string {
  return text.trim().replace(/[*`#]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function isRoutinePromptText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return /^\[routine:/i.test(t) || /\(Scheduled automation —/i.test(t);
}

function isExactNoUpdate(text: string): boolean {
  return /^no_update[.!?]*$/.test(normalizeReply(text));
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
function hasFailureSignal(text: string): boolean {
  const lower = normalizeReply(text);
  if (/\b(needs you|needs matt|needs attention|action needed)\b/.test(lower)) return true;
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

function isAutomationPeer(block: ChatBlock): block is Extract<ChatBlock, { kind: 'peer' }> {
  if (block.kind !== 'peer') return false;
  const role = (block.fromRole ?? '').trim().toLowerCase();
  // A completed routine deliverable is a visible provenance boundary, not a
  // new trigger to suppress on the next filter/storage pass.
  if (role === 'automation-result') return false;
  if (role === 'automation') return true;
  if (block.from.trim().startsWith(GEAR)) return true;
  return isRoutinePromptText(block.text);
}

function tailAutomationStart(blocks: ChatBlock[]): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    const k = b.kind;
    if (k === 'user' || k === 'switch' || k === 'compact' || k === 'restart' || k === 'terminal-error') return -1;
    if (k === 'peer') return isAutomationPeer(b) ? i : -1;
  }
  return -1;
}

/** The current raw turn belongs to a routine, regardless of whether a tool is
 *  between content blocks and temporarily has no open/running flag. */
export function automationTurnPending(blocks: ChatBlock[]): boolean {
  return tailAutomationStart(blocks) >= 0;
}

/** True when the tail of the RAW block list is an automation turn that is
 *  still starting or running. The typing indicator reads this to stay silent
 *  during routine work — the pod filter alone leaves ChatThread thinking the
 *  thread is idle-but-streaming, which would flash the bubble all run long. */
export function automationTurnInFlight(blocks: ChatBlock[]): boolean {
  const start = tailAutomationStart(blocks);
  if (start < 0) return false;
  const rest = blocks.slice(start + 1);
  if (rest.length === 0) return true; // trigger just fired, no blocks yet
  return rest.some(
    (t) => (t.kind === 'text' && t.open) || (t.kind === 'tool' && (t.open || t.running)),
  );
}

/** Drop automation turns (the ⚙ trigger card + every tool/thought pod) unless
 *  the turn produced a deliverable message — then keep just that text. */
export function filterAutomationNoise(blocks: ChatBlock[]): ChatBlock[] {
  const out: ChatBlock[] = [];
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i];
    if (!isAutomationPeer(b)) {
      out.push(b);
      i += 1;
      continue;
    }
    // Gather the turn: everything until the next user/peer/switch/compact block.
    let j = i + 1;
    const turn: ChatBlock[] = [];
    while (j < blocks.length) {
      const k = blocks[j].kind;
      if (k === 'user' || k === 'peer' || k === 'switch' || k === 'compact' || k === 'restart' || k === 'terminal-error') break;
      turn.push(blocks[j]);
      j += 1;
    }
    const textBlocks = turn.filter(
      (t): t is Extract<ChatBlock, { kind: 'text' }> => t.kind === 'text',
    );
    const nonEmpty = textBlocks.filter((t) => t.text.trim());
    // Hold everything until the turn settles — mid-flight chatter like
    // "Checking the calendar…" must never flash in and then vanish when the
    // turn ends quiet. A tool stays in-flight while RUNNING (open flips false
    // at content_block_stop, long before the result lands).
    const inFlight = turn.some(
      (t) => (t.kind === 'text' && t.open) || (t.kind === 'tool' && (t.open || t.running)),
    );
    // The TERMINAL text block is the verdict: a quiet sign-off means the whole
    // turn was working noise (progress chatter around tool calls is never the
    // message). A non-quiet ending means that block alone is the deliverable.
    const last = nonEmpty[nonEmpty.length - 1];
    let deliverable: (typeof nonEmpty)[number] | undefined;
    if (last && !isQuietRoutineReply(last.text)) {
      deliverable = last;
    } else {
      // Never bury a failure reported mid-turn behind a quiet sign-off.
      deliverable = [...nonEmpty].slice(0, -1).reverse().find((t) => hasFailureSignal(t.text));
    }
    if (deliverable && (!inFlight || hasFailureSignal(deliverable.text))) {
      // Preserve provenance as a peer boundary instead of returning bare text.
      // Otherwise ChatThread merges this later routine result into the previous
      // human turn and promotes it over that turn's actual answer.
      out.push({
        kind: 'peer',
        id: deliverable.id,
        from: b.from,
        fromRole: 'automation-result',
        text: deliverable.text,
        ts: deliverable.ts,
        ...(deliverable.tsApprox ? { tsApprox: true } : {}),
      });
    }
    i = j;
  }
  return out;
}
