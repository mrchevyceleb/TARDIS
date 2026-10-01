// Copies one site's login from the desktop browser profile into a lane's
// headless profile: cookies (decrypted here, handed straight to Playwright) and
// localStorage (read through a throwaway Chromium on a copy of the profile's
// leveldb). Values are never logged, returned or written anywhere but the lane's
// own 0700 profile; callers only ever see counts and host names.

import { chromium } from 'playwright-core';
import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface ImportedCookie {
  name: string; value: string; domain: string; path: string; expires: number;
  httpOnly: boolean; secure: boolean; sameSite?: 'Strict' | 'Lax' | 'None';
}
export interface ImportSummary {
  domains: string[];
  cookies: ImportedCookie[];
  cookieHosts: string[];
  localStorage: { origin: string; items: [string, string][] }[];
  skipped: { cookies: number; localStorageValues: number };
}

const MAX_DOMAINS = 5;
const MAX_ORIGINS = 12;
const MAX_ITEMS_PER_ORIGIN = 200;
const MAX_VALUE_BYTES = 256 * 1024;
// Session cookies would be dropped when an idle lane closes; keep them as 14-day cookies.
const SESSION_COOKIE_SECONDS = 14 * 24 * 3600;
const CHROMIUM_EPOCH_OFFSET = 11_644_473_600;

/** Where the desktop browser keeps its profile. Override with RIVENDELL_DESKTOP_PROFILE. */
function profileCandidates(): string[] {
  const override = process.env.RIVENDELL_DESKTOP_PROFILE?.trim();
  if (override) return [override];
  return [
    join(homedir(), 'snap', 'chromium', 'common', 'chromium', 'Default'),
    join(homedir(), '.config', 'chromium', 'Default'),
    join(homedir(), '.config', 'google-chrome', 'Default'),
  ];
}

function validateDomains(input: unknown): string[] {
  if (!Array.isArray(input) || !input.length) throw new Error('domains is required: a list like ["example.com"]. Importing every site is not allowed.');
  const out = new Set<string>();
  for (const raw of input) {
    const domain = String(raw ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^\./, '');
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain) || /^\d+(\.\d+){3}$/.test(domain)) {
      throw new Error(`"${String(raw).slice(0, 80)}" is not a site domain. Use something like app.example.com.`);
    }
    out.add(domain);
  }
  if (out.size > MAX_DOMAINS) throw new Error(`At most ${MAX_DOMAINS} domains per import.`);
  return [...out];
}

const matches = (host: string, domains: string[]) => domains.some((d) => host === d || host.endsWith(`.${d}`));

function secretToolPassword(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('secret-tool', ['lookup', 'application', 'chromium'], { timeout: 5000 }, (err, stdout) => resolve(err || !stdout.trim() ? null : stdout.trim()));
  });
}

const PEANUTS_KEY = pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1');
let keychainKey: Promise<Buffer | null> | null = null;
const v11Key = () => (keychainKey ??= secretToolPassword().then((pw) => (pw ? pbkdf2Sync(pw, 'saltysalt', 1, 16, 'sha1') : null)));

async function decryptCookie(encrypted: Uint8Array, hostKey: string): Promise<string | null> {
  const buf = Buffer.from(encrypted);
  const tag = buf.subarray(0, 3).toString('latin1');
  const key = tag === 'v10' ? PEANUTS_KEY : tag === 'v11' ? await v11Key() : null;
  if (!key) return null;
  let plain: Buffer;
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    plain = Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()]);
  } catch { return null; }
  // Newer Chromium prefixes the value with SHA-256(host_key).
  if (plain.length >= 32 && plain.subarray(0, 32).equals(createHash('sha256').update(hostKey).digest())) plain = plain.subarray(32);
  return plain.toString('utf8');
}

function cookieDbFor(profile: string): string | null {
  return [join(profile, 'Cookies'), join(profile, 'Network', 'Cookies')].find((p) => existsSync(p)) ?? null;
}

async function readCookies(profile: string, domains: string[]): Promise<{ cookies: ImportedCookie[]; skipped: number } | null> {
  const dbPath = cookieDbFor(profile);
  if (!dbPath) return null;
  const tmp = await mkdtemp(join(tmpdir(), 'rv-cookies-')); // 0700
  try {
    const copy = join(tmp, 'Cookies');
    await copyFile(dbPath, copy); await chmod(copy, 0o600);
    for (const ext of ['-wal', '-shm']) if (existsSync(dbPath + ext)) { await copyFile(dbPath + ext, copy + ext); await chmod(copy + ext, 0o600); }
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      // Chromium stores microsecond times that overflow a JS number, so read integers as BigInt.
      const stmt = db.prepare('SELECT * FROM cookies');
      stmt.setReadBigInts(true);
      const rows = stmt.all() as Record<string, unknown>[];
      const now = Date.now() / 1000;
      const cookies: ImportedCookie[] = [];
      let skipped = 0;
      for (const row of rows) {
        const hostKey = String(row.host_key ?? '');
        if (!matches(hostKey.replace(/^\./, ''), domains)) continue;
        if (row.top_level_site) { skipped++; continue; } // partitioned third-party cookie
        let value = typeof row.value === 'string' ? row.value : '';
        const encrypted = row.encrypted_value as Uint8Array | undefined;
        if (!value && encrypted?.length) value = (await decryptCookie(encrypted, hostKey)) ?? '';
        const expiresUtc = typeof row.expires_utc === 'bigint' ? row.expires_utc : BigInt(Number(row.expires_utc) || 0);
        const hasExpiry = Number(row.has_expires) === 1 && expiresUtc > 0n;
        const expires = hasExpiry ? Number(expiresUtc / 1_000_000n) - CHROMIUM_EPOCH_OFFSET : now + SESSION_COOKIE_SECONDS;
        if (!value || (hasExpiry && expires < now)) { skipped++; continue; }
        const sameSite = ({ 0: 'None', 1: 'Lax', 2: 'Strict' } as Record<number, ImportedCookie['sameSite']>)[Number(row.samesite)];
        cookies.push({
          name: String(row.name), value, domain: hostKey, path: String(row.path || '/'), expires: Math.floor(expires),
          httpOnly: Number(row.is_httponly) === 1, secure: Number(row.is_secure) === 1,
          ...(sameSite && (sameSite !== 'None' || Number(row.is_secure) === 1) ? { sameSite } : {}),
        });
      }
      return { cookies, skipped };
    } finally { db.close(); }
  } finally { await rm(tmp, { recursive: true, force: true }); }
}

type StorageResult = { origin: string; items: [string, string][] }[];

let storageRead: Promise<unknown> = Promise.resolve();
/** Reads localStorage for the given origins out of a copy of the desktop leveldb,
 *  using a short-lived Chromium (the format is Chromium's own). One at a time. */
function readLocalStorage(profile: string, origins: string[]): Promise<{ result: StorageResult; skipped: number }> {
  const run = storageRead.then(async () => {
    const src = join(profile, 'Local Storage', 'leveldb');
    if (!existsSync(src) || !origins.length) return { result: [] as StorageResult, skipped: 0 };
    const tmp = await mkdtemp(join(tmpdir(), 'rv-storage-')); // 0700
    try {
      const dst = join(tmp, 'Default', 'Local Storage', 'leveldb');
      await mkdir(dst, { recursive: true, mode: 0o700 });
      for (const name of await readdir(src)) {
        if (name === 'LOCK') continue;
        await copyFile(join(src, name), join(dst, name)); await chmod(join(dst, name), 0o600);
      }
      const ctx = await chromium.launchPersistentContext(tmp, { headless: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
      try {
        const page = ctx.pages()[0] ?? await ctx.newPage();
        const cdp = await ctx.newCDPSession(page);
        await cdp.send('DOMStorage.enable');
        const result: StorageResult = [];
        let skipped = 0;
        for (const origin of origins) {
          let raw: [string, string][] = [];
          try {
            raw = (await cdp.send('DOMStorage.getDOMStorageItems', { storageId: { securityOrigin: origin, isLocalStorage: true } })).entries as [string, string][];
          } catch {
            try { raw = (await cdp.send('DOMStorage.getDOMStorageItems', { storageId: { storageKey: `${origin}/`, isLocalStorage: true } })).entries as [string, string][]; } catch { raw = []; }
          }
          const items = raw.filter(([, v]) => { const ok = Buffer.byteLength(v) <= MAX_VALUE_BYTES; if (!ok) skipped++; return ok; }).slice(0, MAX_ITEMS_PER_ORIGIN);
          if (items.length) result.push({ origin, items });
        }
        return { result, skipped };
      } finally { await ctx.close().catch(() => {}); }
    } finally { await rm(tmp, { recursive: true, force: true }); }
  });
  storageRead = run.catch(() => {});
  return run;
}

export async function importDesktopSession(domainsInput: unknown): Promise<ImportSummary> {
  const domains = validateDomains(domainsInput);
  let found: { profile: string; cookies: ImportedCookie[]; skipped: number } | null = null;
  for (const profile of profileCandidates()) {
    const read = await readCookies(profile, domains).catch(() => null);
    if (read?.cookies.length) { found = { profile, ...read }; break; }
  }
  const profile = found?.profile ?? profileCandidates().find((p) => existsSync(join(p, 'Local Storage', 'leveldb')));
  if (!profile) throw new Error('No desktop browser profile found on this host.');
  const cookies = found?.cookies ?? [];
  const cookieHosts = [...new Set(cookies.map((c) => c.domain))].sort();
  const origins = new Set<string>();
  for (const d of domains) { origins.add(`https://${d}`); origins.add(`https://www.${d}`); }
  for (const host of cookieHosts) origins.add(`https://${host.replace(/^\./, '')}`);
  const storage = await readLocalStorage(profile, [...origins].slice(0, MAX_ORIGINS)).catch(() => ({ result: [] as StorageResult, skipped: 0 }));
  if (!cookies.length && !storage.result.length) {
    throw new Error(`Nothing to import for ${domains.join(', ')}: the desktop browser has no saved login for it. Ask the person to sign in once on the desktop, then import again.`);
  }
  return { domains, cookies, cookieHosts, localStorage: storage.result, skipped: { cookies: found?.skipped ?? 0, localStorageValues: storage.skipped } };
}
