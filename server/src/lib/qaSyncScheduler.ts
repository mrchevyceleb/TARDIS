// The QA board keeps itself current while the server is running. GitHub is
// polled on a short background cadence; a tester opening the board never has
// to request a sync, and no other lane has to remember to call one. The first
// sweep runs shortly after boot, then every two minutes. A sweep that stalls
// past its timeout is abandoned by qaSync, so the next tick runs a fresh one.

import { syncQaFromGithub } from './qaSync.ts';
import { qaBoardEnabled } from './qaBoard.ts';
import { refreshQaPins } from './qaPins.ts';

const TICK_MS = 2 * 60_000;
const FIRST_TICK_MS = 15_000;
const SWEEP_TIMEOUT_MS = 90_000;
let timer: ReturnType<typeof setInterval> | null = null;
let sweepInFlight = false;

export function startQaSyncScheduler(): boolean {
  if (timer) return true;
  if (!qaBoardEnabled()) {
    console.log('[qa-sync] off until QA repos and tester logins are configured');
    return false;
  }
  // The first sweep after boot always refreshes the pins, so a change in how
  // the lists render (routing, caps) reaches Slack without waiting for a merge.
  let firstSweep = true;
  const run = async () => {
    const result = await syncQaFromGithub();
    if (result.authoritative && (result.added || result.drift.length)) {
      console.log(`[qa-sync] sweep: ${result.added} added, ${result.drift.length} drift, ${result.open} open`);
    }
    // Cards the sweep itself added change the pinned lists too; a sync
    // add must not wait for the next land or outcome to refresh them.
    if (result.added > 0 || firstSweep) await refreshQaPins();
    firstSweep = false;
  };
  const tick = () => {
    if (sweepInFlight) return;
    sweepInFlight = true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const guard = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(`sweep exceeded ${SWEEP_TIMEOUT_MS / 1000}s`)), SWEEP_TIMEOUT_MS);
      timeout.unref();
    });
    void Promise.race([run(), guard])
      .catch((error) => console.warn(`[qa-sync] sweep failed: ${(error as Error)?.message}`))
      .finally(() => { if (timeout) clearTimeout(timeout); sweepInFlight = false; });
  };
  timer = setInterval(tick, TICK_MS);
  timer.unref();
  setTimeout(tick, FIRST_TICK_MS).unref();
  return true;
}
