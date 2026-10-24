// Card card-2de6e4 (Matt, Oct 24 2026): the moment any account TARDIS uses
// crosses 90% of a live usage window, Matt gets one Desk ("Needs you") alert
// naming the login and its reset time, so he can handle it.
//
// One alert per crossing of one account window per reset period. A window
// that drops below 85% re-arms; while an earlier alert for the same window is
// still open on the Desk, a re-crossing adds nothing (Matt already has it). The
// key is also written into the Desk item, so a crash between creating the
// item and saving state adopts that item instead of duplicating it. A failed
// create is never recorded, so the next tick retries it. Keys are pruned only
// once their reset has passed (or after 8 days with no reset), never because
// one reading came back empty, so a provider outage cannot cause a repeat.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { STATE_DIR } from '../config.ts';
import { readAccountUsage, type UsageAccount, type UsageWindow } from './accountUsage.ts';
import { createTodo, readDesk, writeJsonAtomic, type DeskActor } from './deskStore.ts';

export const USAGE_ALERT_THRESHOLD = 90;
export const USAGE_ALERT_REARM_BELOW = 85;
const NO_RESET_TTL_MS = 8 * 24 * 3600_000;
const TICK_MS = 60_000;
const FIRST_TICK_MS = 20_000;
const STATE_FILE = () => join(STATE_DIR, 'usage-alert-state.json');
const TARDIS_ACTOR: DeskActor = { kind: 'agent', id: 'tardis', name: 'TARDIS' };

/** key -> { at: ISO alert time, resetsAt } */
type AlertState = Record<string, { at: string; resetsAt: string | null }>;

function windowPercent(window: UsageWindow): number | null {
  if (window.active === false || window.unit === 'credits') return null;
  if (!Number.isFinite(window.used) || !Number.isFinite(window.limit) || window.limit <= 0) return null;
  return window.unit === 'percent' ? window.used : (window.used / window.limit) * 100;
}

/** One key per account window, by label (provider window ids are array
 *  positions and can shift). The reset period lives in the state entry, not
 *  the key: providers jitter reset times by fractions of a second between
 *  readings, so the entry simply expires once its reset has passed. */
function crossingKey(account: UsageAccount, window: UsageWindow): string {
  return `usage-alert:${account.id}:${window.label.replace(/\s+/g, '_')}`;
}

function formatReset(iso: string | null): string {
  const at = iso ? new Date(iso) : null;
  if (!at || !Number.isFinite(at.getTime())) return 'Its reset time is not reported.';
  const et = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(at);
  return `It resets ${et} ET.`;
}

function expired(entry: { at: string; resetsAt: string | null }, nowMs: number): boolean {
  const reset = entry.resetsAt ? Date.parse(entry.resetsAt) : NaN;
  if (Number.isFinite(reset)) return reset <= nowMs;
  return nowMs - Date.parse(entry.at) > NO_RESET_TTL_MS;
}

async function loadState(): Promise<AlertState> {
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE(), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && !('version' in parsed)) return parsed as AlertState;
  } catch { /* first run: the Desk marker still prevents duplicates */ }
  return {};
}

async function openAlertKeys(): Promise<Set<string>> {
  const desk = await readDesk();
  const keys = new Set<string>();
  for (const todo of desk.todos) {
    if (todo.status !== 'open') continue;
    const match = /usage-alert:\S+/.exec(todo.detail ?? '');
    if (match) keys.add(match[0]);
  }
  return keys;
}

let saveOwed = false;

async function tick(state: AlertState): Promise<void> {
  const nowMs = Date.now();
  const { accounts } = await readAccountUsage();
  let dirty = saveOwed;
  for (const [key, entry] of Object.entries(state)) if (expired(entry, nowMs)) { delete state[key]; dirty = true; }
  let openKeys: Set<string> | null = null;
  for (const account of accounts) {
    if (account.status !== 'live') continue;
    for (const window of account.windows) {
      const percent = windowPercent(window);
      if (percent === null) continue;
      // A cached reading from a period that already reset is old news.
      if (window.resetsAt && Date.parse(window.resetsAt) <= nowMs) continue;
      const key = crossingKey(account, window);
      if (percent < USAGE_ALERT_REARM_BELOW) { if (state[key]) { delete state[key]; dirty = true; } continue; }
      if (percent < USAGE_ALERT_THRESHOLD || state[key]) continue;
      openKeys ??= await openAlertKeys();
      if (!openKeys.has(key)) {
        const pct = Math.round(percent);
        const who = account.email ? `${account.provider} ${account.email}` : account.name;
        try {
          await createTodo({
            title: `${who} is at ${pct}% usage`,
            detail: `${who}${account.plan ? ` (${account.plan} plan)` : ''} is at ${pct}% of its ${window.label} window. ${formatReset(window.resetsAt)} Open Usage to decide what to do before it fills up.\n\n${key}`,
            priority: 'high',
          }, TARDIS_ACTOR);
          console.log(`[usage-alert] ${who} ${window.label} at ${pct}%: Desk alert created`);
        } catch (error) {
          console.warn(`[usage-alert] Desk alert failed for ${who}: ${(error as Error).message}`);
          continue; // not recorded, so the next tick retries
        }
      }
      state[key] = { at: new Date(nowMs).toISOString(), resetsAt: window.resetsAt ?? null };
      dirty = true;
    }
  }
  if (!dirty) return;
  try { await writeJsonAtomic(STATE_FILE(), state); saveOwed = false; }
  catch (error) { saveOwed = true; throw error; }
}

let started = false;

/** Boot entry (index.ts): first check shortly after start, then every minute.
 *  The usage feed caches for 45s, so this never hammers providers. */
export function startUsageThresholdAlerts(): void {
  if (started) return;
  started = true;
  if (['off', '0', 'false', 'no'].includes((process.env.RIVENDELL_USAGE_ALERTS ?? '').trim().toLowerCase())) return;
  let state: AlertState | null = null;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try { state ??= await loadState(); await tick(state); }
    catch (error) { console.warn(`[usage-alert] check failed: ${(error as Error).message}`); }
    finally { running = false; }
  };
  setTimeout(() => { void run(); }, FIRST_TICK_MS).unref();
  setInterval(() => { void run(); }, TICK_MS).unref();
}
