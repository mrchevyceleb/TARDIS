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
 *  the cap does not move the compact threshold. On 2026-10-08 the summary ran
 *  past 64K the same way, so the native auto-compact is disabled outright on
 *  every non-Anthropic lane and the cap now bounds real turns only. */
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
  // The native compact makes the lane model rewrite the whole history as one
  // summary, and a thinking model runs past the output cap doing it (Qwen 3.8
  // Max at 32K on 2026-10-06, past 64K again on 2026-10-08, killing Becca's
  // live turn mid task). TARDIS owns history management on these lanes with
  // its own rolling summary, so the native auto-compact is disabled outright
  // instead of chasing the cap: a single turn that outgrows the real window
  // now ends as a context-length rejection, which reseeds and re-runs once
  // (runner.ts). Manual /compact stays enabled (that would be
  // DISABLE_COMPACT, a different switch).
  env.DISABLE_AUTO_COMPACT = '1';
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
