/** Provider failures that are transport output, not assistant prose. */

export type TerminalProviderError = {
  message: string;
  code?: string;
  retryable?: boolean;
  usageLimit?: boolean;
  resetTime?: string;
  limitKind?: 'session' | 'weekly' | 'monthly' | 'model' | 'usage';
  /** True when the turn died because the history did not fit the model's
   *  context window: the runner uses this to reseed instead of resuming the
   *  oversized session (Oct 7 review). */
  contextLength?: boolean;
};

const NATIVE_LIMIT = /^\s*(?:You(?:['’]ve| have) hit your (?:(?:session|weekly|usage|monthly spend|Sonnet|Opus|5[- ]hour) )?limit\b|Claude AI usage limit reached\b|5[- ]hour limit reached\b)/i;

/** Preserve only a clock and a valid timezone, never the provider's payload. */
function safeResetTime(text: string): string | undefined {
  const match = /\bresets?\s+(?:(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+([12]\d|3[01]|[1-9]),\s*)?(1[0-2]|[1-9])(?::([0-5]\d))?\s*(am|pm)\s*\((UTC|[A-Za-z_]+(?:\/[A-Za-z_+-]+)+)\)/i.exec(text);
  if (!match) return undefined;
  let zone: string;
  try { zone = new Intl.DateTimeFormat('en-US', { timeZone: match[6] }).resolvedOptions().timeZone; } catch { return undefined; }
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = match[1] ? months.find((m) => m.toLowerCase() === match[1].toLowerCase()) : undefined;
  if (month && Number(match[2]) > new Date(Date.UTC(2028, months.indexOf(month) + 1, 0)).getUTCDate()) return undefined;
  return `${month ? `${month} ${Number(match[2])}, ` : ''}${match[3]}:${match[4] ?? '00'} ${match[5].toUpperCase()} (${zone})`;
}

function usageLimitError(cli: string, text: string, trustedReason = false): TerminalProviderError | null {
  if (!['claude', 'assistant'].includes(cli) || !(trustedReason ? /^usage limit(?: \((session|weekly|model|usage)\))?(?:;|$)/i.test(text) : NATIVE_LIMIT.test(text))) return null;
  const resetTime = safeResetTime(text);
  // The native monthly-spend string names the WEEKLY limit's reset time, not
  // the monthly cap's (Oct 7 review): never claim the spend cap "resets"
  // then. The actionable step is raising the cap at settings/usage.
  if (/monthly spend/i.test(text)) {
    return {
      message: `Claude's monthly spend limit is reached. Raise it at claude.ai/settings/usage, or switch brains and try again later.`,
      code: '429', retryable: true, usageLimit: true, limitKind: 'monthly',
    };
  }
  const limitKind = /weekly/i.test(text) ? 'weekly' : /Sonnet|Opus|\(model\)/i.test(text) ? 'model' : /session|5[- ]hour/i.test(text) ? 'session' : 'usage';
  return {
    message: `Claude's usage window is full. ${resetTime ? `It resets at ${resetTime}.` : 'Try again after the limit resets.'}`,
    code: '429', retryable: true, usageLimit: true, limitKind, ...(resetTime ? { resetTime } : {}),
  };
}

function unwrapEvent(raw: unknown): Record<string, any> | null {
  if (!raw || typeof raw !== 'object') return null;
  const outer = raw as Record<string, any>;
  const persisted = outer.ev && typeof outer.ev === 'object' ? outer.ev : outer;
  return persisted.type === 'event' && persisted.event && typeof persisted.event === 'object'
    ? persisted.event as Record<string, any>
    : persisted as Record<string, any>;
}

function rawAssistantText(inner: Record<string, any>): string {
  const content = inner.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

export function isSyntheticApiErrorText(text: string): boolean {
  // Three shapes ship: the stock "Request rejected", a trailing "(429)", and a
  // leading "API Error: 429 …". Missing the third left its text unscrubbed —
  // raw protocol prose could reach durable history — while the turn was still
  // reported as a dead local runner.
  return /^\s*API Error:\s*(?:Request rejected|\d{3}\b|.*\(\d{3}\))/i.test(text) || NATIVE_LIMIT.test(text);
}

/** The reason out of a synthetic API-error message, and nothing else.
 *
 *  Claude Code can end a turn with a synthetic `API Error: …` assistant
 *  message and then a `result` carrying no `api_error_status` at all. That
 *  result alone is indistinguishable from a dead local runner, so the turn was
 *  reported as one — burying the actual cause, which is the only part the user
 *  can act on. Keep the status code or the stock phrase; drop the echoed
 *  payload, which can carry request metadata. */
export function syntheticApiErrorReason(text: string): string | null {
  if (!isSyntheticApiErrorText(text)) return null;
  const limit = usageLimitError('claude', text);
  if (limit) {
    return `usage limit (${limit.limitKind})${limit.resetTime ? `; resets ${limit.resetTime}` : ''}`;
  }
  if (/Request rejected/i.test(text)) return 'the request was rejected upstream';
  const status = /\((\d{3})\)/.exec(text) ?? /API Error:\s*(\d{3})\b/i.exec(text);
  return status ? `HTTP ${status[1]}` : null;
}

/** Claude Code turns an upstream failure into a fake assistant message. It is
 * protocol output and must never become conversation history or compact memory. */
export function isSyntheticApiErrorEvent(raw: unknown): boolean {
  const inner = unwrapEvent(raw);
  if (!inner || inner.type !== 'assistant') return false;
  if (inner.is_api_error_message === true) return true;
  const model = inner.message?.model;
  return model === '<synthetic>' && isSyntheticApiErrorText(rawAssistantText(inner));
}

export function providerLabel(cli: string): string {
  if (cli === 'zai') return 'Z.ai';
  if (cli === 'xai') return 'xAI';
  if (cli === 'fireworks') return 'Fireworks';
  if (cli === 'openrouter') return 'OpenRouter';
  if (cli === 'assistant' || cli === 'claude') return 'Claude';
  if (cli === 'codex' || cli === 'codex-personal') return 'Codex';
  return 'The model provider';
}

function resultDetail(inner: Record<string, any>): string {
  const pieces: string[] = [];
  if (typeof inner.result === 'string') pieces.push(inner.result);
  if (Array.isArray(inner.errors)) {
    for (const error of inner.errors) {
      if (typeof error === 'string') pieces.push(error);
      else if (error && typeof error.message === 'string') pieces.push(error.message);
    }
  }
  return pieces.join('\n');
}

/** Convert a terminal provider result into short, actionable copy. Raw request
 * ids and provider payloads stay out of the durable user transcript. */
export function terminalProviderError(cli: string, raw: unknown, syntheticReason?: string | null): TerminalProviderError | null {
  const inner = unwrapEvent(raw);
  if (!inner || inner.type !== 'result') return null;
  const status = typeof inner.api_error_status === 'number' ? inner.api_error_status : undefined;
  // `is_error` alone also covers cancellation, turn limits, and local runner
  // failures. Only an explicit API status proves this is a provider response.
  if (status === undefined) return null;

  const provider = providerLabel(cli);
  const detail = `${resultDetail(inner)}\n${syntheticReason ?? ''}`;
  const code = status === undefined ? undefined : String(status);

  if (status === 429) {
    const usageLimit = usageLimitError(cli, syntheticReason ?? '', true) ?? usageLimitError(cli, resultDetail(inner));
    if (usageLimit) return usageLimit;
    if (cli === 'xai' && /\bmodel\s+is\s+currently\s+at\s+capacity\b/i.test(detail)) {
      return {
        message: `${provider} is temporarily at capacity. Try again in a few minutes or switch brains.`,
        code,
        retryable: true,
      };
    }
    if (/usage limit|quota|five[- ]?hour|5\s*hour/i.test(detail)) {
      return {
        message: `${provider}'s usage window is full, so this turn could not run. Switch brains or try again after the limit resets.`,
        code,
        retryable: true,
      };
    }
    return {
      message: `${provider} is rate-limited right now. Switch brains or try again shortly.`,
      code,
      retryable: true,
    };
  }
  if (status === 426) {
    return {
      message: `${provider} says this client is out of date (HTTP 426). Update its client version before trying again.`,
      code,
    };
  }
  if (status === 401) {
    return {
      message: `${provider} could not authenticate. Check its account or API key, then try again.`,
      code,
    };
  }
  if (status === 402) {
    // OpenRouter's out-of-credits answer; retrying cannot help.
    return {
      message: `${provider} says the account is out of credits (HTTP 402). Add credits or switch brains.`,
      code,
    };
  }
  if (status === 403) {
    return {
      message: `${provider} refused this request because the account or plan does not allow it.`,
      code,
    };
  }
  if (status !== undefined && status >= 500) {
    return {
      message: `${provider} is unavailable right now (HTTP ${status}). Try again shortly or switch brains.`,
      code,
      retryable: true,
    };
  }
  return {
    message: `${provider} could not answer this turn (HTTP ${status}). Try again or switch brains.`,
    code,
    retryable: true,
  };
}

/** The provider refused the prompt as too long for the model's context. Output
 *  cap errors ("exceeded the 32000 output token maximum") are not this. */
export function isContextLengthRejection(detail: string): boolean {
  return /prompt is too long|context[ _-]?(?:length|window)[ _-](?:exceeded|limit)|maximum context length|input (?:is )?too long|too many input tokens/i.test(detail);
}

/** A turn that died because Claude Code could not compact its history. The
 *  provider's own reason is the only actionable part, so keep it (trimmed,
 *  first line only) instead of a bare status. */
export function compactFailureError(cli: string, detail: string, rerun = false): TerminalProviderError {
  const reason = detail.split('\n')[0].replace(/^\s*API Error:\s*/i, '').replace(/\s*To configure this behavior.*$/i, '').trim().replace(/\.$/, '').slice(0, 240);
  return {
    message: `${providerLabel(cli)} could not shrink this chat's history${reason ? ` (${reason})` : ''}. ${rerun
      ? 'TARDIS is starting fresh from the saved summary and re-running the message automatically.'
      : 'The next message starts fresh from the saved summary; send it again.'}`,
    code: 'compact_failed',
    retryable: true,
  };
}

/** Normalize non-provider terminal outcomes without persisting their raw
 * result payload. These are runner states, not evidence that the API provider
 * failed, so keep the copy accurate and category-based. */
export function terminalExecutionError(
  cli: string,
  raw: unknown,
  syntheticReason?: string | null,
  lastTurnText?: string | null,
): TerminalProviderError | null {
  const inner = unwrapEvent(raw);
  if (!inner || inner.type !== 'result' || inner.is_error !== true) return null;
  if (typeof inner.api_error_status === 'number') return null;

  const provider = providerLabel(cli);
  const detail = resultDetail(inner);
  const subtype = typeof inner.subtype === 'string' ? inner.subtype : '';
  // The CLI reports several failures as ordinary assistant text plus a bare
  // failed result, so the streamed turn text is part of the classification
  // signal. Without it they all collapse into "dead local runner".
  const signal = `${subtype}\n${detail}\n${lastTurnText ?? ''}`;
  const code = /^[a-z0-9_-]{1,64}$/i.test(subtype) ? subtype : 'execution_error';
  if (/cancel|interrupt|aborted/i.test(signal)) {
    return { message: 'This turn was cancelled before it finished.', code };
  }
  if (/max(?:imum)?[_ -]?(?:turns?|steps?)|turn limit|step limit/i.test(signal)) {
    return {
      message: `${provider} reached this turn's step limit before finishing. Try a smaller request or continue in a new message.`,
      code,
      retryable: true,
    };
  }
  // The provider's own native limit text must classify as a usage window
  // even when it mentions a spend limit (Oct 3: the monthly-spend native
  // string read as the runner's budget), so this check runs BEFORE the
  // budget branch. Only NATIVE_LIMIT-shaped text passes; a runner-budget
  // signal still falls through to the branch below.
  const usageLimit = usageLimitError(cli, syntheticReason ?? '', true) ?? usageLimitError(cli, detail) ?? usageLimitError(cli, lastTurnText ?? '');
  if (usageLimit) return usageLimit;
  if (/budget|spend limit|cost limit/i.test(signal)) {
    return {
      message: `${provider}'s runner reached its configured budget for this turn. Try a smaller request.`,
      code,
      retryable: true,
    };
  }
  // History too big for the model's context window and compaction could not
  // save the turn (Oct 3: the native "Prompt is too long" wrapper read as a
  // dead local runner). Same recovery class as a failed compact: a fresh
  // message continues from the saved summary. The flag drives the runner's
  // reseed so an oversized session is never resumed (Oct 7 review).
  if (isContextLengthRejection(signal)) {
    return {
      message: `${provider} could not fit this chat's history into its context window. Start a fresh chat or trim the largest items, then send again.`,
      code,
      retryable: true,
      contextLength: true,
    };
  }
  // Two warm-process failures that read as crashes but are not: the CLI's
  // OAuth refresh lock colliding with a sibling process, and a model tool
  // call that fails to parse even after the CLI's own retry nudge. Both are
  // retryable and neither means the runner died.
  if (/failed to refresh (?:the )?oauth token|another claude code process is refreshing/i.test(signal)) {
    return {
      message: `${provider}'s login token refresh collided with another ${provider} process. It clears on its own in a minute; send again.`,
      code: 'oauth_refresh_collision',
      retryable: true,
    };
  }
  if (/tool call could not be parsed|failed to produce a valid tool call/i.test(signal)) {
    return {
      message: `${provider} sent a malformed tool call twice, so the turn stopped early. What finished is kept; send again to continue.`,
      code: 'tool_call_unparseable',
      retryable: true,
    };
  }
  // A synthetic API error proves the turn died upstream, not in the local
  // runner, even though this result carries no status of its own.
  if (syntheticReason) {
    return {
      message: `${provider} could not answer this turn (${syntheticReason}). Try again or switch brains.`,
      code,
      retryable: true,
    };
  }
  return {
    message: `${provider}'s local runner stopped before it could finish this turn. Try again or switch brains.`,
    code,
    retryable: true,
  };
}
