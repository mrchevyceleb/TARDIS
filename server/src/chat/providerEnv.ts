import { providerNativeCompactWindow } from './contextBudget.ts';

/** Normal turns retain the provider's selected thinking/output budget. Native
 * compaction is enabled; its auxiliary summary request is separately bounded. */
export const PROVIDER_MAX_OUTPUT_TOKENS = 64_000;

/** `maxOutputTokens` is the model's own ceiling when the lane knows it
 *  (OpenRouter publishes one per model); the cap never exceeds it. */
export function applyProviderLimits(
  env: NodeJS.ProcessEnv,
  opts: { model: string; contextWindow: number; maxOutputTokens?: number; retriesVar: string },
): NodeJS.ProcessEnv {
  env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(opts.contextWindow);
  env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(providerNativeCompactWindow(opts.model, opts.contextWindow));
  delete env.DISABLE_AUTO_COMPACT;
  delete env.DISABLE_COMPACT;
  const override = Number(process.env.RIVENDELL_PROVIDER_MAX_OUTPUT_TOKENS?.trim());
  const cap = Number.isInteger(override) && override > 0 ? override : PROVIDER_MAX_OUTPUT_TOKENS;
  const ceiling = opts.maxOutputTokens;
  env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(ceiling && Number.isInteger(ceiling) && ceiling > 0 ? Math.min(cap, ceiling) : cap);
  // Transient server errors (503/529/overloaded) clear on their own, so let
  // the CLI's own retry loop ride them out: 3 attempts with its internal
  // backoff (~2s, ~5s, ~12s) before a lane shows a terminal error (a real
  // Fireworks 503 once killed Becca's turn on attempt 1/1). Non-retryable
  // classes are untouched: the CLI never retries 4xx, so 400s still fail
  // immediately, and a per-engine retriesVar still pins a lane tighter.
  env.CLAUDE_CODE_MAX_RETRIES =
    process.env[opts.retriesVar]?.trim() || process.env.CLAUDE_CODE_MAX_RETRIES?.trim() || '3';
  return env;
}
