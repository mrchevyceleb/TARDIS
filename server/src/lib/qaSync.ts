// The QA board's self-check: reconcile the record against GitHub and Slack,
// the two places truth lives. New staging merges add cards, anything that
// disagrees is flagged as drift for a person to resolve, and the board and
// Sam's pinned Slack lists render from the same records so the two views
// always agree.
//
// GitHub truth comes from the Desk PR snapshot (gh, read-only). That
// snapshot is a cache, not an authority: it can be pending, stale, unknown
// or disabled, and it only ever shows merges from the last 48 hours. So
// the sync only ADDS cards from a healthy snapshot, and drift is only ever
// reported, never auto-deleted: the snapshot cannot distinguish "PR closed
// unmerged" from "PR merged a while back", and deleting on that guess
// would erase live work and the validated tombstones with it. A card
// leaves the board through its Slack thread outcome, and nowhere else.

import { deskPrs, type DeskPr, type DeskPrSnapshot } from './githubPrs.ts';
import { applyQaOutcome, qaAllItems, qaDriftCheck, qaRepoAllowed, upsertQaItem, type QaDrift, type QaItem } from './qaBoard.ts';

export type QaSyncResult = {
  added: number;
  /** False when the GitHub snapshot was pending, stale, unknown or
   *  disabled, so nothing was added and nothing can be called drift: the
   *  board simply kept what it had. */
  authoritative: boolean;
  drift: QaDrift[];
  open: number;
};

/** App label for a repo: the two apps the flow routes between. Unknown
 *  repos fall back to Studio, and an explicit app on the merge signal
 *  always wins over this guess. */
function appForRepo(repo: string): 'Operly' | 'Studio' {
  return /operly/i.test(repo) ? 'Operly' : 'Studio';
}

function snapshotAuthoritative(snapshot: DeskPrSnapshot): boolean {
  return !snapshot.disabled && !snapshot.pending && !snapshot.stale && !snapshot.unknown;
}

/** A merged PR in a configured QA repo becomes a QA item for its tester.
 *  Idempotent by repo + PR: the same merge seen twice lands once, and a
 *  validated tombstone absorbs a retried merge as a no-op. Draft and
 *  still-open PRs are work in flight, not test work, so they never land
 *  early. With a non-authoritative snapshot nothing is added at all. */
export async function syncQaFromGithub(snapshot = deskPrs()): Promise<QaSyncResult> {
  const authoritative = snapshotAuthoritative(snapshot);
  let added = 0;
  if (authoritative) {
    const known = new Set((await qaAllItems()).map((i) => `${i.repo.trim().toLowerCase()}#${i.pr}`));
    for (const pr of snapshot.prs) {
      if (pr.state !== 'merged' || !qaRepoAllowed(pr.repo)) continue;
      const created = await upsertQaItem({ repo: pr.repo, pr: pr.number, title: pr.title, app: appForRepo(pr.repo) });
      if (created && !known.has(`${pr.repo.trim().toLowerCase()}#${pr.number}`)) added += 1;
    }
  }
  const items = await qaAllItems();
  const drift = authoritative ? await qaDrift(items, snapshot.prs) : [];
  const open = items.filter((i) => i.status !== 'validated').length;
  return { added, authoritative, drift, open };
}

function truthFor(items: QaItem[], prs: DeskPr[]) {
  return items.map((item) => {
    const seen = prs.find((pr) => pr.repo.trim().toLowerCase() === item.repo.trim().toLowerCase() && pr.number === item.pr);
    return { repo: item.repo, pr: item.pr, state: (seen ? (seen.state === 'merged' ? 'merged' : 'open') : 'missing') as 'open' | 'merged' | 'missing' };
  });
}

export async function qaDrift(items: QaItem[], prs: DeskPr[]): Promise<QaDrift[]> {
  return qaDriftCheck(items, truthFor(items, prs));
}

/** Slack thread outcomes: the reply word in the item's own thread is the
 *  signal. "validated" clears the card; a fail sends Sud items to retest
 *  and Edgar/Martin items back to their own fix loop. Returns the item on
 *  a recognized outcome, null otherwise, so noise never moves a card. */
export async function applySlackOutcome(repo: string, pr: number, outcome: string): Promise<QaItem | null> {
  const item = (await qaAllItems()).find((i) => i.repo.trim().toLowerCase() === repo.trim().toLowerCase() && i.pr === pr);
  if (!item) return null;
  return applyQaOutcome(item.id, outcome);
}
