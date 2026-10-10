#!/usr/bin/env node
// One-shot full sync of the Dev PR Tracker mirror (Matt, Oct 9 2026).
// Pushes every live Rally-lane Desk card to the tracker's desk-mirror
// function once; safe to re-run (the mirror upserts keyed by Desk card id).
// Run on Moria with DESK_MIRROR_URL and DESK_MIRROR_SECRET in the env:
//   node scripts/desk-mirror-sync.mjs
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

const res = await fetch(DESK);
if (!res.ok) { console.error(`desk read failed: ${res.status}`); process.exit(1); }
const data = await res.json();
const cards = (data.cards ?? []).filter((c) =>
  !c.archived && (
    PROJECTS.has((c.project ?? '').trim().toLowerCase()) ||
    OWNERS.has((c.owner?.name ?? '').trim().toLowerCase())
  ));
console.log(`eligible: ${cards.length} of ${(data.cards ?? []).length} live cards`);
let ok = 0;
let failed = 0;
for (const card of cards) {
  const payload = {
    desk_card_id: card.id,
    title: card.title,
    stage: ALIASES[card.column] ?? card.column,
    pr_urls: (card.links ?? []).filter((l) => /^https:\/\/github\.com\//.test(l)),
    project: card.project ?? '',
    archived: card.archived === true,
  };
  try {
    const r = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8_000),
    });
    if (r.ok) ok += 1; else { failed += 1; console.error(`${card.id} -> ${r.status}`); }
  } catch (err) {
    failed += 1;
    console.error(`${card.id} error:`, err.message);
  }
}
console.log(`pushed: ${ok}, failed: ${failed}`);
process.exit(failed ? 1 : 0);
