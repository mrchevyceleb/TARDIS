/** Deterministic last line of defence before conversation text becomes durable
 * compact memory or leaves the box for the RAG index. This intentionally keeps
 * service/account names while replacing credential values. */

const REDACTED = '[redacted secret]';
/** A secret-word name followed by a dimension word is a config field, not a
 *  credential: INPUT_TOKEN_COUNT, MAX_TOKEN_LIMIT, RATE_LIMIT_SECRET_PATH.
 *  Matched against the prefix tail so these lines are never masked (the
 *  unquoted rule would otherwise erase the whole remainder of the line). */
const NON_SECRET_NAME = /(?:COUNT|LIMIT|SIZE|WIDTH|HEIGHT|LENGTH|URL|URI|ORIGIN|HOST|PORT|NAME|TITLE|PATH|DIR|PREFIX|SUFFIX|TTL|TIMEOUT|ID|IDS|VERSION|TYPE|MODE|FORMAT|LABEL|TAG|FLAG|DEBUG|RETRIES?|NUM|CAP|BUDGET|WINDOW|EXPIRY|EXPIRES|AT|ON|IN|OF)[A-Z0-9_]*["']?\s*[:=]\s*$/;
const REDACTED_SENTINEL = 'RIVENDELL_REDACTED_SECRET_VALUE';

function preserveFence(value: string): string {
  if (value.startsWith('`') && value.endsWith('`')) return `\`${REDACTED}\``;
  if (value.startsWith('"') && value.endsWith('"')) return `"${REDACTED}"`;
  if (value.startsWith("'") && value.endsWith("'")) return `'${REDACTED}'`;
  return REDACTED;
}

function redactOpaqueToken(token: string, offset: number, source: string): string {
  // A 64-char hex string is a credential unless nearby context positively
  // identifies a checksum/object digest. Ordinary 40-char Git SHAs never
  // reach this matcher; they remain useful references by default.
  const context = source.slice(Math.max(0, offset - 96), offset);
  if (/(?:\b(?:commit|sha(?:-?256)?|checksum|digest|git hash|object hash|revision|rev)\b\s*(?::|=|is|was|at)?\s*|\/commit\/)$/i.test(context)) {
    return token;
  }
  return REDACTED;
}

/** Secret-named values from this process's own environment, collected once
 * at first use: every lane inherits this environment, so a printed value that
 * matches one is a leaked credential even with no recognizable shape (a
 * 24-char Vercel key). Exact-value masking is the only reliable catch for
 * short shapeless tokens. The process environment is boot-frozen (nothing
 * mutates it at runtime; a rotated secret arrives with the next process, and
 * every process rescans on its first redaction), so a once-collected list
 * cannot go stale inside a run. */
let knownSecretValues: string[] | null = null;
let knownSecretMatcher: RegExp | null = null;

function collectKnownSecretValues(): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(process.env)) {
    if (typeof value !== 'string' || value.length < 8) continue;
    if (!/(?:API_)?(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PASSCODE|CREDENTIAL|COOKIE)$/.test(name)) continue;
    if (/^(?:true|false|null|undefined|none|0|1)$/i.test(value)) continue;
    out.push(value);
  }
  return out;
}

/** Redact common credentials in prose, Markdown, env assignments, JSON/YAML,
 * command lines, URLs, and pasted key material. Idempotent by design. */
export function redactSecrets(text: string): string {
  if (!text) return text;

  let out = text
    .replace(/\[redacted secret\]/gi, REDACTED_SENTINEL)
    .replace(
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
      '[redacted private key]',
    )
    // Header values are opaque and may use arbitrary schemes or contain many
    // semicolon-delimited cookies. Redact the entire remainder of the line;
    // token-shaped matching alone is not safe for short credentials.
    .replace(
      /(\b(?:authorization|proxy-authorization|cookie|set-cookie)\b["']?\s*:\s*)[^\r\n]*/gi,
      (_all, prefix: string) => `${prefix}${REDACTED}`,
    )
    .replace(
      /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/?#@]+:)[^\s/@?#]+(@)/gi,
      `$1${REDACTED}$2`,
    )
    .replace(
      /([?&#](?:x-amz-(?:signature|credential|security-token)|x-goog-(?:signature|credential)|awsaccesskeyid|signature|sig|token|access_token|auth|api_key|apikey|key|secret|password|code)=)[^&#\s]*/gi,
      `$1${REDACTED}`,
    )
    .replace(/\b(Bearer|Basic)(\s+)[A-Za-z0-9._~+/=-]{8,}/gi, (_all, scheme: string, gap: string) => `${scheme}${gap}${REDACTED}`)
    .replace(
      /(\b(?:[A-Z][A-Z0-9_]*_)?(?:API_KEY|KEY|TOKEN|SECRET|PASSWORD|PASSCODE|PASS|PWD|COOKIE|CREDENTIAL)(?:_[A-Z0-9_]+)*\s*=\s*)(`[^`\r\n]+`|"(?:\\.|[^"\\\r\n])+"|'(?:\\.|[^'\\\r\n])+'|[^\r\n]+)/gi,
      (_all, prefix: string, value: string) => (NON_SECRET_NAME.test(prefix) ? _all : `${prefix}${preserveFence(value)}`),
    )
    // A value under a secret-shaped UPPERCASE name in JSON/YAML/JS object
    // form: quotes and a colon instead of "=". The env rule above needs "=",
    // so `"VERCEL_API_KEY": "abc"` slipped, and the value is masked by its
    // NAME here regardless of shape, so short shapeless tokens cannot slip
    // either. Bare lowercase "key"/"token" names stay readable on purpose
    // (keyboard events, token counters).
    // The unquoted form masks the whole remainder of the line, like the
    // header rule: a secret-named YAML scalar can be a multi-word passphrase
    // ("PASSWORD: correct horse battery staple") and token-shape matching
    // would leak most of it.
    .replace(
      /(\b(?:[A-Z][A-Z0-9_]*_)?(?:API_KEY|KEY|TOKEN|SECRET|PASSWORD|PASSCODE|PASS|PWD|COOKIE|CREDENTIAL)(?:_[A-Z0-9_]+)*["']?\s*:\s*)(`[^`\r\n]+`|"(?:\\.|[^"\\\r\n])+"|'(?:\\.|[^'\\\r\n])+'|[^\r\n]+)/g,
      (_all, prefix: string, value: string) => (NON_SECRET_NAME.test(prefix) ? _all : `${prefix}${preserveFence(value)}`),
    )
    .replace(
      /(\b(?:password|passcode|passwd|pwd|api[_ -]?key|access[_ -]?token|auth(?:entication|orization)?[_ -]?token|bearer token|client[_ -]?secret|refresh[_ -]?token|private[_ -]?key|credential|cookie|session token|otp|one[- ]time (?:password|code)|verification code|recovery code)\b[^:\r\n=]{0,80}(?::|=)\s*)(`(?:\\.|[^`\\\r\n])+`|"(?:\\.|[^"\\\r\n])+"|'(?:\\.|[^'\\\r\n])+'|[^\s,;]+)/gi,
      (_all, prefix: string, value: string) => `${prefix}${preserveFence(value)}`,
    )
    .replace(
      /(\b(?:password|passcode|passwd|pwd|api[_ -]?key|access[_ -]?token|auth(?:entication|orization)?[_ -]?token|bearer token|client[_ -]?secret|refresh[_ -]?token|private[_ -]?key|credential|session token|otp|one[- ]time (?:password|code)|verification code|recovery code)\b\s+(?:is|was)\s+)(`(?:\\.|[^`\\\r\n])+`|"(?:\\.|[^"\\\r\n])+"|'(?:\\.|[^'\\\r\n])+'|[^\s,;]+)/gi,
      (_all, prefix: string, value: string) => `${prefix}${preserveFence(value)}`,
    )
    .replace(
      /((?:--?)(?:(?:api-?)?key|token|secret|password))(=|\s+)(`(?:\\.|[^`\\\r\n])+`|"(?:\\.|[^"\\\r\n])+"|'(?:\\.|[^'\\\r\n])+'|[^\s,;]+)/gi,
      (_all, flag: string, separator: string, value: string) => `${flag}${separator}${preserveFence(value)}`,
    )
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted jwt]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, REDACTED)
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, REDACTED)
    .replace(/\b(?:sk-(?:live|test)-|sk_|pk_(?:live|test)_|gh[pousr]_|github_pat_|glpat-|xox[baprs]-|dop_v1_|dpl_|rk_|sbp_)[A-Za-z0-9_=-]{12,}\b/gi, REDACTED);

  out = out.replace(
    /\b[A-Za-z0-9+/_=-]{64,}\b/g,
    (token: string, offset: number, source: string) => redactOpaqueToken(token, offset, source),
  );
  if (knownSecretValues === null) {
    // Longest first: when one secret value is a prefix of another, the
    // longer one must win or its suffix would stay exposed. One compiled
    // alternation replaces them in a single pass — the emit path runs this
    // on every event string, so a per-value split/join loop on large tool
    // results would block the event loop.
    knownSecretValues = [...new Set(collectKnownSecretValues())].sort((a, b) => b.length - a.length);
    knownSecretMatcher = knownSecretValues.length
      ? new RegExp(knownSecretValues.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
      : null;
  }
  if (knownSecretMatcher) out = out.replace(knownSecretMatcher, REDACTED);
  return out.replaceAll(REDACTED_SENTINEL, REDACTED);
}

/** Deep redaction of one stored value (an event, a tool result, a message):
 * every string field passes the secret redaction, so a printed key never
 * lands wherever this value is stored or shown. Numbers, booleans, and the
 * object's shape are untouched; strings inside arrays and nested objects
 * are redacted too. */
export function redactEventSecrets<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => redactEventSecrets(item)) as unknown as T;
  if (value && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    // Non-plain objects (Dates, Buffers, class instances) keep their shape:
    // they have no string fields to redact this way, and JSON.stringify
    // handles them itself. A null-prototype result object plus a skipped
    // __proto__ key means a hostile JSON-echoed field can never reassign the
    // prototype.
    if (proto !== Object.prototype && proto !== null) return value;
    const out = Object.create(null) as Record<string, unknown>;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // A JSON-echoed own "__proto__" key stays: on this null-prototype
      // receiver the assignment creates an ordinary own property (no
      // inherited setter exists to hijack), and dropping it would lose data.
      out[k] = redactEventSecrets(v);
    }
    return out as unknown as T;
  }
  return value;
}
