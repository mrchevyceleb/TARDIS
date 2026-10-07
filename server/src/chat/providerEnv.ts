import { providerNativeCompactWindow } from './contextBudget.ts';

/** Limits every non-Anthropic `claude` binary lane (Z.ai, xAI, Fireworks,
 *  OpenRouter) passes to Claude Code.
 *
 *  Claude Code (v2.1.x) assumes 200K context and a 32K output cap for any
 *  model id it does not know. MAX_CONTEXT_TOKENS gives it the real window and
 *  AUTO_COMPACT_WINDOW the compact threshold (it compacts about 33K below it).
 *
 *  The output cap also bounds the compaction summary request. A thinking model
 *  spends part of it reasoning, so at 32K Qwen 3.8 Max overflowed it and the
 *  turn died with "automatic compaction failed: ... exceeded the 32000 output
 *  token maximum" (2026-10-06). 64K was accepted by every Fireworks catalog
 *  model and by xAI; Fireworks clamps rather than rejecting prompt plus cap.
 *  The binary reserves min(cap, 20K) for the summary either way, so raising
 *  the cap does not move the compact threshold. */
export const PROVIDER_MAX_OUTPUT_TOKENS = 64_000;

/** `maxOutputTokens` is the model's own ceiling when the lane knows it
 *  (OpenRouter publishes one per model); the cap never exceeds it. */
export function applyProviderLimits(
  env: NodeJS.ProcessEnv,
  opts: { model: string; contextWindow: number; maxOutputTokens?: number; retriesVar: string },
): NodeJS.ProcessEnv {
  env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(opts.contextWindow);
  // TARDIS rotates the lane at its own budget; the native compact only
  // backstops a single turn that runs past it.
  env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(providerNativeCompactWindow(opts.model, opts.contextWindow));
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
