/** Provider failures that are transport output, not assistant prose. */

export type TerminalProviderError = {
  message: string;
  code?: string;
  retryable?: boolean;
};

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
  return /^\s*API Error:\s*(?:Request rejected|\d{3}\b|.*\(\d{3}\))/i.test(text);
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

function providerLabel(cli: string): string {
  if (cli === 'zai') return 'Z.ai';
  if (cli === 'xai') return 'xAI';
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
export function terminalProviderError(cli: string, raw: unknown): TerminalProviderError | null {
  const inner = unwrapEvent(raw);
  if (!inner || inner.type !== 'result') return null;
  const status = typeof inner.api_error_status === 'number' ? inner.api_error_status : undefined;
  // `is_error` alone also covers cancellation, turn limits, and local runner
  // failures. Only an explicit API status proves this is a provider response.
  if (status === undefined) return null;

  const provider = providerLabel(cli);
  const detail = resultDetail(inner);
  const code = status === undefined ? undefined : String(status);

  if (status === 429) {
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
  if (status === 401) {
    return {
      message: `${provider} could not authenticate. Check its account or API key, then try again.`,
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

/** Normalize non-provider terminal outcomes without persisting their raw
 * result payload. These are runner states, not evidence that the API provider
 * failed, so keep the copy accurate and category-based. */
export function terminalExecutionError(
  cli: string,
  raw: unknown,
  syntheticReason?: string | null,
): TerminalProviderError | null {
  const inner = unwrapEvent(raw);
  if (!inner || inner.type !== 'result' || inner.is_error !== true) return null;
  if (typeof inner.api_error_status === 'number') return null;

  const provider = providerLabel(cli);
  const detail = resultDetail(inner);
  const subtype = typeof inner.subtype === 'string' ? inner.subtype : '';
  const signal = `${subtype}\n${detail}`;
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
  if (/budget|spend limit|cost limit/i.test(signal)) {
    return {
      message: `${provider}'s runner reached its configured budget for this turn. Try a smaller request.`,
      code,
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
