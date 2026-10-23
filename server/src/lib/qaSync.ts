// The QA board's self-check: reconcile the record against GitHub and Slack,
// the two places truth lives. New staging merges add cards, anything that
// disagrees is flagged as drift for a person to resolve, and the board and
// Sam's pinned Slack lists render from the same records so the two views
// always agree.
//
// GitHub truth comes from the Desk PR snapshot (gh, read-only). That
// snapshot is a cache, not an authority: it can be pending, stale, unknown
// or disabled, and it only ever shows merges from the last 48 hours. So
// the sync only ADDS cards from a healthy snapshot that covers every QA
// repo (the snapshot pull already includes RIVENDELL_QA_REPOS), and drift
// is only ever reported, never auto-deleted: the snapshot cannot
// distinguish "PR closed unmerged" from "PR merged a while back", and
// deleting on that guess would erase live work and the validated
// tombstones with it. A card leaves the board through its Slack thread
// outcome, and nowhere else.

import { execFile } from 'node:child_process';
import { deskPrs, snapshotCoversRepos, type DeskPr, type DeskPrSnapshot } from './githubPrs.ts';
import { applyQaOutcome, qaAllItems, qaDriftCheck, qaRepoAllowed, qaRepos, upsertQaItem, type QaDrift, type QaItem } from './qaBoard.ts';

/** Each app's deploy workflow posts the PR's Vercel preview (built against
 *  staging) as a marked comment, "<!-- operly-preview-url -->" or
 *  "<!-- rlink-preview-url -->". The latest one is the card's test link, so a
 *  tester can open the change straight from the board. Null when the PR has
 *  none yet or gh fails; the next sweep tries again. */
function previewUrlFor(repo: string, pr: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('gh', ['api', `repos/${repo}/issues/${pr}/comments`, '--paginate', '--jq', '.[] | select(.body | test("-preview-url -->")) | .body'],
      { encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
        if (error) { resolve(null); return; }
        const urls = String(stdout).match(/https:\/\/[\w.-]+\.vercel\.app/g);
        resolve(urls?.length ? urls[urls.length - 1] : null);
      });
  });
}

/** Open cards still missing a preview link get one, a few per sweep so a
 *  backlog never floods gh. */
const PREVIEW_FILLS_PER_SWEEP = 6;
const PREVIEW_RETRY_MS = 15 * 60_000;
/** Last lookup per card, so cards with no preview yet step aside and every
 *  missing card gets its turn. */
const previewTried = new Map<string, number>();

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

/** A snapshot only speaks for the QA board when it actually covers every
 *  configured QA repo. Coverage is the whole of QA authority: the Desk's
 *  own stale/unknown flags describe Desk repos, so a Desk outage must never
 *  stall QA adds, and drift computed against repos nobody pulled would flag
 *  live cards as gone. */
function snapshotAuthoritative(snapshot: DeskPrSnapshot): boolean {
  return snapshotCoversRepos(snapshot, qaRepos());
}

/** A merged PR in a configured QA repo becomes a QA item for its tester.
 *  Idempotent by repo + PR: the same merge seen twice lands once, and a
 *  validated tombstone absorbs a retried merge as a no-op. Draft and
 *  still-open PRs are work in flight, not test work, so they never land
 *  early. With a non-authoritative snapshot nothing is added at all. */
let syncInFlight: Promise<QaSyncResult> | null = null;
const SYNC_ABANDON_MS = 90_000;

/** One sweep at a time, process-wide. The scheduler ticks, the operator's
 *  diagnostic endpoint and any future caller all share the in-flight sweep
 *  instead of reconciling the same store concurrently. A sweep that outlives
 *  SYNC_ABANDON_MS is abandoned: the guard releases and the next caller runs
 *  a fresh sweep, so stalled I/O can never wedge the board until restart.
 *  The abandoned sweep itself is harmless if it later settles: it only ever
 *  adds records that are still missing, keyed by repo + PR. */
export async function syncQaFromGithub(snapshot = deskPrs()): Promise<QaSyncResult> {
  if (syncInFlight) return syncInFlight;
  const run = syncQaFromGithubOnce(snapshot);
  syncInFlight = run;
  const abandon = setTimeout(() => {
    if (syncInFlight === run) syncInFlight = null;
  }, SYNC_ABANDON_MS);
  abandon.unref();
  const clear = () => {
    clearTimeout(abandon);
    if (syncInFlight === run) syncInFlight = null;
  };
  void run.then(clear, clear);
  return run;
}

async function syncQaFromGithubOnce(snapshot = deskPrs()): Promise<QaSyncResult> {
  const authoritative = snapshotAuthoritative(snapshot);
  let added = 0;
  if (authoritative) {
    const known = new Set((await qaAllItems()).map((i) => `${i.repo.trim().toLowerCase()}#${i.pr}`));
    for (const pr of snapshot.prs) {
      if (pr.state !== 'merged' || !qaRepoAllowed(pr.repo)) continue;
      const key = `${pr.repo.trim().toLowerCase()}#${pr.number}`;
      // Known keys (open cards and validated tombstones alike) are left
      // exactly as the flow left them: re-upserting them would rewrite the
      // store and advance updatedAt on every two-minute sweep while
      // changing nothing. Authoritative re-routing still arrives through
      // the merge-signal endpoint, which upserts explicitly.
      if (known.has(key)) continue;
      const stagingUrl = (await previewUrlFor(pr.repo, pr.number)) ?? undefined;
      const created = await upsertQaItem({ repo: pr.repo, pr: pr.number, title: pr.title, app: appForRepo(pr.repo), stagingUrl });
      if (created) added += 1;
    }
  }
  const now = Date.now();
  const missing = (await qaAllItems())
    .filter((i) => i.status !== 'validated' && i.status !== 'parked' && !i.stagingUrl && now - (previewTried.get(i.id) ?? 0) > PREVIEW_RETRY_MS)
    .slice(0, PREVIEW_FILLS_PER_SWEEP);
  for (const item of missing) {
    previewTried.set(item.id, now);
    const stagingUrl = await previewUrlFor(item.repo, item.pr);
    if (stagingUrl) await upsertQaItem({ repo: item.repo, pr: item.pr, title: item.title, app: item.app, stagingUrl });
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
