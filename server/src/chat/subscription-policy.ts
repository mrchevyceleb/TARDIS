/** Retired lane IDs remain readable in durable logs, but cannot run new work. */
export const SUBSCRIPTION_ENGINES = new Set(['claude', 'codex', 'xai']);

export class SubscriptionEngineError extends Error {
  constructor() {
    super('Choose a subscription engine: Claude Code, Codex, or Grok.');
    this.name = 'SubscriptionEngineError';
  }
}

export function assertSubscriptionEngine(engine: unknown): asserts engine is string {
  if (typeof engine !== 'string' || !SUBSCRIPTION_ENGINES.has(engine)) {
    throw new SubscriptionEngineError();
  }
}

/** Legacy Claude/Codex lane aliases may still service existing threads. */
export function assertSubscriptionLane(lane: unknown): void {
  if (lane === 'assistant' || lane === 'codex-personal') return;
  assertSubscriptionEngine(lane);
}

export function subscriptionEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (/^TARDIS_OFFICE_ADMIN_TOKEN$/i.test(key)) delete env[key];
    if (/^(ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL)|OPENAI_(API_KEY|BASE_URL)|CODEX_API_KEY|OPENROUTER_|FIREWORKS_|GROK_PERSONAL_API_KEY|XAI_API_KEY|Z_AI_API_KEY|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY))/i.test(key)) delete env[key];
  }
  return env;
}
