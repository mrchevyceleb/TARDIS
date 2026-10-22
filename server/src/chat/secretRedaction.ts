/** Deterministic last line of defence before conversation text becomes durable
 * compact memory or leaves the box for the RAG index. This intentionally keeps
 * service/account names while replacing credential values. */

const REDACTED = '[redacted secret]';
/** A secret-word name followed by a dimension word is a config field, not a
 *  credential: INPUT_TOKEN_COUNT, MAX_TOKEN_LIMIT, RATE_LIMIT_SECRET_PATH.
 *  Matched against the prefix tail so these lines are never masked (the
 *  unquoted rule would otherwise erase the whole remainder of the line). */
const DIMENSION_WORD = /COUNT|LIMIT|SIZE|WIDTH|HEIGHT|LENGTH|URL|URI|ORIGIN|HOST|PORT|NAME|TITLE|PATH|DIR|PREFIX|SUFFIX|TTL|TIMEOUT|ID|IDS|VERSION|TYPE|MODE|FORMAT|LABEL|TAG|FLAG|DEBUG|RETRIES?|NUM|CAP|BUDGET|WINDOW|EXPIRY|EXPIRES|AT|ON|IN|OF/;
/** Segments that make a secret-word segment read as a config field rather
 *  than a credential: INPUT_TOKEN_COUNT, MAX_TOKEN_LIMIT,
 *  RATE_LIMIT_SECRET_PATH, PASSWORD_EXPIRY_DAYS. Compared as whole segments
 *  only: a substring test let ON inside SESSION, AT inside DATABASE/ADMIN
 *  and EXPIRY inside PASSWORD_EXPIRY exempt real credentials such as
 *  DATABASE_PASSWORD and SESSION_SECRET (Oct 22). Generic connectors
 *  (AT, ON, IN, OF) never count: SIGN_IN_PASSWORD and ON_CALL_SECRET are
 *  credentials, not config fields. */
const DIMENSION_SEGMENTS = new Set(['COUNT', 'TOTAL', 'LIMIT', 'SIZE', 'WIDTH', 'HEIGHT', 'LENGTH', 'NAME', 'TITLE', 'PATH', 'DIR', 'PREFIX', 'SUFFIX', 'TTL', 'TIMEOUT', 'ID', 'IDS', 'VERSION', 'TYPE', 'MODE', 'FORMAT', 'LABEL', 'TAG', 'FLAG', 'DEBUG', 'RETRY', 'RETRIES', 'NUM', 'CAP', 'BUDGET', 'WINDOW', 'EXPIRY', 'EXPIRES', 'EXPIRE', 'DAYS', 'MIN', 'MAX', 'POLICY', 'ENABLED', 'DISABLED', 'ROTATION_DAYS', 'REQUIRE', 'REQUIRED', 'SPECIAL', 'CHAR', 'CHARS', 'POLICY_ROTATION_DAYS', 'HISTORY', 'DEPTH', 'HASH_ALGORITHM']);
/** Every single segment the env/JSON name rules can match as the secret
 *  word, API + KEY(S) being the compound form glued from two segments. */
const SECRET_SEGMENTS = new Set(['KEY', 'KEYS', 'TOKEN', 'TOKENS', 'SECRET', 'SECRETS', 'PASSWORD', 'PASSWORDS', 'PASSWD', 'PASSCODE', 'PASS', 'PWD', 'COOKIE', 'COOKIES', 'CREDENTIAL', 'CREDENTIALS']);

/** camelCase guard for the JSON-name rule ("databasePassword", "apiKey",
 *  "clientSecret"): split into snake segments and mask only when the last
 *  segment is a secret word. Bare "tokenCount"/"passwordExpiryDays" end in
 *  dimension segments, so they never match. */
const CAMEL_SECRET_RE = /(?:^|_)(?:api_key|key|keys|token|tokens|secret|secrets|password|passwords|passwd|passcode|pass|pwd|cookie|cookies|credential|credentials)$/;
function camelSecretName(name: string): boolean {
  const normalized = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2');
  return CAMEL_SECRET_RE.test(normalized.toLowerCase());
}

/** A name only counts as a config field when EVERY secret segment of the
 *  name sits next to a whole dimension segment, on either side
 *  (TOKEN_COUNT/COUNT_TOKEN, SECRET_PATH, URL_SECRET, PASSWORD_EXPIRY_DAYS
 *  and INPUT_TOKEN_COUNT all stay readable), while DATABASE_PASSWORD and
 *  SESSION_SECRET have no dimension neighbour anywhere and mask.
 *  Credential-carrying shape segments (URL, URI, ORIGIN, HOST, PORT) are
 *  deliberately NOT dimensions: HOST_PASSWORD is a credential, not a
 *  config field (Oct 22). The name regex can select any secret span of
 *  the name (its `[head_]` group is greedy but only ever consumes one
 *  segment, so the selected span is a secret segment with a head segment
 *  before it or nothing before it and a tail after it), and a value must
 *  never survive by riding one count-shaped span:
 *  TOKEN_COUNT_DATABASE_PASSWORD and DATABASE_PASSWORD_TOKEN_COUNT both
 *  stay unmasked credentials. Lowercase JSON names ("database_password")
 *  and camelCase ("databasePassword") reach this judge too, so segments
 *  are case-folded. The check is a bounded segment walk: no regex retries,
 *  linear on a long hostile name (the Oct 21 liveness fix stays). The
 *  trailing run is the name's own [A-Za-z0-9_]+ tail: the run the old
 *  end-anchored test measured after stripping quotes and separators, so
 *  TOKEN_COUNT_DATABASE_PASSWORD's run INCLUDES its PASSWORD and the
 *  segment judge decides the whole name rather than a truncated
 *  suffix. An empty prefix has no name to judge: never exempt. */
function isNonSecretName(prefix: string): boolean {
  let end = prefix.length;
  if (end === 0) return false;
  // Trailing quotes/brackets ARE the name boundary: not stripping the
  // closing quote leaves zero segments to judge and masks quoted config
  // names that their env equivalents keep readable.
  while (end > 0 && /[^A-Za-z0-9_]/.test(prefix[end - 1])) end--;
  let start = end;
  while (start > 0 && /[A-Za-z0-9_]/.test(prefix[start - 1])) start--;
  // Split the run into segments once (API + KEY(S) counts as one compound
  // segment; segments are uppercase-folded because lowercase JSON names go
  // through this judge too), then every secret segment must be glued to a
  // dimension segment on some side. A secret segment with no dimension
  // neighbour anywhere condemns the name: it masks. A bare ROTATION is
  // never a dimension (DATABASE_PASSWORD_ROTATION is a credential): only
  // the pair ROTATION_DAYS reads as a policy period, so the pair merges
  // into one virtual dimension segment before judging.
  const rawSegments = prefix.slice(start, end).toUpperCase().split('_');
  const segments: string[] = [];
  for (let i = 0; i < rawSegments.length; i++) {
    if (rawSegments[i] === 'ROTATION' && rawSegments[i + 1] === 'DAYS') {
      segments.push('ROTATION_DAYS');
      i++;
    } else if (rawSegments[i] === 'HASH' && rawSegments[i + 1] === 'ALGORITHM') {
      segments.push('HASH_ALGORITHM');
      i++;
    } else segments.push(rawSegments[i]);
  }
  let hasSecret = false;
  for (let i = 0; i < segments.length; i++) {
    const compound = segments[i] === 'API' && i + 1 < segments.length && (segments[i + 1] === 'KEY' || segments[i + 1] === 'KEYS');
    const len = compound ? 2 : SECRET_SEGMENTS.has(segments[i]) ? 1 : 0;
    if (!len) continue;
    hasSecret = true;
    const before = i > 0 ? segments[i - 1] : '';
    const after = i + len < segments.length ? segments[i + len] : '';
    if (!DIMENSION_SEGMENTS.has(before) && !DIMENSION_SEGMENTS.has(after)) return false;
    if (len === 2) i++;
  }
  return hasSecret;
}
const REDACTED_SENTINEL = 'RIVENDELL_REDACTED_SECRET_VALUE';

function preserveFence(value: string): string {
  if (value.startsWith('`') && value.endsWith('`')) return `\`${REDACTED}\``;
  if (value.startsWith('"') && value.endsWith('"')) return `"${REDACTED}"`;
  if (value.startsWith("'") && value.endsWith("'")) return `'${REDACTED}'`;
  return REDACTED;
}

/** A path segment that is itself an opaque credential run (a disguised
 *  secret must not ride the path exemption): pure hex 32+ (a digest or a
 *  token), or a long no-separator token-charset run (base64/base64url,
 *  URL-safe keys) carrying both cases. Plain lowercase path words, however
 *  long, stay paths; a dotted filename never reaches this charset test. */
function isOpaquePathSegment(segment: string): boolean {
  if (/^[0-9a-fA-F]{32,}$/.test(segment)) return true;
  return segment.length >= 32 && /^[A-Za-z0-9_+=-]+$/.test(segment) && /[a-z]/.test(segment) && /[A-Z]/.test(segment);
}

function redactOpaqueToken(token: string, offset: number, source: string): string {
  // A 64-char hex string is a credential unless nearby context positively
  // identifies a checksum/object digest. Ordinary 40-char Git SHAs never
  // reach this matcher; they remain useful references by default.
  const context = source.slice(Math.max(0, offset - 96), offset);
  if (/(?:\b(?:commit|sha(?:-?256)?|checksum|digest|git hash|object hash|revision|rev)\b\s*(?::|=|is|was|at)?\s*|\/commit\/)$/i.test(context)) {
    return token;
  }
  // A path, not a credential (Matt, Oct 15: Felix's Fangorn replies printed
  // file:///C:/... links as [redacted secret]). With a file-scheme attempt in
  // the context, only a real form keeps: file: plus two or more slashes and
  // an optional drive letter — the first landing's \/+ typo matched a literal
  // plus, so real file:/// links never kept, and a bogus form (file:/+C:/)
  // must not fall through to the bare drive rules below. Without any scheme
  // attempt, a bare drive prefix glued to a separator-leading token is
  // positively a filesystem path. Either way, no path segment may itself be
  // an opaque run (pure hex, or a long token-charset run with mixed case): a
  // credential disguised as a path still redacts. Everything else stays under
  // the opaque rule: an opaque URL path segment (https://host/<token>)
  // redacts by default, and a bare multi-segment run is more likely a base64
  // blob than a path.
  const tail = context.slice(-16);
  const schemeInTail = /file:/i.test(tail);
  const isFilePathPrefix = schemeInTail
    ? /file:\/{2,}\/?(?:[A-Za-z]:[\\/]?)?$/i.test(tail)
    : /^[A-Za-z]:[\\/]$/.test(tail.slice(-3)) || (/[A-Za-z]:$/.test(tail.slice(-2)) && /^[\\/]/.test(token));
  if (isFilePathPrefix && !token.split('/').some(isOpaquePathSegment)) {
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
    // Studio recorder links and handoff claim links (card-281af4): the secret
    // rides a named query parameter (?readyToken=, ?appId=, ?roomKey=) that
    // the exact-name rule above does not cover, or a path segment
    // (/handoff/claim/<value>, /warm-handoff-claims/<value>). The named
    // parameters also match bare in prose ("appId=..." quoted out of its
    // URL), never inside a longer word. The value runs to the URL's own hard
    // delimiter — &, #, whitespace, quote, backtick, angle bracket — so
    // nothing past the token is eaten, and the whole token is masked, never a
    // prefix of it. (review P1, Oct 20) The name decides regardless of
    // spelling style, because a short shapeless value has no shape rule to
    // fall back on: quoted (readyToken="…", appId='…'), spaced (roomKey = …),
    // and structured ("recorderToken":"…") forms all mask, so the separator
    // may be = or : with surrounding space and the name or value may carry
    // quotes; an unterminated quote still starts the value (a truncated
    // stream must not leak its tail). Trailing sentence punctuation belongs
    // to the prose, not the token (review P2): "appId=demo-client, then"
    // keeps its comma.
    .replace(
      /((?:[?&#]|(?<![\w-]))(?:"|')?(?:readyToken|appId|roomKey|recorderToken)(?:"|')?\s*[=:]\s*)("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|`(?:\\.|[^`\\\r\n])*`|["'`][^&#\s"'`<>]*|[^&#\s"'`<>]+)/gi,
      (_all, prefix: string, value: string) => {
        if (/^["'`]/.test(value)) return `${prefix}${preserveFence(value)}`;
        const trimmed = value.replace(/[.,;:!?)\]}]+$/, '');
        return `${prefix}${trimmed ? REDACTED : ''}${value.slice(trimmed.length)}`;
      },
    )
    .replace(
      /(\/(?:handoff\/claim|warm-handoff-claims)\/)([^\s/?#"'`<>]+)/gi,
      (_all, prefix: string, value: string) => {
        const trimmed = value.replace(/[.,;:!?)\]}]+$/, '');
        return `${prefix}${trimmed ? REDACTED : ''}${value.slice(trimmed.length)}`;
      },
    )
    .replace(/\b(Bearer|Basic)(\s+)[A-Za-z0-9._~+/=-]{8,}/gi, (_all, scheme: string, gap: string) => `${scheme}${gap}${REDACTED}`)
    // Linear on hostile names (Oct 21: one 358-underscore tool line froze the
    // event loop for good). The lookahead rejects a word with no "=" and value
    // after it before any name parsing, so a miss costs one scan instead of
    // one per keyword in the word, and the suffix is one optional `_…` run:
    // the old repeated `(?:_[A-Z0-9_]+)*` could split an underscore run 2^n
    // ways. Same matches as before.
    .replace(
      /(\b(?=[A-Z0-9_]+\s*=\s*[^\r\n])(?:[A-Z][A-Z0-9_]*_)?(?:API_KEY|API_KEYS|KEY|KEYS|TOKEN|TOKENS|SECRET|SECRETS|PASSWORD|PASSWORDS|PASSWD|PASSCODE|PASS|PWD|COOKIE|COOKIES|CREDENTIAL|CREDENTIALS)(?:_[A-Z0-9_]+)?\s*=\s*)(`[^`\r\n]+`|"(?:\\.|[^"\\\r\n])+"|'(?:\\.|[^'\\\r\n])+'|[^\r\n]+)/gi,
      (_all, prefix: string, value: string) => (isNonSecretName(prefix) ? _all : `${prefix}${preserveFence(value)}`),
    )
    // A value under a secret-shaped UPPERCASE name in JSON/YAML/JS object
    // form: quotes and a colon instead of "=". The env rule above needs "=",
    // so `"VERCEL_API_KEY": "abc"` slipped, and the value is masked by its
    // NAME here regardless of shape, so short shapeless tokens cannot slip
    // either. Bare single-word lowercase "key"/"token" names stay readable
    // on purpose (keyboard events, token counters); the compound lowercase
    // rule below still masks forms such as database_password, because a
    // lowercase JSON password field is a credential, not a keyboard event
    // (Oct 22 verifier finding).
    // The unquoted form masks the whole remainder of the line, like the
    // header rule: a secret-named YAML scalar can be a multi-word passphrase
    // ("PASSWORD: correct horse battery staple") and token-shape matching
    // would leak most of it. Same lookahead and one-run suffix as the rule
    // above.
    .replace(
      /(\b(?=[A-Z0-9_]+["']?\s*:\s*[^\r\n])(?:[A-Z][A-Z0-9_]*_)?(?:API_KEY|API_KEYS|KEY|KEYS|TOKEN|TOKENS|SECRET|SECRETS|PASSWORD|PASSWORDS|PASSWD|PASSCODE|PASS|PWD|COOKIE|COOKIES|CREDENTIAL|CREDENTIALS)(?:_[A-Z0-9_]+)?["']?\s*:\s*)(`[^`\r\n]+`|"(?:\\.|[^"\\\r\n])+"|'(?:\\.|[^'\\\r\n])+'|[^\r\n]+)/g,
      (_all, prefix: string, value: string) => (isNonSecretName(prefix) ? _all : `${prefix}${preserveFence(value)}`),
    )
    // Compound lowercase names in JSON/colon form (database_password,
    // db_password, api_key_v2, access_token, auth_cookie) are credentials,
    // so their values mask by name (Oct 22 findings). Bare single-word
    // lowercase key/token names stay readable on purpose (keyboard events,
    // token counters); single-word password/secret/pwd names mask through
    // the prose rules below. The name has 2+ segments with the secret word
    // as the final segment (a trailing segment after it, API_KEY_V2
    // included, is part of the credential name; isNonSecretName judges
    // it). Quoted and bare names both reach the colon: the name pattern
    // closes on the quote when one is present.
    .replace(
      /((?:^|[{,\["'])\s*"?[a-z][a-z0-9]*(?:_[a-z0-9]+)*?_(?:api_key|key|keys|token|tokens|secret|secrets|password|passwords|passwd|passcode|pass|pwd|cookie|cookies|credential|credentials)(?:_[a-z0-9]+)?"?\s*:\s*)(`[^`\r\n]+`|"(?:\\.|[^"\\\r\n])+"|'(?:\\.|[^'\\\r\n])+'|[^\r\n,\\]+)/g,
      (_all, prefix: string, value: string) => (isNonSecretName(prefix) ? _all : `${prefix}${preserveFence(value)}`),
    )
    // camelCase JSON names ("databasePassword", "apiKey", "clientSecret"):
    // the value masks by name, gated by isNonSecretName's credential tests.
    .replace(
      /(("[a-z][A-Za-z0-9]*?[A-Z][A-Za-z0-9]*?)"\s*:\s*)(`[^`\r\n]+`|"(?:\\.|[^"\\\r\n])+"|'(?:\\.|[^'\\\r\n])+'|[^\r\n,\\]+)/g,
      (_all, prefix: string, name: string, value: string) => {
        if (isNonSecretName(prefix)) return _all;
        return camelSecretName(name) ? `${prefix}${preserveFence(value)}` : _all;
      },
    )
    .replace(
      /(\b(?:password|passcode|passwd|pwd|api[_ -]?key|access[_ -]?token|auth(?:entication|orization)?[_ -]?token|bearer token|client[_ -]?secret|refresh[_ -]?token|private[_ -]?key|credential|cookie|session token|otp|one[- ]time (?:password|code)|verification code|recovery code)\b[^:\r\n=]{0,80}(?::|=)\s*)(`(?:\\.|[^`\\\r\n])+`|"(?:\\.|[^"\\\r\n])+"|'(?:\\.|[^'\\\r\n])+'|[^\s,;]+)/gi,
      (_all, prefix: string, value: string) => `${prefix}${preserveFence(value)}`,
    )
    .replace(
      /(\b(?:password|passcode|passwd|pwd|api[_ -]?key|access[_ -]?token|auth(?:entication|orization)?[_ -]?token|bearer token|client[_ -]?secret|refresh[_ -]?token|private[_ -]?key|credential|session token|otp|one[- ]time (?:password|code)|verification code|recovery code)\b\s+(?:is|was)\s+)(`(?:\\.|[^`\\\r\n])+`|"(?:\\.|[^"\\\r\n])+"|'(?:\\.|[^'\\\r\n])+'|[^\s,;]+)/gi,
      (_all, prefix: string, value: string) => `${prefix}${preserveFence(value)}`,
    )
    // A CLI flag starts on its own: the dashes must not be glued to a
    // preceding word, or the rule eats the following word as a "value"
    // (Oct 14 false positive: "8,000-token budget" was masked as a printed
    // key). Both flag styles are kept (-token=x, --token x) — only glued
    // compounds ("8,000-token cap", "café-token budget") are refused. The
    // boundary is Unicode-aware (\w is ASCII-only): letters, digits, marks
    // (combining accents, composed or decomposed), and join controls all
    // block it.
    .replace(
      /((?<![\p{L}\p{N}\p{M}_\u200C\u200D-])--?(?:(?:api-?)?key|token|secret|password))(=|\s+)(`(?:\\.|[^`\\\r\n])+`|"(?:\\.|[^"\\\r\n])+"|'(?:\\.|[^'\\\r\n])+'|[^\s,;]+)/giu,
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

/** Oct 15 spill guard: a credential chunked mid-value across adjacent array
 *  elements (two tool-result text blocks split one Mongo URI mid-password)
 *  stayed in cleartext as fragments, because every element was scanned alone
 *  and no fragment matched a rule on its own. Adjacent plain objects with
 *  identical key sets and a string `text` field in each are the chunked-run
 *  shape: mask the concatenated text and compare against per-element masking.
 *  A difference means a rule matched across the join, so the run collapses to
 *  one element carrying the masked concatenation: the secret never persists
 *  as halves, and the masked evidence (scheme, user, host) survives exactly
 *  like the old whole-line pass, without ever eating JSON structure. Only a
 *  run whose non-text fields are all identical collapses, so no other shape
 *  is lost. String arrays are deliberately not joined: a list of values is
 *  not one chunked string, and joining list elements would false-positive on
 *  adjacent opaque digests. */
function chunkedSecretCollapse(items: unknown[]): unknown[] | null {
  if (items.length < 2) return null;
  for (const it of items) {
    if (!(it && typeof it === 'object' && !Array.isArray(it)
      && (Object.getPrototypeOf(it) === Object.prototype || Object.getPrototypeOf(it) === null)
      && typeof (it as Record<string, unknown>).text === 'string')) return null;
  }
  const shapes = new Set(items.map((it) => Object.keys(it as object).sort().join(',')));
  if (shapes.size !== 1) return null;
  const raw = items.map((it) => (it as Record<string, unknown>).text as string);
  const maskedConcat = redactSecrets(raw.join(''));
  if (maskedConcat === raw.map((s) => redactSecrets(s)).join('')) return null;
  const nonText = items.map((it) => {
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(it as Record<string, unknown>)) if (k !== 'text') rest[k] = v;
    return JSON.stringify(rest, Object.keys(rest).sort());
  });
  if (new Set(nonText).size !== 1) return null;
  const first = redactEventSecrets(items[0]) as Record<string, unknown>;
  first.text = maskedConcat;
  return [first];
}

/** Deep redaction of one stored value (an event, a tool result, a message):
 * every string field passes the secret redaction, so a printed key never
 * lands wherever this value is stored or shown. Numbers, booleans, and the
 * object's shape are untouched; strings inside arrays and nested objects
 * are redacted too. */
export function redactEventSecrets<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value) as unknown as T;
  if (Array.isArray(value)) {
    const collapsed = chunkedSecretCollapse(value as unknown[]);
    if (collapsed) return collapsed as unknown as T;
    return value.map((item) => redactEventSecrets(item)) as unknown as T;
  }
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

/** Structure-safe final pass for one serialized JSON line (Oct 15). The
 *  serialized-line pass used to run redactSecrets over the whole line, and a
 *  credential chunked across adjacent JSON fields (a Mongo connection string
 *  split mid-password across two tool-result content blocks, Oct 15 6:11am)
 *  let a value class eat the `","` structure between the fields, leaving one
 *  broken-JSON line in a hot log. This variant applies the same rules only
 *  inside each JSON string span, so no match can ever cross a field boundary
 *  or eat structural characters, and each span is masked on its decoded text
 *  so a token can never end up malformed: the durable line always still
 *  parses. A credential chunked across adjacent text blocks is collapsed by
 *  the deep walk's spill guard before serialization (chunkedSecretCollapse);
 *  other cross-field chunk shapes remain a fragment-level residual that
 *  belongs to the tool-result chunking boundary, not the mask. */
export function redactSerializedSecrets(line: string): string {
  if (!line) return line;
  let out = '';
  let last = 0;
  for (const m of line.matchAll(/"(?:\\.|[^"\\])*"/g)) {
    const idx = m.index ?? 0;
    out += line.slice(last, idx);
    out += maskStringToken(m[0]);
    last = idx + m[0].length;
  }
  return out + line.slice(last);
}

/** One JSON string token, masked on its decoded text (Oct 15 review): the
 *  rules are built for prose (real newlines, real quotes), and
 *  JSON.stringify re-escapes whatever the mask leaves, so the result is
 *  always a valid JSON string token — the escaped-content pass could split
 *  an escape sequence or match across escape boundaries. A token that fails
 *  to decode falls back to the escaped pass, which still redacts whole
 *  tokens: the mask must never split a credential at an escape boundary
 *  (Oct 22 review: "DATABASE_PASSWORD=\x…" split into two fragments, each
 *  non-matching, so the secret survived). This runs on the sync append path
 *  and must never throw. */
function maskStringToken(token: string): string {
  try {
    return JSON.stringify(redactSecrets(JSON.parse(token)));
  } catch {
    return '"' + redactSecrets(token.slice(1, -1)) + '"';
  }
}
