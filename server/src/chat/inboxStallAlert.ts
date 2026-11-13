// A teammate's durable inbox that keeps failing is stuck, not busy: a drain
// that waits for a busy recipient or quiet hours is never reported here. Nov
// 13: Adam's inbox failed every 15 seconds for 55 minutes with 24 messages
// behind it and nobody heard. Now, once a failure streak is two minutes old,
// Max is told, and he hears when it moves again. A stuck inbox is Max's to
// fix, so Matt's Desk stays out of it, with one exception: when the stuck
// inbox is Max's own, a message to him would wait behind the jam, so that
// one case goes to the Desk at normal priority and closes when it clears.
// Every notice retries until it lands (a full disk refuses them too).
import { createTodo, setTodoStatus, type DeskActor } from '../lib/deskStore.ts';

export const INBOX_STALL_ALERT_MS = 2 * 60_000;
const MAX_ID = 'chief-of-staff';
const NOTICE_RETRY_MS = 60_000;
const TARDIS_ACTOR: DeskActor = { kind: 'agent', id: 'tardis', name: 'TARDIS' };

type Stall = {
  agentId: string;
  name: string;
  since: number;
  waiting: number;
  error: string;
  /** Set once the inbox moved again; the entry stays until its notice lands. */
  endedAt?: number;
  maxTold: boolean;
  /** Max's own inbox only: the Desk item standing in for his message. */
  deskTodoId?: string;
  settled: boolean;
  sending: boolean;
  retry?: ReturnType<typeof setTimeout>;
};
const stalls = new Map<string, Stall>();

export type StallAlertDeps = {
  now: () => number;
  tellMax: (text: string) => Promise<{ delivered: boolean }>;
  openDeskAlert: (title: string, detail: string) => Promise<string>;
  closeDeskAlert: (id: string, note: string) => Promise<void>;
};

const defaultDeps: StallAlertDeps = {
  now: () => Date.now(),
  tellMax: async (text) => {
    const { deliverTeamMessage } = await import('./teamBus.ts');
    return deliverTeamMessage({ from: 'TARDIS', to: MAX_ID, text, wait: false });
  },
  openDeskAlert: async (title, detail) =>
    (await createTodo({ title, detail, priority: 'normal', link: `thread:${MAX_ID}` }, TARDIS_ACTOR)).id,
  closeDeskAlert: async (id, note) => { await setTodoStatus(id, 'done', { note, by: TARDIS_ACTOR }); },
};

function clock(ms: number): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(ms)) + ' ET';
}

function oneLine(text: string, max: number): string {
  return text.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function minutes(ms: number): string {
  const n = Math.max(1, Math.round(ms / 60_000));
  return `${n} minute${n === 1 ? '' : 's'}`;
}

/** One attempt at the notice this stall still owes. Single-flight; a notice
 *  that fails is retried on a timer until it lands. */
async function flush(stall: Stall, deps: StallAlertDeps): Promise<void> {
  if (stall.sending) return;
  stall.sending = true;
  const ownInbox = stall.agentId === MAX_ID;
  try {
    if (stall.endedAt === undefined) {
      const plural = stall.waiting === 1 ? 'message is' : 'messages are';
      const detail = `${stall.name}'s inbox has not moved since ${clock(stall.since)}: ${stall.waiting} ${plural} waiting and none can be delivered. `
        + `The delivery keeps failing with: "${oneLine(stall.error, 160)}". TARDIS keeps retrying on its own and will say when it moves again.`;
      try {
        if (ownInbox) stall.deskTodoId ??= await deps.openDeskAlert(`${stall.name}'s inbox is stuck`, detail);
        else if (!stall.maxTold) stall.maxTold = (await deps.tellMax(detail)).delivered;
      } catch { /* retried */ }
    } else {
      const took = minutes(stall.endedAt - stall.since);
      try {
        if (ownInbox) {
          // Max sees his own inbox move; only a Desk item that landed needs closing.
          if (stall.deskTodoId) await deps.closeDeskAlert(stall.deskTodoId, `${stall.name}'s inbox is moving again after about ${took} stuck.`);
          stall.settled = true;
        } else {
          // Max hears it either way: past tense when the jam beat the alert.
          const note = stall.maxTold
            ? `${stall.name}'s inbox is moving again after about ${took} stuck.`
            : `${stall.name}'s inbox was stuck for about ${took} from ${clock(stall.since)} (last error: "${oneLine(stall.error, 160)}"). It is moving again and nothing was lost.`;
          stall.settled = (await deps.tellMax(note)).delivered;
        }
      } catch { /* retried */ }
      if (stall.settled) {
        // A new streak replaces this entry rather than reopening it.
        if (stalls.get(stall.agentId) === stall) stalls.delete(stall.agentId);
        return;
      }
    }
    const owed = stall.endedAt !== undefined || (ownInbox ? !stall.deskTodoId : !stall.maxTold);
    if (owed && !stall.retry) {
      console.warn(`[team] inbox notice for ${stall.name} not delivered yet; retrying`);
      stall.retry = setTimeout(() => { stall.retry = undefined; void flush(stall, deps); }, NOTICE_RETRY_MS);
      stall.retry.unref?.();
    }
  } finally {
    stall.sending = false;
  }
}

/** A drain pass for this inbox failed. Alerts once the streak is two minutes old. */
export function noteInboxFailed(
  agentId: string,
  info: { name: string; waiting: number; error: string },
  deps: StallAlertDeps = defaultDeps,
): void {
  const now = deps.now();
  let stall = stalls.get(agentId);
  // Stuck again after it moved: a new streak. The ended one keeps owning its
  // own recovery notice (even mid-send), so neither erases the other.
  if (!stall || stall.endedAt !== undefined) {
    stall = { agentId, name: info.name, since: now, waiting: 0, error: '', maxTold: false, settled: false, sending: false };
    stalls.set(agentId, stall);
  }
  Object.assign(stall, { name: info.name, waiting: info.waiting, error: info.error });
  if (now - stall.since >= INBOX_STALL_ALERT_MS) void flush(stall, deps);
}

/** A drain pass for this inbox went through. Ends the streak and owes the
 *  recovery notice. */
export function noteInboxMoved(agentId: string, deps: StallAlertDeps = defaultDeps): void {
  const stall = stalls.get(agentId);
  if (!stall || stall.endedAt !== undefined) return;
  const now = deps.now();
  if (now - stall.since < INBOX_STALL_ALERT_MS && !stall.maxTold && !stall.deskTodoId) {
    stalls.delete(agentId);
    return;
  }
  stall.endedAt = now;
  if (stall.retry) { clearTimeout(stall.retry); stall.retry = undefined; }
  void flush(stall, deps);
}
