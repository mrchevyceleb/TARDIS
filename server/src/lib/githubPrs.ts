// Open pull requests per teammate for the Desk. Pulled with gh's existing
// read-only auth across the configured repos. Every author shares one login, so the
// branch prefix is the owner map (naomi/ -> Naomi, ...); an unmapped prefix
// renders under its login. States: draft / ci (a check still running) /
// open + reviewer (a pending review request on an otherwise open PR; Kip and
// Riley mapped by login) / merged (within the 48h staging window, and for
// the live repo only until the live tree contains the merge).
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

export type DeskPrSnapshot = {
  prs: DeskPr[];
  stale: boolean;
  pending: boolean;
  unknown: boolean;
  disabled: boolean;
  /** Repos never successfully pulled, and repos whose last pull failed.
   *  Per-repo truth, so one board's broken repo cannot read as another
   *  board's staleness and a consumer can tell "my repos were never
   *  pulled" apart from "no merges anywhere". */
  failedRepos: string[];
  unknownRepos: string[];
};

/** Deployment configuration, never code (AGENTS.md open-source safety: an
 *  optional private integration stays disabled until explicitly configured
 *  by environment, and no deployment identity is baked into the repo).
 *  RIVENDELL_DESK_PR_REPOS (comma-separated owner/name) turns the pull on;
 *  unset, empty or "off" leaves it disabled and the routes serve no PR data
 *  at all, exactly like an older server (the client degrades by design).
 *  Credentials stay gh's own configured auth; a purpose-scoped token can be
 *  pinned by the deployment env later (gh honors GH_TOKEN) with no code
 *  change. */
/** The Desk's own repos, for the Desk room and sidebar only. */
const DESK_REPOS = (() => {
  const configured = (process.env.RIVENDELL_DESK_PR_REPOS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return configured.length && configured[0].toLowerCase() !== 'off' ? configured : [];
})();

/** The pull covers the Desk repos plus any repos another board owns through
 *  its own setting (the QA board's RIVENDELL_QA_REPOS), deduplicated. A QA
 *  repo nobody told the snapshot about would otherwise mean that board's
 *  sync sees a healthy-looking snapshot that can never contain its merges:
 *  permanent no-op sweeps with no signal anywhere. Consumers filter by
 *  their own repo list (the Desk route by deskRepos(), the QA sync by
 *  qaRepos()), so one board's repos never leak into another board's view
 *  and RIVENDELL_DESK_PR_REPOS=off still turns the Desk pull fully off. */
const REPOS = [...new Set([
  ...DESK_REPOS,
  ...(process.env.RIVENDELL_QA_REPOS ?? '').split(',').map((s) => s.trim()).filter((s) => s && s.toLowerCase() !== 'off'),
])];

const canonRepo = (repo: string) => repo.trim().toLowerCase();
const isDeskRepo = (repo: string) => DESK_REPOS.some((r) => canonRepo(r) === canonRepo(repo));

/** The Desk room's repo list; the Desk routes never serve PRs outside it. */
export function deskRepos(): string[] { return [...DESK_REPOS]; }

/** True when every given repo was actually pulled for this snapshot: named
 *  in the pull and neither failed nor never-seen. "No merges anywhere" is
 *  then distinguishable from "my repos were never pulled", which is the
 *  silent no-op the QA board must never sit in. */
export function snapshotCoversRepos(snapshot: DeskPrSnapshot, repos: string[]): boolean {
  const wanted = new Set(repos.map(canonRepo).filter(Boolean));
  if (!wanted.size || snapshot.pending || snapshot.disabled) return false;
  const pulled = new Set(REPOS.map(canonRepo));
  const failed = new Set(snapshot.failedRepos.map(canonRepo));
  const unknown = new Set(snapshot.unknownRepos.map(canonRepo));
  for (const repo of wanted) {
    if (!pulled.has(repo) || failed.has(repo) || unknown.has(repo)) return false;
  }
  return true;
}

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
  statusCheckRollup?: Array<{ state?: string; status?: string }>;
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

/** The repo whose live-tree drop applies (a merge disappears from the board
 *  once the running service's tree contains it): derived from this
 *  checkout's own origin remote so no identity is hard-coded;
 *  RIVENDELL_DESK_PR_LIVE_REPO overrides, and a checkout whose remote cannot
 *  be parsed simply uses the 48h window for every repo. */
let liveRepoCache: string | null | undefined;
function liveRepo(): Promise<string | null> {
  if (liveRepoCache !== undefined) return Promise.resolve(liveRepoCache);
  const configured = (process.env.RIVENDELL_DESK_PR_LIVE_REPO ?? '').trim();
  if (configured) { liveRepoCache = configured; return Promise.resolve(configured); }
  return new Promise((resolve) => {
    execFile('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 5_000 }, (error, stdout) => {
      const m = error ? null : /([^/:@\s]+)\/([^/\s]+?)(?:\.git)?\s*$/.exec(stdout.trim());
      liveRepoCache = m ? `${m[1]}/${m[2]}` : null;
      resolve(liveRepoCache);
    });
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
 *  state; the PR is simply open with its checks done). Check runs report
 *  `status` (QUEUED/IN_PROGRESS/COMPLETED); commit statuses report `state`
 *  (PENDING/SUCCESS/FAILURE/ERROR). Only a genuinely unfinished one counts. */
function hasPendingChecks(pr: RawPr): boolean {
  return (pr.statusCheckRollup ?? []).some((c) => {
    const status = typeof c.status === 'string' ? c.status.toUpperCase() : '';
    if (status) return status !== 'COMPLETED';
    const state = typeof c.state === 'string' ? c.state.toUpperCase() : '';
    return state === 'PENDING';
  });
}

/** Last-known-good PR list per repo, so a failed pull keeps yesterday's truth
 *  on the board instead of erasing teammates into "idle". */
const lastGood = new Map<string, DeskPr[]>();
let snapshot: DeskPrSnapshot = REPOS.length
  ? { prs: [], stale: false, pending: true, unknown: false, disabled: false, failedRepos: [...REPOS], unknownRepos: [...REPOS] }
  : { prs: [], stale: false, pending: false, unknown: false, disabled: true, failedRepos: [], unknownRepos: [] };
let refreshedAt = 0;
let refreshing: Promise<void> | null = null;

async function pullAll(): Promise<{ prs: DeskPr[]; stale: boolean; unknown: boolean; failedRepos: string[]; unknownRepos: string[] }> {
  const mergedCutoff = new Date(Date.now() - MERGED_WINDOW_MS).toISOString();
  const staleRepos: string[] = [];
  const unknownRepos: string[] = [];
  const live = await liveRepo();
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
      // Serving last-known-good re-applies the merged cutoff, so a repo that
      // keeps failing cannot pin "merged to staging" past the window; a repo
      // with no data ever is unknown, so the client never asserts idle.
      const cached = lastGood.get(repo);
      if (!cached) unknownRepos.push(repo);
      else prs.push(...cached.filter((p) => p.state !== 'merged' || Date.parse(p.updatedAt) >= Date.now() - MERGED_WINDOW_MS));
      continue;
    }
    // One PR can appear in both lists (it merged between the two requests):
    // deduplicate by number, preferring the merged record, else the newer.
    const byNumber = new Map<number, DeskPr>();
    for (const pr of [...open, ...merged]) {
      const state = pr.state ?? 'OPEN';
      if (state === 'MERGED') {
        const at = Date.parse(pr.mergedAt ?? '');
        if (!Number.isFinite(at) || at < Date.now() - MERGED_WINDOW_MS) continue;
        // The live repo drops exactly when the live tree contains the merge
        // (the running service is on it); other repos use the 48h window.
        if (live && repo === live && await liveTreeContains(pr.mergeCommit?.oid)) continue;
        byNumber.set(pr.number, { owner: ownerFor(pr), repo, number: pr.number, title: pr.title, state: 'merged', url: pr.url ?? '', updatedAt: pr.mergedAt ?? pr.updatedAt ?? '' });
        continue;
      }
      const deskState: DeskPr['state'] = pr.isDraft ? 'draft' : hasPendingChecks(pr) ? 'ci' : 'open';
      const reviewer = deskState === 'open' ? reviewerFor(pr) : undefined;
      const candidate: DeskPr = { owner: ownerFor(pr), repo, number: pr.number, title: pr.title, state: deskState, ...(reviewer ? { reviewer } : {}), url: pr.url ?? '', updatedAt: pr.updatedAt ?? '' };
      const prev = byNumber.get(pr.number);
      if (!prev || candidate.state === 'merged' || (prev.state !== 'merged' && candidate.updatedAt > prev.updatedAt)) byNumber.set(pr.number, candidate);
    }
    const repoPrs = [...byNumber.values()];
    lastGood.set(repo, repoPrs);
    prs.push(...repoPrs);
  }
  if (staleRepos.length) console.warn('[deskPrs] stale repos (serving last-known-good):', staleRepos.join(', '), unknownRepos.length ? `never pulled: ${unknownRepos.join(', ')}` : '');
  prs.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.repo === b.repo ? a.number - b.number : a.repo < b.repo ? -1 : 1));
  // Stale/unknown stay Desk-scoped flags (the Desk payload's contract); the
  // per-repo lists carry the unfiltered truth for other consumers.
  const deskFailed = staleRepos.filter(isDeskRepo);
  const deskUnknown = unknownRepos.filter(isDeskRepo);
  return { prs, stale: deskFailed.length > 0, unknown: deskUnknown.length > 0, failedRepos: staleRepos, unknownRepos };
}

/** Serve the last snapshot immediately; refresh in the background whenever it
 *  has expired. Never blocks, never throws. */
export function deskPrs(): DeskPrSnapshot {
  if (REPOS.length && !refreshing && Date.now() - refreshedAt >= CACHE_MS) {
    refreshing = (async () => {
      try {
        snapshot = { ...await pullAll(), pending: false, disabled: false };
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
// data settling in — only when the deployment configured repos.
if (REPOS.length) void deskPrs();
