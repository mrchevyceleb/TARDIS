// One-way Desk -> Dev PR Tracker mirror (Matt, Oct 9 2026). Every Rally-lane
// card mutation pushes the card's title, stage and PR links to the tracker's
// desk-mirror edge function, keyed by Desk card id so a re-push updates
// instead of duplicating. Fire-and-forget: a failed push never blocks or
// fails a Desk write. Only title/stage/links/project ever leave the Desk —
// no owner names, no agent ids, no comments, no internal notes.
// Dormant until DESK_MIRROR_URL and DESK_MIRROR_SECRET are both set.
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
  });
}

function configured(): { url: string; secret: string } | null {
  const url = process.env.DESK_MIRROR_URL?.trim();
  const secret = process.env.DESK_MIRROR_SECRET?.trim();
  return url && secret ? { url, secret } : null;
}

async function pushBody(id: string, body: string): Promise<boolean> {
  const cfg = configured();
  if (!cfg) return false;
  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.secret}` },
      body,
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) console.warn(`[desk-mirror] ${id} push failed: ${res.status}`);
    return res.ok;
  } catch (err) {
    console.warn(`[desk-mirror] ${id} push error:`, (err as Error).message);
    return false;
  }
}

// Cards this process has seen in the lane: a card that later leaves the lane
// still gets one closing tombstone (its new state alone is no longer eligible).
const everEligible = new Set<string>();
// Cards with a confirmed successful push: later sweeps skip them (no dup).
// Failed pushes are not marked, so a later sweep retries them.
const mirrored = new Set<string>();
// Latest payload per card, pushed one-at-a-time per card, so a burst of
// mutations collapses to the newest state and can never land out of order.
const pending = new Map<string, string>();
const chains = new Map<string, Promise<void>>();

function drain(id: string): Promise<void> {
  return (async () => {
    try {
      while (pending.has(id)) {
        const body = pending.get(id)!;
        pending.delete(id);
        if (await pushBody(id, body)) mirrored.add(id);
      }
    } finally {
      chains.delete(id);
    }
  })();
}

/** Fire-and-forget push after a card mutation. Never throws, never blocks. */
export function queueMirror(card: DeskCard): void {
  const eligible = mirrorEligible(card);
  if (!eligible && !everEligible.has(card.id)) return;
  if (eligible) everEligible.add(card.id);
  pending.set(card.id, payloadFor(card, !eligible));
  if (!chains.has(card.id)) chains.set(card.id, drain(card.id));
}

async function pushCard(card: DeskCard, closing: boolean): Promise<boolean> {
  everEligible.add(card.id);
  const ok = await pushBody(card.id, payloadFor(card, closing));
  if (ok) mirrored.add(card.id);
  return ok;
}

// Bounded concurrency for the sweep: enough to finish in seconds, few enough
// never to look like an attack on the edge function.
const SYNC_CONCURRENCY = 8;
let syncing = false;

/** One-shot full sync. Live eligible cards push their state; archived
 *  eligible cards push closing tombstones (the receiver refuses to create a
 *  row for a tombstone, so an archived card that never mirrored adds
 *  nothing); then one reconcile call closes any mirror row whose Desk card
 *  is no longer in the Rally lane at all. Single-flight: a second call
 *  while one runs returns { busy: true }. */
export async function mirrorAll(cards: DeskCard[]): Promise<{ busy?: boolean; pushed?: number; closed?: number; failed?: number; skipped?: number }> {
  if (syncing) return { busy: true };
  syncing = true;
  try {
    const eligible = cards.filter((c) => mirrorEligible(c));
    const live = eligible.filter((c) => !c.archived);
    const archived = eligible.filter((c) => c.archived);
    let pushed = 0;
    let closed = 0;
    let failed = 0;
    let skipped = 0;
    let cursor = 0;
    async function worker(kind: 'live' | 'archived'): Promise<void> {
      while (cursor < eligible.length) {
        const card = eligible[cursor++];
        const isArchived = card.archived === true;
        if (isArchived !== (kind === 'archived')) continue;
        if (!isArchived && mirrored.has(card.id)) { skipped += 1; continue; }
        if (await pushCard(card, isArchived)) { if (isArchived) closed += 1; else pushed += 1; } else failed += 1;
      }
    }
    await Promise.all([...Array.from({ length: SYNC_CONCURRENCY }, () => worker('live'))]);
    await Promise.all([...Array.from({ length: SYNC_CONCURRENCY }, () => worker('archived'))]);
    const cfg = configured();
    let reconciled: number | undefined;
    if (cfg) {
      try {
        const res = await fetch(cfg.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.secret}` },
          body: JSON.stringify({ reconcile_ids: eligible.map((c) => c.id) }),
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
    return { pushed, closed, failed, skipped, ...(reconciled !== undefined ? { reconciled } : {}) };
  } finally {
    syncing = false;
  }
}
