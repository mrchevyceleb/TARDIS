// A teammate's durable inbox that keeps failing is stuck, not busy: waiting
// for a turn boundary or quiet hours never throws, so only a drain that errors
// pass after pass lands here. Nov 13: Adam's inbox failed every 15 seconds for
// 55 minutes with 24 messages behind it and nobody heard. Now Max gets a team
// message and Matt a Desk alert once a failure streak passes two minutes, and
// both hear when it moves again. Two channels on purpose: when the stuck inbox
// is Max's own, his message waits behind the jam, but the Desk still shows it.
import { createTodo, setTodoStatus, type DeskActor } from '../lib/deskStore.ts';

export const INBOX_STALL_ALERT_MS = 2 * 60_000;
const TARDIS_ACTOR: DeskActor = { kind: 'agent', id: 'tardis', name: 'TARDIS' };

type Stall = { since: number; name: string; maxTold: boolean; deskTodoId?: string; sending?: boolean };
const stalls = new Map<string, Stall>();

export type StallAlertDeps = {
  tellMax: (text: string) => Promise<{ delivered: boolean }>;
  openDeskAlert: (title: string, detail: string, agentId: string) => Promise<string>;
  closeDeskAlert: (id: string, note: string) => Promise<void>;
};

const defaultDeps: StallAlertDeps = {
  tellMax: async (text) => {
    const { deliverTeamMessage } = await import('./teamBus.ts');
    return deliverTeamMessage({ from: 'TARDIS', to: 'chief-of-staff', text, wait: false });
  },
  openDeskAlert: async (title, detail, agentId) =>
    (await createTodo({ title, detail, priority: 'high', link: `thread:${agentId}` }, TARDIS_ACTOR)).id,
  closeDeskAlert: async (id, note) => { await setTodoStatus(id, 'done', { note, by: TARDIS_ACTOR }); },
};

function clock(ms: number): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(ms)) + ' ET';
}

function oneLine(text: string, max: number): string {
  return text.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** A drain pass for this inbox failed. Alerts once the streak is two minutes old. */
export function noteInboxFailed(
  agentId: string,
  info: { name: string; waiting: number; error: string },
  deps: StallAlertDeps = defaultDeps,
  now = Date.now(),
): void {
  let stall = stalls.get(agentId);
  if (!stall) stalls.set(agentId, stall = { since: now, name: info.name, maxTold: false });
  if (now - stall.since < INBOX_STALL_ALERT_MS || stall.sending || (stall.maxTold && stall.deskTodoId)) return;
  const s = stall;
  const plural = info.waiting === 1 ? 'message is' : 'messages are';
  const detail = `${info.name}'s inbox has not moved since ${clock(s.since)}: ${info.waiting} ${plural} waiting and none can be delivered. `
    + `The delivery keeps failing with: "${oneLine(info.error, 160)}". TARDIS retries on its own and will say when it moves again.`;
  s.sending = true;
  void (async () => {
    if (!s.maxTold) {
      try { s.maxTold = (await deps.tellMax(detail)).delivered; } catch { /* retried on the next failed pass */ }
    }
    if (!s.deskTodoId) {
      try { s.deskTodoId = await deps.openDeskAlert(`${info.name}'s inbox is stuck`, detail, agentId); } catch { /* retried on the next failed pass */ }
    }
    if (stalls.get(agentId) !== s) announceRecovery(s, deps, Date.now());
    else if (!s.maxTold || !s.deskTodoId) console.warn(`[team] stuck-inbox alert for ${info.name} not fully delivered; retrying`);
  })().finally(() => { s.sending = false; });
}

function announceRecovery(stall: Stall, deps: StallAlertDeps, now: number): void {
  const minutes = Math.max(1, Math.round((now - stall.since) / 60_000));
  const note = `${stall.name}'s inbox is moving again after about ${minutes} minute${minutes === 1 ? '' : 's'} stuck.`;
  if (stall.maxTold) void deps.tellMax(note).catch(() => { /* the streak is over either way */ });
  if (stall.deskTodoId) void deps.closeDeskAlert(stall.deskTodoId, note).catch(() => { /* Matt can close it by hand */ });
}

/** A drain pass for this inbox finished cleanly. Ends any streak, and says so
 *  wherever the stall was announced. */
export function noteInboxMoved(agentId: string, deps: StallAlertDeps = defaultDeps, now = Date.now()): void {
  const stall = stalls.get(agentId);
  if (!stall) return;
  stalls.delete(agentId);
  // An alert still sending announces the recovery itself once it lands.
  if (!stall.sending) announceRecovery(stall, deps, now);
}
