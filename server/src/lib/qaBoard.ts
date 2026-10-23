// The QA board record: the single source of truth behind both the testers'
// board and Sam's pinned Slack lists. One record per item, keyed by its
// repo + PR number, so a staging merge lands exactly once and a Slack thread
// reply is the only thing that moves it. The board renders from these same
// records, so the two views can never drift apart.
//
// Records never carry who built the item: Edgar, Martin and Sud read this
// page, and the builder's identity stays off it by construction (there is
// simply no field for it, and a leading "Name — " in a PR title is stripped
// on the way in).
//
// The board is an optional private integration: it stays off until the
// deployment configures QA repos AND tester logins by environment
// (open-source safety), and a checkout without them serves no QA data.
//
// A validated record is kept as a tombstone: it is off the board, but its
// presence is what makes a delayed or retried merge signal land as a no-op
// instead of resurrecting finished work. Nothing here ever deletes a
// record on a schedule; the self-check flags drift, a person resolves it.

import { randomUUID } from 'node:crypto';
import { JsonStore } from './jsonStore.ts';
import { STATE_DIR } from '../config.ts';

export type QaTesterId = 'sud' | 'edgar' | 'martin';
export type QaStatus = 'up_next' | 'testing' | 'fixing' | 'retest' | 'validated';
export type QaApp = 'Operly' | 'Studio';

export type QaItem = {
  id: string;
  /** Repo slug (owner/name) the item merged from. */
  repo: string;
  /** PR number within that repo; the dedupe key together with `repo`. */
  pr: number;
  title: string;
  app: QaApp;
  tester: QaTesterId;
  status: QaStatus;
  /** ISO instant the item is due back by (about 2h after it lands). */
  dueAt: string;
  slackThreadUrl?: string;
  slackThreadTs?: string;
  stagingUrl?: string;
  createdAt?: string;
  updatedAt?: string;
};

export const QA_TESTERS: { id: QaTesterId; name: string }[] = [
  { id: 'sud', name: 'Sud' },
  { id: 'edgar', name: 'Edgar' },
  { id: 'martin', name: 'Martin' },
];

const STATUSES: QaStatus[] = ['up_next', 'testing', 'fixing', 'retest', 'validated'];

function splitEnv(name: string): string[] {
  return (process.env[name] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

const canonRepo = (repo: string) => repo.trim().toLowerCase();

/** Deployment configuration, never code: RIVENDELL_QA_REPOS turns the board
 *  on; RIVENDELL_QA_TESTER_LOGINS maps tester ids to their board logins
 *  (comma-separated id=login pairs). Both must be set; unset or "off"
 *  leaves the board off. */
function configuredRepos(): string[] {
  const configured = splitEnv('RIVENDELL_QA_REPOS');
  return configured.length && configured[0].toLowerCase() !== 'off' ? configured.map(canonRepo) : [];
}

/** Tester logins are only valid as a complete, unique assignment: every
 *  tester has one, no two testers share one, no unknown ids. Anything less
 *  is rejected wholesale (undefined), because a partial map once let a
 *  duplicate login authenticate one tester as another, and a missing login
 *  silently hid a tester's column. A deployment with a broken map runs no
 *  QA board at all, which fails loudly at startup instead of insecurely. */
export function configuredTesterLogins(): Record<QaTesterId, string> | undefined {
  const map: Record<string, string> = {};
  for (const pair of splitEnv('RIVENDELL_QA_TESTER_LOGINS')) {
    const eq = pair.indexOf('=');
    if (eq > 0) map[pair.slice(0, eq).trim().toLowerCase()] = pair.slice(eq + 1).trim();
  }
  const ids = Object.keys(map);
  if (ids.length !== QA_TESTERS.length) return undefined;
  const logins = QA_TESTERS.map(({ id }) => (map[id] ?? '').trim().toLowerCase());
  if (logins.some((login) => !login)) return undefined;
  if (new Set(logins).size !== QA_TESTERS.length) return undefined;
  return map as Record<QaTesterId, string>;
}

export function qaBoardEnabled(): boolean {
  const secret = (process.env.RIVENDELL_QA_AUTH_SECRET ?? '').trim();
  return configuredRepos().length > 0 && configuredTesterLogins() !== undefined && secret.length > 0;
}

export const qaRepos = (): string[] => configuredRepos();

/** Only configured QA repos may ever land a card. */
export function qaRepoAllowed(repo: string): boolean {
  return qaRepos().includes(canonRepo(repo));
}

/** The login a tester signs in with, or undefined when the tester-login
 *  config is absent or invalid. The board never names a tester it cannot
 *  authenticate. */
export function qaTesterLogin(id: QaTesterId): string | undefined {
  return configuredTesterLogins()?.[id];
}

export function qaTesterByLogin(login: string): QaTesterId | undefined {
  const wanted = login.trim().toLowerCase();
  const logins = configuredTesterLogins();
  if (!logins) return undefined;
  for (const tester of QA_TESTERS) {
    if (logins[tester.id]?.toLowerCase() === wanted) return tester.id;
  }
  return undefined;
}

/** Routing rule from the flow: explicit tester first, then the Sud list for
 *  Sud-flagged work and Edgar/Martin's own work, then by app (Operly to
 *  Martin, Studio to Edgar). */
export function routeQaItem(input: { tester?: string; needsSud?: boolean; builderIsTester?: boolean; app: QaApp }): QaTesterId {
  const requested = (input.tester ?? '').trim().toLowerCase();
  if (requested === 'sud' || requested === 'edgar' || requested === 'martin') return requested;
  if (input.needsSud || input.builderIsTester) return 'sud';
  return input.app === 'Operly' ? 'martin' : 'edgar';
}

/** Card titles never name the builder. PR titles in this flow often arrive
 *  as "Name — the work"; strip that leading name (and an explicitly passed
 *  builder name in any separator form) so the card shows the work only. */
export function sanitizeQaTitle(title: string, builder?: string): string {
  let out = title.trim();
  if (builder?.trim()) {
    const escaped = builder.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`^${escaped}\\s*[—–:\\-]\\s*`, 'i'), '');
  }
  out = out.replace(/^[A-Z][a-z]{1,19}\s+[—–]\s+/, '');
  return out.trim() || title.trim();
}

const store = new JsonStore<QaItem>('qa-board.json', [], STATE_DIR);

const byPriority = (a: QaItem, b: QaItem) =>
  a.dueAt === b.dueAt ? (a.createdAt ?? '') < (b.createdAt ?? '') ? -1 : 1 : a.dueAt < b.dueAt ? -1 : 1;

/** Open items grouped by tester, each list in priority order (earliest due
 *  first, so the first card is always "do this one now"). Validated items
 *  have dropped off. */
export async function qaBoard(): Promise<Record<QaTesterId, QaItem[]>> {
  const items = (await store.list()).filter((i) => i.status !== 'validated');
  const board: Record<QaTesterId, QaItem[]> = { sud: [], edgar: [], martin: [] };
  for (const item of items) board[item.tester]?.push(item);
  for (const tester of QA_TESTERS) board[tester.id].sort(byPriority);
  return board;
}

/** The key that makes "a staging merge adds the card" idempotent. */
const keyOf = (repo: string, pr: number) => `${canonRepo(repo)}#${pr}`;

export async function qaItemByKey(repo: string, pr: number): Promise<QaItem | null> {
  const items = await store.list();
  return items.find((i) => keyOf(i.repo, i.pr) === keyOf(repo, pr)) ?? null;
}

export type QaUpsertInput = {
  repo: string;
  pr: number;
  title: string;
  app: QaApp;
  tester?: string;
  needsSud?: boolean;
  builderIsTester?: boolean;
  /** Accepted so the routing layer can say who built it; used only to keep
   *  that name out of the stored title, never stored itself. */
  builder?: string;
  dueAt?: string;
  slackThreadUrl?: string;
  slackThreadTs?: string;
  stagingUrl?: string;
  status?: QaStatus;
};

/** Add an item, or refresh the one already there for that PR. The whole
 *  read-modify-write runs inside the store's serialized chain, so two
 *  concurrent merge signals for the same PR can only ever produce one
 *  record. A repeat merge signal never clears a status the thread already
 *  moved, and an explicit routing signal (tester, Sud flag) re-routes an
 *  existing card, so a card first seen by the sync still lands in the
 *  right column when the authoritative signal arrives. Returns null when
 *  the repo is not a configured QA repo. */
export async function upsertQaItem(input: QaUpsertInput): Promise<QaItem | null> {
  if (!qaRepoAllowed(input.repo)) return null;
  const repo = input.repo.trim();
  const key = keyOf(repo, input.pr);
  let result: QaItem | null = null;
  await store.modify((items) => {
    const index = items.findIndex((i) => keyOf(i.repo, i.pr) === key);
    if (index >= 0) {
      const existing = items[index];
      const patch: Partial<QaItem> = {
        title: input.title ? sanitizeQaTitle(input.title, input.builder) : existing.title,
        app: input.app,
        repo,
        slackThreadUrl: input.slackThreadUrl ?? existing.slackThreadUrl,
        slackThreadTs: input.slackThreadTs ?? existing.slackThreadTs,
        stagingUrl: input.stagingUrl ?? existing.stagingUrl,
      };
      if (input.tester !== undefined || input.needsSud || input.builderIsTester) patch.tester = routeQaItem(input);
      if (existing.status === 'validated' && input.status && input.status !== 'validated') patch.status = input.status;
      result = { ...existing, ...patch, updatedAt: new Date().toISOString() };
      items[index] = result;
      return items;
    }
    const now = new Date().toISOString();
    result = {
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      repo,
      pr: input.pr,
      title: sanitizeQaTitle(input.title, input.builder),
      app: input.app,
      tester: routeQaItem(input),
      status: input.status && STATUSES.includes(input.status) ? input.status : 'up_next',
      dueAt: input.dueAt ?? new Date(Date.now() + 2 * 3_600_000).toISOString(),
      slackThreadUrl: input.slackThreadUrl,
      slackThreadTs: input.slackThreadTs,
      stagingUrl: input.stagingUrl,
    };
    return [result, ...items];
  });
  return result;
}

/** Move or clear an item from its Slack thread outcome. "validated" is the
 *  only signal that drops a card, and it is terminal: the check runs inside
 *  the same serialized write as the update, so a delayed fail racing a
 *  validated can never resurrect finished work. A fail returns the item to
 *  the loop as retest for Sud, or back to testing for Edgar and Martin, who
 *  fix it themselves. */
export async function applyQaOutcome(id: string, outcome: string): Promise<QaItem | null> {
  const items = await store.list();
  const item = items.find((i) => i.id === id);
  if (!item) return null;
  const word = outcome.trim().toLowerCase();
  let status: QaStatus | null = null;
  if (word === 'validated' || word === 'pass' || word === 'passes' || word === 'passed' || word === 'works') status = 'validated';
  else if (word === 'testing') status = 'testing';
  else if (word === 'fixing') status = 'fixing';
  else if (word === 'retest') status = 'retest';
  else if (word === 'fail' || word === 'fails' || word === 'failed' || word === 'broken') status = item.tester === 'sud' ? 'retest' : 'testing';
  else if (STATUSES.includes(word as QaStatus)) status = word as QaStatus;
  if (!status) return null;
  let result: QaItem | null = null;
  await store.modify((current) => current.map((entry) => {
    if (entry.id !== id) return entry;
    if (entry.status === 'validated' && status !== 'validated') { result = entry; return entry; }
    result = { ...entry, status, updatedAt: new Date().toISOString() };
    return result;
  }));
  return result;
}

/** The one-line-per-item list Sam pins in Slack for a tester. Rendered from
 *  the same records as the board, so the pinned list and the board agree by
 *  construction. */
export function qaPinnedList(tester: QaTesterId, items: QaItem[]): string {
  const name = QA_TESTERS.find((t) => t.id === tester)?.name ?? tester;
  const open = items.filter((i) => i.tester === tester && i.status !== 'validated');
  const lines = open.map((item, index) => {
    const due = new Date(item.dueAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const status = item.status.replace('_', ' ');
    return `${index + 1}. ${item.title} [${status}] due ${due}${item.slackThreadUrl ? ` ${item.slackThreadUrl}` : ''}`;
  });
  return [`${name}'s live list`, ...(lines.length ? lines : ['All clear.'])].join('\n');
}

/** Self-check against the external truth: a record is stale when its PR is
 *  neither open in a QA repo nor merged into staging, and a record without
 *  a thread link can never be acted on. One entry per record. Validated
 *  tombstones are history, not drift. Returns the problems found; an empty
 *  list means the board matches. This only ever reports: a card leaves the
 *  board through its Slack thread outcome, never by deletion here, because
 *  the GitHub snapshot cannot tell "closed unmerged" from "merged a while
 *  ago", and deleting on that guess would erase live work. */
export type QaDrift = { id: string; reason: string };

export function qaDriftCheck(items: QaItem[], truth: { repo: string; pr: number; state: 'open' | 'merged' | 'closed' | 'missing' }[]): QaDrift[] {
  const drift: QaDrift[] = [];
  const byKey = new Map(truth.map((t) => [keyOf(t.repo, t.pr), t]));
  for (const item of items) {
    if (item.status === 'validated') continue;
    const reasons: string[] = [];
    const seen = byKey.get(keyOf(item.repo, item.pr));
    if (!seen || seen.state === 'closed' || seen.state === 'missing') reasons.push('PR is closed or gone but the item is still open');
    if (!item.slackThreadUrl && !item.slackThreadTs) reasons.push('no Slack thread linked');
    if (reasons.length) drift.push({ id: item.id, reason: reasons.join('; ') });
  }
  return drift;
}

export async function qaAllItems(): Promise<QaItem[]> {
  return store.list();
}
