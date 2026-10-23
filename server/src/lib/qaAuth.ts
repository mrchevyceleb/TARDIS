// Tester sign-in for the private QA board. A tester opens a signed link for
// their login and the browser exchanges it for an HttpOnly session cookie.
// The link is deliberately not a plain caller-supplied header: it is signed
// with a deployment secret, contains no personal data beyond the configured
// tester login, and expires quickly. Sessions use a random server-side
// nonce so a copied link cannot be repurposed later than its short lifetime.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from '../config.ts';
import { qaTesterByLogin, qaTesterLogin, type QaTesterId } from './qaBoard.ts';

// Testers reach the board from outside the tailnet through the public QA
// gateway (Matt, Oct 23 2026), so a link has to survive being handed over in
// a meeting or a DM, and a session has to survive TARDIS restarts. Links
// stay single-use; sessions and spent link nonces are kept on disk.
const LINK_TTL_MS = 7 * 24 * 60 * 60_000;
export const QA_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const COOKIE_NAME = 'rivendell_qa_session';
const STORE_PATH = join(STATE_DIR, 'qa-sessions.json');
const sessions = new Map<string, { tester: QaTesterId; expiresAt: number }>();
const consumedLinkNonces = new Map<string, number>();

function loadStore(): void {
  try {
    const raw = JSON.parse(readFileSync(STORE_PATH, 'utf8')) as {
      sessions?: Record<string, { tester: QaTesterId; expiresAt: number }>;
      consumed?: Record<string, number>;
    };
    const now = Date.now();
    for (const [nonce, s] of Object.entries(raw.sessions ?? {})) {
      if (s && typeof s.tester === 'string' && Number(s.expiresAt) > now) sessions.set(nonce, { tester: s.tester, expiresAt: Number(s.expiresAt) });
    }
    for (const [nonce, at] of Object.entries(raw.consumed ?? {})) {
      if (Number(at) + LINK_TTL_MS > now) consumedLinkNonces.set(nonce, Number(at));
    }
  } catch { /* first run, or an unreadable file: start empty */ }
}
loadStore();

/** Write-through, atomic: a crash mid-write never leaves a torn file, and a
 *  spent link nonce is on disk before its session cookie is handed out. */
function saveStore(): void {
  const body = JSON.stringify({ sessions: Object.fromEntries(sessions), consumed: Object.fromEntries(consumedLinkNonces) });
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${STORE_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600 });
  renameSync(tmp, STORE_PATH);
}

function signingSecret(): string {
  return process.env.RIVENDELL_QA_AUTH_SECRET?.trim() ?? '';
}

function signature(payload: string): string {
  return createHmac('sha256', signingSecret()).update(payload).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function pruneSessions(now = Date.now()): void {
  for (const [nonce, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(nonce);
  }
}

export function qaAuthConfigured(): boolean {
  return Boolean(signingSecret());
}

/** Build the one-time sign-in path an operator gives a tester. The URL carries
 *  the configured tester login and a single-use nonce rather than an agent
 *  identity; the signature is what grants access, and the first successful
 *  exchange consumes the nonce, so a copied link mints exactly one session.
 *  Returning the path (not a personal URL in code) keeps deployment hostnames
 *  and identities out of the repository. */
export function qaSignInPath(tester: QaTesterId, now = Date.now()): string | null {
  const login = qaTesterLogin(tester)?.trim();
  if (!login || !qaAuthConfigured()) return null;
  if (!qaTesterByLogin(login)) return null;
  const expiresAt = now + LINK_TTL_MS;
  const nonce = randomBytes(12).toString('base64url');
  const payload = `${encodeURIComponent(login)}.${nonce}.${expiresAt}`;
  return `/qa-signin?d=${payload}&s=${signature(payload)}`;
}

export function verifyQaSignIn(data: string, suppliedSignature: string, now = Date.now()): QaTesterId | null {
  if (!qaAuthConfigured() || !data || !suppliedSignature) return null;
  if (!safeEqual(suppliedSignature, signature(data))) return null;
  const tail = data.lastIndexOf('.');
  if (tail <= 0) return null;
  const expiresAt = Number(data.slice(tail + 1));
  if (!Number.isFinite(expiresAt) || expiresAt < now || expiresAt > now + LINK_TTL_MS + 1_000) return null;
  const rest = data.slice(0, tail);
  const nonceDot = rest.lastIndexOf('.');
  if (nonceDot <= 0) return null;
  const nonce = rest.slice(nonceDot + 1);
  if (!nonce) return null;
  for (const [used, usedAt] of consumedLinkNonces) {
    if (usedAt + LINK_TTL_MS <= now) consumedLinkNonces.delete(used);
  }
  if (consumedLinkNonces.has(nonce)) return null;
  let login: string;
  try {
    login = decodeURIComponent(rest.slice(0, nonceDot));
  } catch {
    return null;
  }
  const tester = qaTesterByLogin(login) ?? null;
  if (!tester) return null;
  consumedLinkNonces.set(nonce, now);
  saveStore();
  return tester;
}

/** Operator identity under a private reverse proxy. Tailscale Serve forwards
 *  every tailnet user to this loopback server, so a loopback socket alone
 *  proves only that the request came through the proxy, not that it is the
 *  operator. Serve stamps the caller's tailnet login on each request; plain
 *  local Chrome sends no such header. */
export type QaForwardedIdentity = { tailscaleUser?: string; xForwardedFor?: string };

/** Operator identity. `requestTrusted` is the Host/Origin guard from
 *  origin.ts (trustedRequestOrigin): a bare-loopback request with no proxy
 *  identity is the operator's own browser, and it only counts when the
 *  request itself proves it was addressed to this server by that browser.
 *  Without the guard, any web page on the operator's machine could reach
 *  loopback and DNS-rebind into operator powers (read every column, issue
 *  sign-in links, land and move cards). */
export function qaIsOperator(
  headers: QaForwardedIdentity,
  remoteAddress: string | undefined,
  operatorLogin: string | undefined,
  requestTrusted = false,
): boolean {
  const remote = remoteAddress ?? '';
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  if (!loopback) return false;
  // A tailnet login header is the proxied caller's identity: only the
  // configured operator login is the operator (Tailscale Serve sets this
  // header, and a direct local browser never sends it, so it also cannot be
  // spoofed by a proxied tester, whose real login is stamped instead).
  const ts = (headers.tailscaleUser ?? '').trim().toLowerCase();
  if (ts) {
    const op = (operatorLogin ?? '').trim().toLowerCase();
    return Boolean(op) && ts === op;
  }
  // No tailnet identity: a proxy that forwards headers without an identity
  // (a generic reverse proxy) is not the operator; plain local Chrome, which
  // sends neither header, is, provided Host/Origin check out.
  if (headers.xForwardedFor) return false;
  return requestTrusted;
}

export function createQaSession(tester: QaTesterId, now = Date.now()): string {
  pruneSessions(now);
  const nonce = randomBytes(32).toString('base64url');
  sessions.set(nonce, { tester, expiresAt: now + QA_SESSION_MAX_AGE_SECONDS * 1000 });
  saveStore();
  return nonce;
}

export function qaSessionCookie(nonce: string): string {
  return `${COOKIE_NAME}=${encodeURIComponent(nonce)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${QA_SESSION_MAX_AGE_SECONDS}`;
}

export function clearQaSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function cookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) {
      try { return decodeURIComponent(rest.join('=')); } catch { return rest.join('='); }
    }
  }
  return undefined;
}

export function qaSessionTester(cookieHeader: string | undefined, now = Date.now()): QaTesterId | null {
  const nonce = cookieValue(cookieHeader, COOKIE_NAME);
  if (!nonce) return null;
  const session = sessions.get(nonce);
  if (!session) return null;
  if (session.expiresAt <= now) {
    sessions.delete(nonce);
    saveStore();
    return null;
  }
  return session.tester;
}

export function clearQaSession(cookieHeader: string | undefined): void {
  const nonce = cookieValue(cookieHeader, COOKIE_NAME);
  if (nonce && sessions.delete(nonce)) saveStore();
}
