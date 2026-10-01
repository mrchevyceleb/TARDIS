/** Client-side classifiers for scheduled-routine noise in the chat feed.
 *  Mirrors server/src/chat/routineNoise.ts — keep the phrase lists in sync. */

const GEAR = '\u2699';
const MODEL_EOS_TOKENS = new Set(['<|eos|>', '<|endoftext|>', '<|end_of_text|>', '<|im_end|>']);

export function isRoutinePromptText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return /^\[routine:/i.test(t) || /\(Scheduled automation —/i.test(t);
}

function normalizeReply(text: string): string {
  return text.trim().replace(/[*`#]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

const ROUTINE_PROGRESS = /(?:^|[.!?]\s+)(?:i(?:'|’)ll|i will|i(?:'|’)m|i am)?\s*(?:check(?:ing)?|pulling|looking|searching|querying|verifying|inspecting|finding|hunting|posting|sending|updating|bumping)\b/;

/** Exact idle token. "NO_UPDATE — failed to reach X" must still show. */
export function isExactNoUpdate(text: string): boolean {
  return /^no_update[.!?]*$/.test(normalizeReply(text));
}

/** Provider end-of-sequence markers are wire protocol, never prose. */
export function isModelEosToken(text: string): boolean {
  return MODEL_EOS_TOKENS.has(text.trim());
}

/** Strict no-op tokens the model is told to emit. Empty is not a token.
 *  Exact `quiet` / `quiet.` only — "Quiet quitting is…" must still show. */
export function isNoopToken(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (isExactNoUpdate(t) || isModelEosToken(t)) return true;
  return /^quiet[.!?]*$/.test(normalizeReply(t));
}

/** No-op automation replies: hide these, keep real ship/fail/needs-user text. */
export function isQuietRoutineReply(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  const lower = normalizeReply(t);
  if (isExactNoUpdate(t) || isModelEosToken(t)) return true;
  if (ROUTINE_PROGRESS.test(lower) && lower.length < 600) return true;
  if (/^quiet\b/.test(lower)) {
    if (/\b(posted|failed|needs you|needs matt)\b/.test(lower) || /\berror:/.test(lower)) return false;
    return true;
  }
  if (/\bstayed silent\b/.test(lower)) return true;
  if (/\bno new shipped rows\b/.test(lower)) return true;
  if (/\bnothing (new|happened)\b/.test(lower) && lower.length < 500) {
    if (/\b(posted|failed|needs you|needs matt)\b/.test(lower) || /\berror:/.test(lower)) return false;
    return true;
  }
  return false;
}

export function isAutomationPeer(from?: string, fromRole?: string, text?: string): boolean {
  const role = (fromRole ?? '').trim().toLowerCase();
  if (role === 'automation-result') return false;
  if (role === 'automation') return true;
  // Matt's own Desk or voice message is never a routine, even when he quotes a routine prompt or the sender name starts with the gear.
  if (role === 'desk' || role === 'voice') return false;
  if ((from ?? '').trim().startsWith(GEAR)) return true;
  if (text && isRoutinePromptText(text)) return true;
  return false;
}

/** Hide an automation's assistant group: in-progress with no live tools,
 *  or a completed turn whose final answer is a quiet no-op. Thoughts stay
 *  attached to that answer, so a quiet last block hides the whole group.
 *  Live tool runs stay visible until they finish. Artifact-only (no text)
 *  is not treated as quiet. */
export function shouldHideAutomationTurn(opts: {
  texts: string[];
  hasRunningTool: boolean;
  isLive: boolean;
  hasNonText?: boolean;
}): boolean {
  if (opts.hasRunningTool) return false;
  if (opts.isLive) return true;
  const nonempty = opts.texts.map((t) => t.trim()).filter(Boolean);
  if (nonempty.length === 0) return !opts.hasNonText;
  const answer = nonempty[nonempty.length - 1];
  return isQuietRoutineReply(answer);
}
