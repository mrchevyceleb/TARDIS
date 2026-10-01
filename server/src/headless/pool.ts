// Per-lane headless Chromium on the TARDIS host. Every lane gets its own
// persistent profile (logins survive), the pool is capped, and idle lanes are
// closed so web work never waits on whoever holds the desktop.

import { chromium, type BrowserContext, type Locator, type Page } from 'playwright-core';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFile, chmod, mkdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { STATE_DIR } from '../config.ts';
import { importDesktopSession, type ImportSummary } from './sessionImport.ts';

export const HEADLESS_DIR = process.env.RIVENDELL_HEADLESS_DIR?.trim() || join(STATE_DIR, 'headless');
// Only TARDIS-spawned MCPs may drive the pool, and each MCP's token is bound to
// its own lane: a token minted for Alex cannot open or reset Becca's browser.
// Lanes with no stable name (Banana, plain chats) hold the context token instead
// and name themselves with the signed turn context. Like the computer MCP token,
// this stops a console page or a mistaken call; it is not a sandbox between lanes
// that run as the same OS user.
const headlessSecret = randomBytes(32);
const CONTEXT_IDENTITY = '\0context';
const tokenFor = (identity: string) => createHmac('sha256', headlessSecret).update(`headless:${identity}`).digest('hex');
export const headlessLaneToken = (agent?: string) => tokenFor(agent?.trim() ? `lane:${agent.trim()}` : CONTEXT_IDENTITY);
export function validHeadlessToken(value: string | undefined, agent?: string): boolean {
  const got = Buffer.from(value ?? ''); const want = Buffer.from(headlessLaneToken(agent));
  return got.length === want.length && timingSafeEqual(got, want);
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, n)) : fallback;
}
const MAX_LANES = clampInt(process.env.RIVENDELL_HEADLESS_MAX_LANES, 6, 1, 20);
const IDLE_MS = clampInt(process.env.RIVENDELL_HEADLESS_IDLE_MINUTES, 10, 1, 240) * 60_000;
const EVICT_MIN_IDLE_MS = 60_000;
const MAX_TABS = 8;
const OP_DEADLINE_MS = 45_000;
const SNAPSHOT_MAX = 40_000;
const TEXT_MAX = 30_000;
const LOG_LINES = 40;
const SHOT_MAX_BYTES = 1_500_000;

interface Lane {
  agent: string;
  slug: string;
  ctx: BrowserContext;
  tabs: Map<string, Page>;
  ids: WeakMap<Page, string>;
  seq: number;
  current: string;
  lastUsed: number;
  busy: number;
  closing: boolean;
  dialogs: string[];
  logs: string[];
}

const lanes = new Map<string, Lane>();
const launching = new Map<string, Promise<Lane>>();
let launchChain: Promise<unknown> = Promise.resolve();
let sweeper: NodeJS.Timeout | null = null;

// The readable part is only a hint: the hash of the exact name keeps "Alex Smith" and "Alex-Smith" apart.
export function laneSlug(agent: string): string {
  const hint = agent.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'lane';
  return `${hint}-${createHash('sha256').update(agent).digest('hex').slice(0, 8)}`;
}

// One launch/close/reset at a time per profile, so a call arriving mid-close never starts a browser on an occupied
// profile and a reset never deletes a profile a newer browser already opened.
const slugLocks = new Map<string, Promise<unknown>>();
function exclusive<T>(slug: string, fn: () => Promise<T>): Promise<T> {
  const run = (slugLocks.get(slug) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  slugLocks.set(slug, tail);
  void tail.then(() => { if (slugLocks.get(slug) === tail) slugLocks.delete(slug); });
  return run;
}
const profileDir = (slug: string) => join(HEADLESS_DIR, slug, 'profile');
// Chromium drops session-only cookies (most logins) when a lane closes, so they are kept in a 0600 file beside the profile.
const sessionCookieFile = (slug: string) => join(HEADLESS_DIR, slug, 'session-cookies.json');
const SESSION_COOKIE_SECONDS = 14 * 24 * 3600;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n[truncated ${text.length - max} chars]` : text);

async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

/** A hard-killed server leaves Chromium's SingletonLock behind (and sometimes the
 *  browser itself). Clear the lock; kill the orphan only when its command line
 *  names this exact profile. */
async function clearStaleLock(dir: string): Promise<void> {
  let target: string;
  try { target = await readlink(join(dir, 'SingletonLock')); } catch { return; }
  const pid = Number(target.split('-').pop());
  if (Number.isInteger(pid) && pid > 1) {
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    if (alive) {
      const cmd = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
      if (!cmd.includes(dir)) throw new Error('This lane\'s profile is locked by another process. Ask Max to look.');
      try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
      await sleep(1500);
    }
  }
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) await rm(join(dir, name), { force: true });
}

function registerPage(lane: Lane, page: Page): string {
  const known = lane.ids.get(page);
  if (known) return known;
  const id = `t${++lane.seq}`;
  lane.ids.set(page, id);
  lane.tabs.set(id, page);
  if (!lane.current) lane.current = id;
  const note = (list: string[], line: string) => { list.push(line.slice(0, 300)); if (list.length > LOG_LINES) list.shift(); };
  page.on('dialog', (dialog) => { note(lane.dialogs, `${dialog.type()}: ${dialog.message()}`); void dialog.dismiss().catch(() => {}); });
  page.on('console', (msg) => { if (msg.type() === 'error') note(lane.logs, `console.error ${msg.text()}`); });
  page.on('pageerror', (err) => note(lane.logs, `pageerror ${err.message}`));
  page.on('requestfailed', (req) => note(lane.logs, `requestfailed ${req.method()} ${req.url().slice(0, 160)} ${req.failure()?.errorText ?? ''}`));
  page.on('close', () => {
    lane.tabs.delete(id);
    if (lane.current === id) lane.current = [...lane.tabs.keys()].pop() ?? '';
  });
  return id;
}

async function launchContext(dir: string): Promise<BrowserContext> {
  // No signal handlers: TARDIS owns teardown and closes the lanes itself.
  const base = { headless: true, viewport: { width: 1280, height: 800 }, acceptDownloads: false, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false } as const;
  try {
    // The full Chromium in new headless mode identifies as plain Chrome.
    return await chromium.launchPersistentContext(dir, { ...base, channel: 'chromium' });
  } catch (err) {
    if (!/Executable doesn't exist|not found/i.test((err as Error).message)) throw err;
    return chromium.launchPersistentContext(dir, base);
  }
}

async function stashSessionCookies(lane: Lane): Promise<void> {
  try {
    const session = (await lane.ctx.cookies()).filter((c) => c.expires === -1);
    const file = sessionCookieFile(lane.slug);
    if (!session.length) { await rm(file, { force: true }); return; }
    await writeFile(file, JSON.stringify(session), { mode: 0o600 });
    await chmod(file, 0o600);
  } catch { /* the lane is closing anyway; a missed stash only costs a re-login */ }
}

async function restoreSessionCookies(ctx: BrowserContext, slug: string): Promise<void> {
  const file = sessionCookieFile(slug);
  try {
    const cookies = JSON.parse(await readFile(file, 'utf8')) as Parameters<BrowserContext['addCookies']>[0];
    // Restored cookies become persistent ones in the profile, so the stash has done its job; leaving it would let an
    // old copy overwrite a newer login after a crash. A cookie the profile already holds is newer than the stash.
    const held = new Set((await ctx.cookies()).map((c) => `${c.domain}\t${c.path}\t${c.name}`));
    const expires = Math.floor(Date.now() / 1000) + SESSION_COOKIE_SECONDS;
    const fresh = cookies.filter((c) => !held.has(`${c.domain}\t${c.path}\t${c.name}`));
    if (fresh.length) await ctx.addCookies(fresh.map((c) => ({ ...c, expires })));
  } catch { /* no stash, or unreadable: start without it */ }
  await rm(file, { force: true });
}

async function closeLaneLocked(lane: Lane): Promise<void> {
  lane.closing = true;
  await stashSessionCookies(lane);
  await lane.ctx.close().catch(() => {});
  if (lanes.get(lane.slug) === lane) lanes.delete(lane.slug);
}
const closeLane = (lane: Lane) => exclusive(lane.slug, () => closeLaneLocked(lane));

async function launchLane(agent: string, slug: string): Promise<Lane> {
  while (lanes.size >= MAX_LANES) {
    const victim = [...lanes.values()]
      .filter((l) => l.busy === 0 && !l.closing && Date.now() - l.lastUsed >= EVICT_MIN_IDLE_MS)
      .sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (!victim) throw new Error(`The headless pool is full (${MAX_LANES} lanes, each used in the last minute). Retry in a minute.`);
    await closeLane(victim);
  }
  await ensurePrivateDir(HEADLESS_DIR);
  await ensurePrivateDir(join(HEADLESS_DIR, slug));
  const dir = profileDir(slug);
  await ensurePrivateDir(dir);
  await clearStaleLock(dir);
  const ctx = await launchContext(dir);
  await restoreSessionCookies(ctx, slug);
  ctx.setDefaultTimeout(15_000);
  ctx.setDefaultNavigationTimeout(30_000);
  const lane: Lane = { agent, slug, ctx, tabs: new Map(), ids: new WeakMap(), seq: 0, current: '', lastUsed: Date.now(), busy: 0, closing: false, dialogs: [], logs: [] };
  for (const page of ctx.pages()) registerPage(lane, page);
  ctx.on('page', (page) => {
    // A page can open windows without limit; past the cap they are closed on arrival.
    if (!lane.ids.has(page) && lane.tabs.size >= MAX_TABS) { void page.close().catch(() => {}); return; }
    registerPage(lane, page);
  });
  ctx.on('close', () => { lane.closing = true; if (lanes.get(slug) === lane) lanes.delete(slug); });
  lanes.set(slug, lane);
  sweeper ??= setInterval(() => void sweepIdle(), 60_000).unref();
  return lane;
}

async function acquire(agent: string): Promise<Lane> {
  const slug = laneSlug(agent);
  const live = lanes.get(slug);
  if (live && !live.closing) return live;
  const pending = launching.get(slug);
  if (pending) return pending;
  // Launches run one at a time so the cap check and the launch cannot interleave; each also waits out any close of its own profile.
  const run = launchChain.then(() => exclusive(slug, async () => {
    const live = lanes.get(slug);
    return live && !live.closing ? live : launchLane(agent, slug);
  }));
  launchChain = run.catch(() => {});
  launching.set(slug, run);
  try { return await run; } finally { launching.delete(slug); }
}

async function sweepIdle(): Promise<void> {
  const now = Date.now();
  for (const lane of [...lanes.values()]) {
    if (lane.busy === 0 && !lane.closing && now - lane.lastUsed >= IDLE_MS) await closeLane(lane);
  }
}

/** Graceful close so Chromium flushes cookies and storage to the profile. */
export async function closeAllHeadlessLanes(): Promise<void> {
  if (sweeper) { clearInterval(sweeper); sweeper = null; }
  await Promise.all([...lanes.values()].map((lane) => closeLane(lane)));
}

async function withLane<T>(agent: string, fn: (lane: Lane) => Promise<T>): Promise<T> {
  const lane = await acquire(agent);
  lane.busy++; lane.lastUsed = Date.now();
  try {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Headless call timed out after ${OP_DEADLINE_MS / 1000}s.`)), OP_DEADLINE_MS); });
    try { return await Promise.race([fn(lane), deadline]); } finally { clearTimeout(timer); }
  } finally { lane.busy--; lane.lastUsed = Date.now(); }
}

async function newTab(lane: Lane): Promise<{ id: string; page: Page }> {
  if (lane.tabs.size >= MAX_TABS) throw new Error(`Already ${MAX_TABS} tabs open. Close one with headless_tabs first.`);
  const page = await lane.ctx.newPage();
  const id = registerPage(lane, page);
  lane.current = id;
  return { id, page };
}

async function pageFor(lane: Lane, tab?: string): Promise<{ id: string; page: Page }> {
  if (tab) {
    const page = lane.tabs.get(tab);
    if (!page || page.isClosed()) throw new Error(`No tab ${tab}. Open tabs: ${[...lane.tabs.keys()].join(', ') || 'none'}.`);
    return { id: tab, page };
  }
  const page = lane.current ? lane.tabs.get(lane.current) : undefined;
  if (page && !page.isClosed()) return { id: lane.current, page };
  return newTab(lane);
}

async function stateOf(lane: Lane, id: string, page: Page): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { tab: id, url: page.url(), title: await page.title().catch(() => ''), tabs: lane.tabs.size };
  if (lane.dialogs.length) out.dialogsDismissed = lane.dialogs.splice(0);
  return out;
}

const settle = (page: Page) => page.waitForLoadState('domcontentloaded', { timeout: 2500 }).then(() => sleep(250)).catch(() => {});

function checkUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('url is required.');
  const text = raw.trim();
  const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https URLs can be opened.');
  return url.toString();
}

function locatorFor(page: Page, a: Record<string, unknown>): Locator {
  const given = ['ref', 'selector', 'text'].filter((k) => typeof a[k] === 'string' && (a[k] as string).length > 0);
  if (given.length !== 1) throw new Error('Pass exactly one of ref (from headless_snapshot), selector, or text.');
  if (typeof a.ref === 'string' && a.ref) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(a.ref)) throw new Error('ref must look like e12 (copy it from the latest headless_snapshot).');
    return page.locator(`aria-ref=${a.ref}`);
  }
  if (typeof a.selector === 'string' && a.selector) return page.locator(a.selector);
  return page.getByText(a.text as string).first();
}

function shortError(err: unknown): Error {
  const message = (err as Error)?.message ?? String(err);
  return new Error(message.split('\n').slice(0, 4).join(' ').slice(0, 500));
}

type Args = Record<string, unknown>;
export type HeadlessResult = Record<string, unknown> & { image?: { data: string; mimeType: string } };

async function audit(entry: Record<string, unknown>): Promise<void> {
  try {
    await ensurePrivateDir(HEADLESS_DIR);
    const file = join(HEADLESS_DIR, 'audit.jsonl');
    await appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
  } catch { /* the audit trail must not break the call */ }
}

function poolStatus(): HeadlessResult {
  const now = Date.now();
  return {
    limits: { maxLanes: MAX_LANES, idleMinutes: IDLE_MS / 60_000 },
    lanes: [...lanes.values()].map((l) => ({ agent: l.agent, tabs: l.tabs.size, idleSeconds: Math.round((now - l.lastUsed) / 1000), busy: l.busy > 0 })),
  };
}

async function seedLocalStorage(lane: Lane, origin: string, items: [string, string][]): Promise<void> {
  const page = await lane.ctx.newPage();
  try {
    await page.route('**/*', (route) => (route.request().url().startsWith(`${origin}/__rivendell_seed`)
      ? route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>seed</title>' })
      : route.abort()));
    await page.goto(`${origin}/__rivendell_seed`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((entries) => { for (const [key, value] of entries) localStorage.setItem(key, value); }, items);
  } finally { await page.close().catch(() => {}); }
}

async function sessionOp(agent: string, a: Args): Promise<HeadlessResult> {
  const action = String(a.action ?? 'status');
  if (action === 'status') return poolStatus();
  if (action === 'release') {
    const lane = lanes.get(laneSlug(agent));
    if (lane) await closeLane(lane);
    return { released: Boolean(lane) };
  }
  if (action === 'reset_profile') {
    const slug = laneSlug(agent);
    await exclusive(slug, async () => {
      const lane = lanes.get(slug);
      if (lane) await closeLaneLocked(lane);
      await rm(profileDir(slug), { recursive: true, force: true });
      await rm(sessionCookieFile(slug), { force: true });
    });
    await audit({ agent, op: 'reset_profile' });
    return { reset: true, note: 'This lane\'s headless profile is empty again. Every login in it is gone.' };
  }
  if (action !== 'import') throw new Error('action must be status, import, release or reset_profile.');
  const summary: ImportSummary = await importDesktopSession(a.domains);
  await withLane(agent, async (lane) => {
    if (summary.cookies.length) await lane.ctx.addCookies(summary.cookies);
    for (const entry of summary.localStorage) await seedLocalStorage(lane, entry.origin, entry.items);
  });
  await audit({ agent, op: 'import_session', domains: summary.domains, cookies: summary.cookies.length, localStorage: summary.localStorage.map((e) => ({ origin: e.origin, keys: e.items.length })) });
  return {
    imported: { domains: summary.domains, cookies: summary.cookies.length, cookieHosts: summary.cookieHosts, localStorage: summary.localStorage.map((e) => ({ origin: e.origin, keys: e.items.length })), skipped: summary.skipped },
    note: 'Values were copied into this lane\'s profile and never shown. Open the site with headless_navigate to confirm you are signed in. sessionStorage and IndexedDB are not copied.',
  };
}

/** One entry point for the /api/headless route. `agent` is the calling lane. */
export async function runHeadlessOp(op: string, agent: string, a: Args): Promise<HeadlessResult> {
  try {
    if (op === 'session') return await sessionOp(agent, a);
    return await withLane(agent, async (lane): Promise<HeadlessResult> => {
      if (op === 'tabs') {
        const action = String(a.action ?? 'list');
        if (action === 'switch' || action === 'close') {
          const { id, page } = await pageFor(lane, typeof a.tab === 'string' ? a.tab : undefined);
          if (action === 'close') await page.close();
          else { lane.current = id; await page.bringToFront().catch(() => {}); }
        } else if (action !== 'list') throw new Error('action must be list, switch or close.');
        const tabs = await Promise.all([...lane.tabs].map(async ([id, p]) => ({ tab: id, url: p.url(), title: await p.title().catch(() => ''), current: id === lane.current })));
        return { tabs };
      }
      if (op === 'console') {
        const lines = a.clear === false ? [...lane.logs] : lane.logs.splice(0);
        return { lines };
      }
      const { id, page } = op === 'navigate' && a.newTab === true ? await newTab(lane) : await pageFor(lane, typeof a.tab === 'string' ? a.tab : undefined);
      switch (op) {
        case 'navigate': {
          const response = await page.goto(checkUrl(a.url), { waitUntil: 'domcontentloaded' });
          await page.waitForLoadState('load', { timeout: 8000 }).catch(() => {});
          return { ...(await stateOf(lane, id, page)), status: response?.status() ?? null };
        }
        case 'snapshot': {
          const snapshot = await page.ariaSnapshot({ mode: 'ai', timeout: 10_000 });
          return { ...(await stateOf(lane, id, page)), snapshot: clip(snapshot, SNAPSHOT_MAX) };
        }
        case 'click': {
          await locatorFor(page, a).click({ timeout: 10_000, clickCount: a.double === true ? 2 : 1, button: a.button === 'right' ? 'right' : 'left' });
          await settle(page);
          return await stateOf(lane, id, page);
        }
        case 'type': {
          if (typeof a.text !== 'string') throw new Error('text is required.');
          const { text: _typed, field, ...rest } = a;
          const target = typeof field === 'string' && field
            ? (rest.ref || rest.selector ? (() => { throw new Error('Pass exactly one of ref, selector, or field.'); })() : page.getByLabel(field).or(page.getByPlaceholder(field)).first())
            : locatorFor(page, rest);
          if (a.slowly === true) { await target.fill('', { timeout: 10_000 }); await target.pressSequentially(a.text, { delay: 30 }); }
          else await target.fill(a.text, { timeout: 10_000 });
          if (a.submit === true) { await target.press('Enter'); await settle(page); }
          // The text is never echoed back: it may be a password.
          return { ...(await stateOf(lane, id, page)), typedChars: a.text.length };
        }
        case 'press': {
          if (typeof a.key !== 'string' || !a.key || a.key.length > 40) throw new Error('key is required, for example Enter, Tab or Control+A.');
          await page.keyboard.press(a.key);
          await settle(page);
          return await stateOf(lane, id, page);
        }
        case 'select': {
          const values = Array.isArray(a.values) ? a.values.filter((v): v is string => typeof v === 'string').slice(0, 20) : [];
          if (!values.length) throw new Error('values is required (option values or labels).');
          const chosen = await locatorFor(page, a).selectOption(values, { timeout: 10_000 });
          return { ...(await stateOf(lane, id, page)), selected: chosen };
        }
        case 'screenshot': {
          const hasTarget = ['ref', 'selector', 'text'].some((k) => typeof a[k] === 'string' && a[k]);
          const shot = (full: boolean) => (hasTarget
            ? locatorFor(page, a).screenshot({ type: 'jpeg', quality: 70, timeout: 15_000 })
            : page.screenshot({ type: 'jpeg', quality: 70, fullPage: full, timeout: 15_000 }));
          let buf = await shot(a.fullPage === true);
          if (buf.length > SHOT_MAX_BYTES && a.fullPage === true) buf = await shot(false);
          return { ...(await stateOf(lane, id, page)), image: { data: buf.toString('base64'), mimeType: 'image/jpeg' } };
        }
        case 'text': {
          const hasTarget = ['ref', 'selector', 'text'].some((k) => typeof a[k] === 'string' && a[k]);
          const full = hasTarget ? await locatorFor(page, a).innerText({ timeout: 10_000 }) : await page.evaluate<string>('document.body ? document.body.innerText : ""');
          return { ...(await stateOf(lane, id, page)), text: clip(full, TEXT_MAX) };
        }
        case 'wait': {
          const timeout = Math.min(30_000, Math.max(500, Number(a.timeoutMs) || 10_000));
          if (typeof a.text === 'string' && a.text) await page.getByText(a.text).first().waitFor({ state: 'visible', timeout });
          else if (typeof a.textGone === 'string' && a.textGone) await page.getByText(a.textGone).first().waitFor({ state: 'hidden', timeout });
          else if (typeof a.selector === 'string' && a.selector) await page.locator(a.selector).first().waitFor({ state: 'visible', timeout });
          else await sleep(Math.min(timeout, 10_000));
          return await stateOf(lane, id, page);
        }
        default: throw new Error(`Unknown headless operation: ${op}`);
      }
    });
  } catch (err) { throw shortError(err); }
}
