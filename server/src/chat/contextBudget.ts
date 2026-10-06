/** Usage from one model call, never a turn's accumulated billing totals. */
export const CONTEXT_TOKEN_BUDGET = 200_000;
/** Claude Code compacts natively at (window - 20k summary reserve - 13k buffer),
 *  so a 200k window would fire its lossy compact near 167k and starve our
 *  boundary rotation. Pad the window so the native compact only backstops a
 *  single long turn that runs past the budget. The pad leaves about 27k tokens
 *  between the budget and the native compact: a 7k gap let the first turn
 *  after the budget cross the line and compact natively before a rotation ran. */
export const NATIVE_COMPACT_PAD = 60_000;
export const CLAUDE_NATIVE_COMPACT_WINDOW = CONTEXT_TOKEN_BUDGET + NATIVE_COMPACT_PAD;
/** Claude Code's own compact fires this far below the window it is given
 *  (20k summary reserve + 13k buffer). */
export const NATIVE_COMPACT_MARGIN = 33_000;
/** Budgets learned this process from a provider refusing a context below its
 *  catalog window, keyed by model id. Never persisted: a restart retries the
 *  catalog number, and the first refusal teaches it again. */
const learnedBudgets = new Map<string, number>();

/** Rotation budget for a non-Anthropic `claude` lane: the 200k budget, or the
 *  model's window less the native-compact pad when that is smaller. A small
 *  window shrinks the pad but keeps the budget a quarter of the window below
 *  the native threshold, so rotation still comes first. */
export function providerContextBudget(model: string, window: number): number {
  const pad = Math.min(NATIVE_COMPACT_PAD, NATIVE_COMPACT_MARGIN + Math.floor(window / 4));
  const base = Math.min(CONTEXT_TOKEN_BUDGET, Math.max(Math.floor(window / 4), window - pad));
  return Math.min(base, learnedBudgets.get(model) ?? Infinity);
}
/** The native compact only backstops the lane's own rotation budget. */
export function providerNativeCompactWindow(model: string, window: number): number {
  return Math.min(window, providerContextBudget(model, window) + NATIVE_COMPACT_PAD);
}
/** A provider refused (or Claude Code compacted reactively at) `tokens`; rotate
 *  this model 15% below that for the rest of the process. Returns the budget. */
export function learnContextLimit(model: string, tokens: number, window: number): number {
  const learned = Math.floor(tokens * 0.85);
  if (learned > 0 && learned < (learnedBudgets.get(model) ?? Infinity)) {
    learnedBudgets.set(model, learned);
    console.log(`[context-rotation] model=${model} refused near ${tokens} tokens; budget now ${providerContextBudget(model, window)}`);
  }
  return providerContextBudget(model, window);
}
/** How long a boundary rotation may hold the lane for a backlog too big to carry
 *  verbatim. The rolling compact takes a model minutes, so past this the lane
 *  goes on and the rotation lands at a later turn end, once the compact is done. */
export const ROTATION_COMPACT_DEADLINE_MS = 10_000;
/** Turns the compact has not absorbed ride in the seed word for word, so a tail
 *  up to this size rotates at once instead of waiting on a new summary. */
export const ROTATION_VERBATIM_TAIL_CHARS = 96 * 1024;
const contexts = new Map<string, number>();
const rotations = new Map<string, number>();

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function recordContextUsage(key: string, engine: 'claude' | 'codex' | 'pi', usage: any): void {
  if (!usage || typeof usage !== 'object') return;
  // Codex reports cache tokens differently; Claude and the Pi harness (GLM/Grok)
  // report Anthropic-shaped usage where cache reads still occupy the context window.
  const input = count(usage.input_tokens) + (engine === 'codex'
    ? 0 : count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens));
  if (!input) return;
  const tokens = input + count(usage.output_tokens);
  contexts.set(key, tokens);
  const before = rotations.get(key);
  if (before !== undefined) {
    rotations.delete(key);
    console.log(`[context-rotation] lane=${key} before=${before} after=${tokens}`);
  }
}

export function contextTokens(key: string): number { return contexts.get(key) ?? 0; }
export function contextRotationDue(key: string, budget = CONTEXT_TOKEN_BUDGET): boolean { return contextTokens(key) > budget; }
export function recordContextRotation(key: string): void {
  rotations.set(key, contextTokens(key));
  contexts.delete(key);
}
