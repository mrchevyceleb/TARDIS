// Open pull requests per teammate for the Desk. Pulled with gh's existing
// read-only auth across both owners, cached in memory for five minutes.
// Every author shares one login, so the branch prefix is the owner map
// (naomi/ -> Naomi, ...); an unmapped prefix renders under its login.
// States: draft / ci (statusCheckRollup present) / open + reviewer (a
// pending review request; Kip and Riley mapped by login) / merged (within
// the 48h staging window, and for TARDIS only until the live tree contains
// the merge, which means the running service is on it).
import { execFileSync } from 'node:child_process';

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

function ghJson(extra: string[]): RawPr[] {
  try {
    const out = execFileSync('gh', ['pr', 'list', ...extra], {
      encoding: 'utf8', timeout: 20_000, maxBuffer: 16 * 1024 * 1024,
    });
    const parsed: unknown = JSON.parse(out);
    return Array.isArray(parsed) ? (parsed as RawPr[]) : [];
  } catch {
    return [];
  }
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

/** The running service's tree: the server process runs from the repo root, so
 *  its cwd is the live checkout (a side copy's cwd is the side copy, which
 *  keeps the check exact per boot). */
function liveTreeContains(oid?: string): boolean {
  if (!oid) return false;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', oid, 'HEAD'], { stdio: 'ignore', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

let cache: { at: number; prs: DeskPr[] } | null = null;

export function deskPrs(): DeskPr[] {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.prs;
  const mergedCutoff = now - MERGED_WINDOW_MS;
  const prs: DeskPr[] = [];
  for (const repo of REPOS) {
    const isTardis = repo === 'mrchevyceleb/TARDIS';
    const open = ghJson(['-R', repo, '--state', 'open', '--limit', '50', '--json', LIST_FIELDS]);
    const merged = ghJson(['-R', repo, '--state', 'merged', '--limit', '30', '--json', LIST_FIELDS]);
    for (const pr of [...open, ...merged]) {
      const state = pr.state ?? 'OPEN';
      if (state === 'MERGED') {
        const at = Date.parse(pr.mergedAt ?? '');
        if (!Number.isFinite(at) || at < mergedCutoff) continue;
        // TARDIS drops exactly when the live tree contains the merge (the
        // running service is on it); other repos use the 48h window proxy.
        if (isTardis && liveTreeContains(pr.mergeCommit?.oid)) continue;
        prs.push({ owner: ownerFor(pr), repo, number: pr.number, title: pr.title, state: 'merged', url: pr.url ?? '', updatedAt: pr.mergedAt ?? pr.updatedAt ?? '' });
        continue;
      }
      const reviewer = reviewerFor(pr);
      const deskState: DeskPr['state'] = pr.isDraft ? 'draft' : (pr.statusCheckRollup?.length ? 'ci' : 'open');
      prs.push({ owner: ownerFor(pr), repo, number: pr.number, title: pr.title, state: deskState, ...(reviewer ? { reviewer } : {}), url: pr.url ?? '', updatedAt: pr.updatedAt ?? '' });
    }
  }
  prs.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  cache = { at: now, prs };
  return prs;
}
