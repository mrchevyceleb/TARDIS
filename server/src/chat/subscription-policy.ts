/** Retired lane IDs remain readable in durable logs, but cannot run new work.
 *  `fireworks` is the API-key provider lane (any serverless Fireworks model
 *  via FIREWORKS_API_KEY), not a subscription, but it shares this gate so the
 *  WS lane assert and agent CRUD accept it everywhere engines are checked.
 *  `openrouter` is the same kind of API-key lane (any tool-capable OpenRouter
 *  model). */
export const SUBSCRIPTION_ENGINES = new Set(['claude', 'codex', 'xai', 'zai', 'fireworks', 'openrouter', 'agy']);

export class SubscriptionEngineError extends Error {
  constructor() {
    super('Choose a subscription engine: Claude Code, Codex, Grok, GLM, Fireworks, OpenRouter, or Gemini.');
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
    // The Google set also scrubs credential/routing variables (service
    // account files, credential-file overrides, Vertex enablement, project /
    // quota / location routing, the gcloud and Cloud SDK aliases): the agy
    // subscription lane signs in with its own stored auth and must never
    // inherit an unrelated service-account or Vertex path, project routing,
    // or billing.
    if (/^(ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL)|OPENAI_(API_KEY|BASE_URL)|CODEX_API_KEY|OPENROUTER_|FIREWORKS_|GOOGLE_API_KEY|GEMINI_API_KEY|GOOGLE_GENERATIVEAI_API_KEY|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_GENAI_USE_VERTEXAI|GOOGLE_CLOUD_PROJECT|GOOGLE_CLOUD_LOCATION|GOOGLE_CLOUD_QUOTA_PROJECT|GCLOUD_PROJECT|CLOUDSDK_CORE_PROJECT|CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE|GROK_PERSONAL_API_KEY|XAI_API_KEY|Z_AI_API_KEY|RIVENDELL_ZAI_FALLBACK_API_KEY|RIVENDELL_OPENROUTER_API_KEY|TYPESAFE_|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY))/i.test(key)) delete env[key];
  }
  return env;
}
