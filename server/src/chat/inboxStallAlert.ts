// A teammate's durable inbox that keeps failing is stuck, not busy: a drain
// that waits for a busy recipient or quiet hours is never reported here. Nov
// 13: Adam's inbox failed every 15 seconds for 55 minutes with 24 messages
// behind it and nobody heard. Now, once a failure streak is two minutes old,
// Max gets a team message and Matt a Desk alert, and both hear when it moves
// again. Two channels on purpose: when the stuck inbox is Max's own, his
// message waits behind the jam, but the Desk still shows it. Every notice
// retries until it lands (a full disk refuses them too), and an inbox that
// recovered before anyone could be told still gets a short after-the-fact
// note to Max.
import { createTodo, setTodoStatus, type DeskActor } from '../lib/deskStore.ts';

export const INBOX_STALL_ALERT_MS = 2 * 60_000;
const NOTICE_RETRY_MS = 60_000;
const TARDIS_ACTOR: DeskActor = { kind: 'agent', id: 'tardis', name: 'TARDIS' };

type Stall = {
  agentId: string;
  name: string;
  since: number;
  waiting: number;
  error: string;
  /** Set once the inbox moved again; the entry stays until its notices land. */
  endedAt?: number;
  maxTold: boolean;
  deskTodoId?: string;
  maxRecoveryTold: boolean;
  deskClosed: boolean;
  /** The after-the-fact Desk note, for a stall whose alert never landed. */
  deskNoted?: boolean;
  sending: boolean;
  retry?: ReturnType<typeof setTimeout>;
};
const stalls = new Map<string, Stall>();

export type StallAlertDeps = {
  now: () => number;
  tellMax: (text: string) => Promise<{ delivered: boolean }>;
  openDeskAlert: (title: string, detail: string, agentId: string, priority: 'high' | 'normal') => Promise<string>;
  closeDeskAlert: (id: string, note: string) => Promise<void>;
};

const defaultDeps: StallAlertDeps = {
  now: () => Date.now(),
  tellMax: async (text) => {
    const { deliverTeamMessage } = await import('./teamBus.ts');
    return deliverTeamMessage({ from: 'TARDIS', to: 'chief-of-staff', text, wait: false });
  },
  openDeskAlert: async (title, detail, agentId, priority) =>
    (await createTodo({ title, detail, priority, link: `thread:${agentId}` }, TARDIS_ACTOR)).id,
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

/** One attempt at every notice this stall still owes. Single-flight; a
 *  notice that fails is retried on a timer until it lands. */
async function flush(stall: Stall, deps: StallAlertDeps): Promise<void> {
  if (stall.sending) return;
  stall.sending = true;
  try {
    const attempt = async (send: () => Promise<boolean>) => { try { return await send(); } catch { return false; } };
    if (stall.endedAt === undefined) {
      const plural = stall.waiting === 1 ? 'message is' : 'messages are';
      const detail = `${stall.name}'s inbox has not moved since ${clock(stall.since)}: ${stall.waiting} ${plural} waiting and none can be delivered. `
        + `The delivery keeps failing with: "${oneLine(stall.error, 160)}". TARDIS keeps retrying on its own and will say when it moves again.`;
      if (!stall.maxTold) stall.maxTold = await attempt(async () => (await deps.tellMax(detail)).delivered);
      if (!stall.deskTodoId) {
        try { stall.deskTodoId = await deps.openDeskAlert(`${stall.name}'s inbox is stuck`, detail, stall.agentId, 'high'); } catch { /* retried */ }
      }
    } else {
      const took = minutes(stall.endedAt - stall.since);
      // Whoever could not be told while it was stuck (a full disk refuses
      // the alerts too) hears what happened, in the past tense.
      const pastTense = `${stall.name}'s inbox was stuck for about ${took} from ${clock(stall.since)} (last error: "${oneLine(stall.error, 160)}"). It is moving again and nothing was lost.`;
      if (!stall.maxRecoveryTold) {
        const note = stall.maxTold ? `${stall.name}'s inbox is moving again after about ${took} stuck.` : pastTense;
        stall.maxRecoveryTold = await attempt(async () => (await deps.tellMax(note)).delivered);
      }
      if (!stall.deskTodoId && !stall.deskNoted) {
        stall.deskNoted = await attempt(async () => {
          await deps.openDeskAlert(`${stall.name}'s inbox was stuck for a while`, pastTense, stall.agentId, 'normal');
          return true;
        });
      }
      if (stall.deskTodoId && !stall.deskClosed) {
        stall.deskClosed = await attempt(async () => {
          await deps.closeDeskAlert(stall.deskTodoId!, `${stall.name}'s inbox is moving again after about ${took} stuck.`);
          return true;
        });
      }
      if (stall.maxRecoveryTold && (stall.deskTodoId ? stall.deskClosed : stall.deskNoted)) {
        // A new streak replaces this entry rather than reopening it.
        if (stalls.get(stall.agentId) === stall) stalls.delete(stall.agentId);
        return;
      }
    }
    const owed = stall.endedAt !== undefined || !stall.maxTold || !stall.deskTodoId;
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
  // own recovery notices (even mid-send), so neither erases the other.
  if (!stall || stall.endedAt !== undefined) {
    stall = { agentId, name: info.name, since: now, waiting: 0, error: '', maxTold: false, maxRecoveryTold: false, deskClosed: false, sending: false };
    stalls.set(agentId, stall);
  }
  Object.assign(stall, { name: info.name, waiting: info.waiting, error: info.error });
  if (now - stall.since >= INBOX_STALL_ALERT_MS) void flush(stall, deps);
}

/** A drain pass for this inbox went through. Ends the streak and announces
 *  the recovery wherever the stall was (or should have been) announced. */
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
