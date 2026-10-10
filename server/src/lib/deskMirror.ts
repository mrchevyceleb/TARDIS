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

/** Cards already pushed since boot; the full sync skips them so a card Kip
 *  is moving mid-sweep cannot be created twice (the newest push already won). */
const pushed = new Set<string>();

export function mirrorEligible(card: DeskCard): boolean {
  const project = (card.project ?? '').trim().toLowerCase();
  if (project && MIRROR_PROJECTS.has(project)) return true;
  const owner = (card.owner?.name ?? '').trim().toLowerCase();
  return MIRROR_OWNERS.has(owner);
}

function pushOne(card: DeskCard): Promise<boolean> {
  const url = process.env.DESK_MIRROR_URL?.trim();
  const secret = process.env.DESK_MIRROR_SECRET?.trim();
  if (!url || !secret) return Promise.resolve(false);
  const payload = {
    desk_card_id: card.id,
    title: card.title,
    stage: STAGE_ALIASES[card.column] ?? card.column,
    pr_urls: (card.links ?? []).filter((l) => /^https:\/\/github\.com\//.test(l)),
    project: card.project ?? '',
    archived: card.archived === true,
  };
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8_000),
  }).then(async (res) => {
    if (!res.ok) console.warn(`[desk-mirror] ${card.id} push failed: ${res.status}`);
    return res.ok;
  }).catch((err) => {
    console.warn(`[desk-mirror] ${card.id} push error:`, (err as Error).message);
    return false;
  });
}

/** Fire-and-forget push after a card mutation. Never throws, never blocks. */
export function queueMirror(card: DeskCard): void {
  if (!mirrorEligible(card)) return;
  pushed.add(card.id);
  void pushOne(card);
}

/** One-shot full sync: push every live eligible card (archived cards stay
 *  out unless already mirrored; an archived push only ever updates an
 *  existing mirror row, and the tracker side refuses to create-as-closed).
 *  Returns what happened, for the deploy receipt. */
export async function mirrorAll(cards: DeskCard[]): Promise<{ pushed: number; skipped: number; failed: number }> {
  const live = cards.filter((c) => !c.archived && mirrorEligible(c) && !pushed.has(c.id));
  let ok = 0;
  let failed = 0;
  for (const card of live) {
    pushed.add(card.id);
    if (await pushOne(card)) ok += 1; else failed += 1;
  }
  return { pushed: ok, skipped: cards.length - live.length, failed };
}
