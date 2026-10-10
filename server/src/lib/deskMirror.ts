// One-way Desk -> Dev PR Tracker mirror (Matt, Oct 9 2026). Every card
// mutation pushes the card's title, stage and PR links to the tracker's
// desk-mirror edge function, keyed by Desk card id so a re-push updates
// instead of duplicating. Fire-and-forget: a failed push never blocks or
// fails a Desk write. Only title/stage/links/project ever leave the Desk —
// no owner names, no agent ids, no comments, no internal notes.
// Dormant until DESK_MIRROR_URL and DESK_MIRROR_SECRET are both set.
//
// Delivery contract (review-hardened):
// - Every delivery — hook or full sync — goes through one per-card queue
//   (latest payload wins, one in-flight request per card), so a burst of
//   mutations can never land out of order, and a global slot limiter keeps
//   the whole process under a handful of concurrent requests.
// - The payload carries the card's updatedAt (desk_updated_at); the receiver
//   rejects stale deliveries, so a retry or a racing sync can never regress
//   a newer state.
// - An ineligible card (left the Rally lane) pushes one closing tombstone;
//   the receiver refuses to create a row for a tombstone, so a card that was
//   never mirrored adds nothing, and a mirrored row closes.
// - A card is marked mirrored only while its latest payload is delivered;
//   a newer payload un-marks it, and the next sync retries it.
import type { DeskCard } from './deskStore.ts';

// Rally lane projects (Max, Oct 9 2026; KG-KimGarst deliberately excluded —
// it also holds non-dev Kim work like dashboards and videos), plus any card
// owned by the Rally-lane developers regardless of project.
const MIRROR_PROJECTS = new Set(['operly', 'studio', 'r-link studio', 'rallypoint', 'rally', 'support']);
const MIRROR_OWNERS = new Set(['kip', 'christina', 'maria', 'adam']);

// Old column ids normalize before the push, so the mirror only ever sees
// the five stages (mirrors the store's COLUMN_ALIASES for the same ids).
const STAGE_ALIASES: Record<string, string> = {
  up_next: 'not_started', upnext: 'not_started', next: 'not_started', todo: 'not_started', pipeline: 'not_started',
  waiting: 'in_progress', blocked: 'in_progress',
  done: 'in_production',
};

// PR links only (not repos, issues, commits or profiles): the mirror field is
// "PR links", so anything that is not a pull-request URL is left out.
const PR_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+\/?$/;

// At most this many mirror requests in flight from this process at once.
const MAX_IN_FLIGHT = 8;

export function mirrorEligible(card: DeskCard): boolean {
  const project = (card.project ?? '').trim().toLowerCase();
  if (project && MIRROR_PROJECTS.has(project)) return true;
  const owner = (card.owner?.name ?? '').trim().toLowerCase();
  return MIRROR_OWNERS.has(owner);
}

function payloadFor(card: DeskCard, closing: boolean): string {
  return JSON.stringify({
    desk_card_id: card.id,
    title: card.title,
    stage: STAGE_ALIASES[card.column] ?? card.column,
    pr_urls: (card.links ?? []).filter((l) => PR_URL.test(l)),
    project: card.project ?? '',
    // A closing tombstone (archived on the Desk, or the card left the Rally
    // lane) closes the mirror row; the receiver refuses to create-as-closed.
    archived: closing || card.archived === true,
    desk_updated_at: card.updatedAt,
  });
}

function configured(): { url: string; secret: string } | null {
  const url = process.env.DESK_MIRROR_URL?.trim();
  const secret = process.env.DESK_MIRROR_SECRET?.trim();
  return url && secret ? { url, secret } : null;
}

let syncing = false;

// Global concurrency limiter: every delivery, from any queue, takes a slot.
let active = 0;
const waiters: Array<() => void> = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (active >= MAX_IN_FLIGHT) await new Promise<void>((resolve) => waiters.push(resolve));
  active += 1;
  try {
    return await fn();
  } finally {
    active -= 1;
    waiters.shift()?.();
  }
}

async function pushBody(id: string, body: string): Promise<boolean> {
  const cfg = configured();
  if (!cfg) return false;
  try {
    const res = await withSlot(() => fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.secret}` },
      body,
      signal: AbortSignal.timeout(8_000),
    }));
    if (!res.ok) {
      console.warn(`[desk-mirror] ${id} push failed: ${res.status}`);
      return false;
    }
    // A 200 skip (stale delivery / not previously mirrored) is a delivered
    // verdict, but it must never pass as silent success again (Max, Oct 10).
    try {
      const json = (await res.json()) as { skipped?: boolean; reason?: string };
      if (json?.skipped) console.warn(`[desk-mirror] ${id} skipped: ${json.reason ?? 'unspecified'}`);
    } catch { /* non-JSON body: nothing to report */ }
    return true;
  } catch (err) {
    console.warn(`[desk-mirror] ${id} push error:`, (err as Error).message);
    return false;
  }
}

// Cards whose LATEST payload was delivered. A newer payload removes the id,
// so a failed delivery is retried by the next sync instead of skipped.
const mirrored = new Set<string>();
// Latest payload per card; one drain chain per card delivers them in order.
const pending = new Map<string, string>();
// Per-card generation: only the newest generation's outcome may mark the id
// mirrored, so an older in-flight success can never mask a newer failure.
const generations = new Map<string, number>();
const chains = new Map<string, Promise<void>>();

function enqueue(card: DeskCard): void {
  const eligible = mirrorEligible(card);
  // Ineligible cards still get one closing tombstone: the receiver refuses to
  // create a row for one, so this is what closes a mirror when a card leaves
  // the lane — statelessly, including right after a restart.
  mirrored.delete(card.id);
  generations.set(card.id, (generations.get(card.id) ?? 0) + 1);
  pending.set(card.id, payloadFor(card, !eligible));
  if (!chains.has(card.id)) chains.set(card.id, drain(card.id));
}

function drain(id: string): Promise<void> {
  return (async () => {
    try {
      while (pending.has(id)) {
        const body = pending.get(id)!;
        const generation = generations.get(id) ?? 0;
        pending.delete(id);
        const ok = await pushBody(id, body);
        if (ok && (generations.get(id) ?? 0) === generation) mirrored.add(id);
      }
    } finally {
      chains.delete(id);
    }
  })();
}

/** Fire-and-forget push after a card mutation. Never throws, never blocks. */
export function queueMirror(card: DeskCard): void {
  enqueue(card);
}

/** Await every queued delivery for the given ids (the full sync uses this). */
async function awaitChains(ids: string[]): Promise<void> {
  for (const id of ids) await chains.get(id);
}

/** One-shot full sync: enqueue every eligible card (live state or closing
 *  tombstone) through the same per-card queues, await them all, then one
 *  reconcile call from a FRESH desk read so a card created or moved during
 *  the sweep cannot be closed by a stale id set. Single-flight: a second
 *  call while one runs returns { busy: true }. */
export async function mirrorAll(
  cards: DeskCard[],
  refetch: () => Promise<DeskCard[]>,
): Promise<{ busy?: boolean; pushed?: number; closed?: number; failed?: number; reconciled?: number }> {
  if (syncing) return { busy: true };
  syncing = true;
  try {
    if (!Array.isArray(cards)) return { failed: 0, pushed: 0, closed: 0, reconciled: 0 };
    const eligible = cards.filter((c) => mirrorEligible(c));
    for (const card of eligible) enqueue(card);
    await awaitChains(eligible.map((c) => c.id));
    let pushed = 0;
    let closed = 0;
    let failed = 0;
    for (const card of eligible) {
      if (card.archived === true) {
        if (mirrored.has(card.id)) closed += 1; else failed += 1;
      } else if (mirrored.has(card.id)) pushed += 1; else failed += 1;
    }

    const cfg = configured();
    let reconciled: number | undefined;
    if (cfg) {
      try {
        // Fresh read AFTER all pushes settled: the reconcile set is the
        // current eligible lane, and rows updated after this moment are
        // immune (updated_before cutoff), so mid-sweep changes can never be
        // closed by a stale set.
        const cutoff = new Date().toISOString();
        const fresh = await refetch();
        // Live cards only: an archived card's row must NOT be protected by
        // the reconcile, so a failed tombstone gets repaired by it.
        const freshIds = fresh.filter((c) => !c.archived && mirrorEligible(c)).map((c) => c.id);
        const res = await fetch(cfg.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.secret}` },
          body: JSON.stringify({ reconcile_ids: freshIds, updated_before: cutoff }),
          signal: AbortSignal.timeout(20_000),
        });
        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          reconciled = Number((data as { closed?: unknown }).closed) || 0;
        } else {
          console.warn(`[desk-mirror] reconcile failed: ${res.status}`);
          failed += 1;
        }
      } catch (err) {
        console.warn('[desk-mirror] reconcile error:', (err as Error).message);
        failed += 1;
      }
    }
    return { pushed, closed, failed, ...(reconciled !== undefined ? { reconciled } : {}) };
  } finally {
    syncing = false;
  }
}

