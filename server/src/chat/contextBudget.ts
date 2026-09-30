/** Usage from one model call, never a turn's accumulated billing totals. */
export const CONTEXT_TOKEN_BUDGET = 200_000;
/** Claude Code compacts natively at (window - 20k summary reserve - 13k buffer),
 *  so a 200k window would fire its lossy compact near 167k and starve our
 *  boundary rotation. Pad the window so the native compact only backstops a
 *  single long turn that runs past the budget. */
export const CLAUDE_NATIVE_COMPACT_WINDOW = CONTEXT_TOKEN_BUDGET + 40_000;
/** How long a boundary rotation may hold the lane waiting on the compaction. */
export const ROTATION_COMPACT_DEADLINE_MS = 45_000;
const contexts = new Map<string, number>();
const rotations = new Map<string, number>();

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function recordContextUsage(key: string, engine: 'claude' | 'codex', usage: any): void {
  if (!usage || typeof usage !== 'object') return;
  const input = count(usage.input_tokens) + (engine === 'claude'
    ? count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens) : 0);
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
export function contextRotationDue(key: string): boolean { return contextTokens(key) > CONTEXT_TOKEN_BUDGET; }
export function recordContextRotation(key: string): void {
  rotations.set(key, contextTokens(key));
  contexts.delete(key);
}
