// Open pull requests per teammate for the Desk. Pulled with gh's existing
// read-only auth across both owners. Every author shares one login, so the
// branch prefix is the owner map (naomi/ -> Naomi, ...); an unmapped prefix
// renders under its login. States: draft / ci (a check still running) /
// open + reviewer (a pending review request on an otherwise open PR; Kip and
// Riley mapped by login) / merged (within the 48h staging window, and for
// TARDIS only until the live tree contains the merge).
// The pull never blocks the request path: it runs async in the background
// (kicked at boot and whenever the cache expires), a failed repo keeps its
// last-known-good PRs and marks the snapshot stale, and the server always
// serves the last snapshot immediately.
import { execFile } from 'node:child_process';

export type DeskPr = {
  owner: string;
  repo: string;
  number: number;
  title: string;
  state: 'draft' | 'ci' | 'merged' | 'open';
  reviewer?: string;
  url: string;
  updatedAt: string;
};

export type DeskPrSnapshot = { prs: DeskPr[]; stale: boolean };

const REPOS = [
  'mrchevyceleb/TARDIS',
  'R-Link-LLC/operly',
  'R-Link-LLC/r-link-studio-rebuild',
  'mrchevyceleb/penguin-rush-2',
  'mrchevyceleb/FiscalPilot',
];

const PREFIX_OWNERS: Record<string, string> = {
  naomi: 'Naomi', jill: 'Jill', christina: 'Christina', maria: 'Maria', adam: 'Adam',
  riley: 'Riley', felix: 'Felix', sam: 'Samwise', kip: 'Kip', kate: 'Kate', max: 'Max',
  quinn: 'Quinn', wren: 'Wren', tim: 'Tim', piper: 'Piper', work: 'Studio',
};

const MERGED_WINDOW_MS = 48 * 60 * 60_000;
const CACHE_MS = 5 * 60_000;
const LIST_FIELDS = 'number,title,headRefName,author,isDraft,state,url,updatedAt,reviewRequests,statusCheckRollup,mergeCommit,mergedAt';

type RawPr = {
  number: number;
  title: string;
  headRefName?: string;
  author?: { login?: string };
  isDraft?: boolean;
  state?: string;
  url?: string;
  updatedAt?: string;
  mergedAt?: string;
  reviewRequests?: Array<{ login?: string }>;
  statusCheckRollup?: Array<{ state?: string }>;
  mergeCommit?: { oid?: string };
};

type GhResult = RawPr[] | null; // null = this pull failed (CLI, auth, timeout, parse)

function gh(args: string[]): Promise<GhResult> {
  return new Promise((resolve) => {
    execFile('gh', ['pr', 'list', ...args], { encoding: 'utf8', timeout: 20_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) { resolve(null); return; }
      try {
        const parsed: unknown = JSON.parse(stdout);
        resolve(Array.isArray(parsed) ? (parsed as RawPr[]) : null);
      } catch { resolve(null); }
    });
  });
}

/** The running service's tree: the server process runs from the repo root, so
 *  its cwd is the live checkout (a side copy's cwd is the side copy, which
 *  keeps the check exact per boot). */
function liveTreeContains(oid?: string): Promise<boolean> {
  if (!oid) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile('git', ['merge-base', '--is-ancestor', oid, 'HEAD'], { timeout: 5_000 }, (error) => resolve(!error));
  });
}

function ownerFor(pr: RawPr): string {
  const branch = pr.headRefName ?? '';
  const slash = branch.indexOf('/');
  if (slash > 0) {
    const mapped = PREFIX_OWNERS[branch.slice(0, slash).toLowerCase()];
    if (mapped) return mapped;
  }
  return pr.author?.login || 'unknown';
}

function reviewerFor(pr: RawPr): string | undefined {
  const logins = (pr.reviewRequests ?? [])
    .map((r) => (r.login ?? '').trim())
    .filter(Boolean);
  for (const login of logins) {
    const lower = login.toLowerCase();
    if (lower.includes('kip')) return 'Kip';
    if (lower.includes('riley')) return 'Riley';
  }
  return logins[0];
}

/** A check still running (a completed check, passing or failing, is not CI
 *  state; the PR is simply open with its checks done). */
function hasPendingChecks(pr: RawPr): boolean {
  return (pr.statusCheckRollup ?? []).some((c) => (c.state ?? '').toUpperCase() !== 'COMPLETED');
}

/** Last-known-good PR list per repo, so a failed pull keeps yesterday's truth
 *  on the board instead of erasing teammates into "idle". */
const lastGood = new Map<string, DeskPr[]>();
let snapshot: DeskPrSnapshot = { prs: [], stale: false };
let refreshedAt = 0;
let refreshing: Promise<void> | null = null;

async function pullAll(): Promise<DeskPrSnapshot> {
  const mergedCutoff = new Date(Date.now() - MERGED_WINDOW_MS).toISOString();
  const staleRepos: string[] = [];
  const pulls = await Promise.all(REPOS.map(async (repo) => ({
    repo,
    open: await gh(['-R', repo, '--state', 'open', '--limit', '50', '--json', LIST_FIELDS]),
    // Server-side merged-date filter: the 48h window, not a page of 30.
    merged: await gh(['-R', repo, '--state', 'merged', '--search', `merged:>=${mergedCutoff}`, '--limit', '100', '--json', LIST_FIELDS]),
  })));
  const prs: DeskPr[] = [];
  for (const { repo, open, merged } of pulls) {
    if (!open || !merged) {
      staleRepos.push(repo);
      prs.push(...(lastGood.get(repo) ?? []));
      continue;
    }
    const repoPrs: DeskPr[] = [];
    for (const pr of [...open, ...merged]) {
      const state = pr.state ?? 'OPEN';
      if (state === 'MERGED') {
        const at = Date.parse(pr.mergedAt ?? '');
        if (!Number.isFinite(at) || at < Date.now() - MERGED_WINDOW_MS) continue;
        // TARDIS drops exactly when the live tree contains the merge (the
        // running service is on it); other repos use the 48h window proxy.
        if (repo === 'mrchevyceleb/TARDIS' && await liveTreeContains(pr.mergeCommit?.oid)) continue;
        repoPrs.push({ owner: ownerFor(pr), repo, number: pr.number, title: pr.title, state: 'merged', url: pr.url ?? '', updatedAt: pr.mergedAt ?? pr.updatedAt ?? '' });
        continue;
      }
      const deskState: DeskPr['state'] = pr.isDraft ? 'draft' : hasPendingChecks(pr) ? 'ci' : 'open';
      const reviewer = deskState === 'open' ? reviewerFor(pr) : undefined;
      repoPrs.push({ owner: ownerFor(pr), repo, number: pr.number, title: pr.title, state: deskState, ...(reviewer ? { reviewer } : {}), url: pr.url ?? '', updatedAt: pr.updatedAt ?? '' });
    }
    lastGood.set(repo, repoPrs);
    prs.push(...repoPrs);
  }
  if (staleRepos.length) console.warn('[deskPrs] stale repos (serving last-known-good):', staleRepos.join(', '));
  prs.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return { prs, stale: staleRepos.length > 0 };
}

/** Serve the last snapshot immediately; refresh in the background whenever it
 *  has expired. Never blocks, never throws. */
export function deskPrs(): DeskPrSnapshot {
  if (!refreshing && Date.now() - refreshedAt >= CACHE_MS) {
    refreshing = (async () => {
      try {
        snapshot = await pullAll();
      } catch (error) {
        console.warn('[deskPrs] pull failed:', (error as Error)?.message ?? error);
      } finally {
        refreshedAt = Date.now();
        refreshing = null;
      }
    })();
  }
  return snapshot;
}

// Kick the first background pull at boot so the first request already finds
// data settling in.
void deskPrs();
