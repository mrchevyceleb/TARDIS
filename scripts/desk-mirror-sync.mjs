#!/usr/bin/env node
// One-shot full sync of the Dev PR Tracker mirror (Matt, Oct 9 2026).
// Pushes every eligible Rally-lane Desk card (live state, or a closing
// tombstone for archived cards — the receiver refuses to create a row for a
// tombstone), then one reconcile call that closes any mirror row whose Desk
// card left the Rally lane. Safe to re-run: the mirror upserts keyed by
// Desk card id. Run on Moria with DESK_MIRROR_URL and DESK_MIRROR_SECRET
// in the env: node scripts/desk-mirror-sync.mjs
// The server-side hook (server/src/lib/deskMirror.ts) keeps the mirror
// current on every mutation once the server env carries the same two vars.
const DESK = process.env.DESK_URL || 'http://127.0.0.1:8091/api/desk';
const URL = process.env.DESK_MIRROR_URL?.trim();
const SECRET = process.env.DESK_MIRROR_SECRET?.trim();
if (!URL || !SECRET) {
  console.error('DESK_MIRROR_URL and DESK_MIRROR_SECRET are required');
  process.exit(1);
}

// Mirrors server/src/lib/deskMirror.ts (Max, Oct 9 2026: no KG-KimGarst;
// plus the Rally-lane developers regardless of project).
const PROJECTS = new Set(['operly', 'studio', 'r-link studio', 'rallypoint', 'rally', 'support']);
const OWNERS = new Set(['kip', 'christina', 'maria', 'adam']);
const ALIASES = {
  up_next: 'not_started', upnext: 'not_started', next: 'not_started', todo: 'not_started', pipeline: 'not_started',
  waiting: 'in_progress', blocked: 'in_progress',
  done: 'in_production',
};
const PR_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+\/?$/;

async function push(payload) {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8_000),
  });
  return res.ok;
}

const res = await fetch(DESK);
if (!res.ok) { console.error(`desk read failed: ${res.status}`); process.exit(1); }
const data = await res.json();
// A malformed response must abort before any push or reconcile: an
// unrecognized body reconciled as an empty lane would close every row.
if (!data || !Array.isArray(data.cards)) { console.error('desk response has no cards array; aborting'); process.exit(1); }
const eligible = (data.cards ?? []).filter((c) =>
  PROJECTS.has((c.project ?? '').trim().toLowerCase()) ||
  OWNERS.has((c.owner?.name ?? '').trim().toLowerCase()));
const live = eligible.filter((c) => !c.archived);
const archived = eligible.filter((c) => c.archived);
console.log(`eligible: ${eligible.length} (${live.length} live, ${archived.length} archived tombstones) of ${(data.cards ?? []).length} cards`);
let ok = 0;
let failed = 0;
for (const card of live) {
  const payload = {
    desk_card_id: card.id,
    title: card.title,
    stage: ALIASES[card.column] ?? card.column,
    pr_urls: (card.links ?? []).filter((l) => PR_URL.test(l)),
    project: card.project ?? '',
    archived: false,
    desk_updated_at: card.updatedAt,
  };
  try {
    if (await push(payload)) ok += 1; else { failed += 1; console.error(`${card.id} -> not ok`); }
  } catch (err) {
    failed += 1;
    console.error(`${card.id} error:`, err.message);
  }
}
let closed = 0;
for (const card of archived) {
  try {
    if (await push({ desk_card_id: card.id, title: card.title, stage: ALIASES[card.column] ?? card.column, archived: true, desk_updated_at: card.updatedAt })) closed += 1; else failed += 1;
  } catch (err) {
    failed += 1;
    console.error(`${card.id} tombstone error:`, err.message);
  }
}
let reconciled = 0;
try {
  // Fresh read after every push settled, with a cutoff timestamp: rows the
  // receiver updated after this moment are immune, so a card created or moved
  // during the sweep can never be closed by a stale id set.
  const cutoff = new Date().toISOString();
  const freshRes = await fetch(DESK, { signal: AbortSignal.timeout(8_000) });
  if (!freshRes.ok) { failed += 1; console.error(`fresh desk read failed: ${freshRes.status}; skipping reconcile`); }
  // Live cards only: an archived card's row must NOT be protected by the
  // reconcile, so a failed tombstone is repaired by it. A non-2xx or malformed
  // fresh response never reconciles at all.
  const freshData = freshRes.ok ? await freshRes.json().catch(() => null) : null;
  const freshIds = freshData && Array.isArray(freshData.cards)
    ? freshData.cards.filter((c) => !c.archived && (PROJECTS.has((c.project ?? '').trim().toLowerCase()) || OWNERS.has((c.owner?.name ?? '').trim().toLowerCase()))).map((c) => c.id)
    : null;
  if (!freshIds) { failed += 1; console.error('fresh desk read unavailable or malformed; skipping reconcile'); }
  const r = freshIds && await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({ reconcile_ids: freshIds, updated_before: cutoff }),
    signal: AbortSignal.timeout(20_000),
  });
  if (r) {
    if (r.ok) {
      const body = await r.json().catch(() => ({}));
      reconciled = Number(body?.closed) || 0;
    } else { failed += 1; console.error(`reconcile -> ${r.status}`); }
  }
} catch (err) {
  failed += 1;
  console.error('reconcile error:', err.message);
}
console.log(`pushed: ${ok}, tombstones: ${closed}, reconciled-closed: ${reconciled}, failed: ${failed}`);
process.exit(failed ? 1 : 0);
