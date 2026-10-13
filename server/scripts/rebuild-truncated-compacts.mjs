// One-time maintenance: rebuild rolling compacts truncated before the
// output-cap retry landed (c7de444). Compacts written by the old code could
// end mid-sentence and lose their tail forever; the durable log (archive +
// hot) still has every covered turn, so each truncated compact is rebuilt
// from source through the same generation path the live compaction uses.
//
// Usage, from a repo checkout with node_modules present:
//   node --import tsx server/scripts/rebuild-truncated-compacts.mjs            # dry run: report
//   node --import tsx server/scripts/rebuild-truncated-compacts.mjs --apply   # back up, then rebuild

import { cpSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from '../src/config.ts';
import { isTruncatedCompact, listCompactBlobFiles, loadCompactBlob, rebuildTruncatedCompact } from '../src/chat/compaction.ts';

const apply = process.argv.includes('--apply');
const COMPACTS_DIR = join(STATE_DIR, 'thread-compacts');
const STATE_FILE = join(STATE_DIR, 'compaction-state.json');
// The output-cap retry went live at the Oct 13 2026 17:14:43 ET restart. A
// truncated compact stamped after that means the retry itself failed — that
// is a live bug to investigate with the team, never something to quietly
// rewrite over.
const CAP_RETRY_LIVE_AT = Date.parse('2026-10-13T17:14:43-04:00');

let keys = [];
try {
  keys = Object.keys(JSON.parse(readFileSync(STATE_FILE, 'utf8')));
} catch (err) {
  console.error(`[rebuild] cannot read compaction state: ${err.message}`);
  process.exit(1);
}

// Discovery: union the compaction-state keys with every blob file on disk, so
// a blob whose state write failed cannot be silently skipped.
const blobFiles = listCompactBlobFiles();
const orphanTruncated = blobFiles.filter((f) => f.key === null && f.blob && isTruncatedCompact(f.blob.compact));
for (const f of orphanTruncated) {
  console.log(`[rebuild] ORPHAN: compact file ${f.file}.json is truncated with no compaction-state key — resolve its thread key manually before it can be rebuilt`);
}

const flagged = [];
let withCompact = 0;
for (const key of keys) {
  const blob = loadCompactBlob(key);
  if (!blob) continue;
  withCompact += 1;
  if (isTruncatedCompact(blob.compact)) flagged.push(key);
}

const candidates = [];
const investigate = [];
for (const key of flagged) {
  const blob = loadCompactBlob(key);
  if ((blob?.lastAt ?? 0) < CAP_RETRY_LIVE_AT) candidates.push(key);
  else investigate.push(key);
}
console.log(`[rebuild] ${keys.length} state keys, ${withCompact} with a rolling compact, ${flagged.length} truncated (${candidates.length} rebuild candidates, ${investigate.length} post-cap-retry to investigate), ${orphanTruncated.length} orphan file(s) (${apply ? 'APPLY' : 'dry run'})`);
for (const key of candidates) {
  const blob = loadCompactBlob(key);
  const tail = (blob.compact.trim().split('\n').filter((l) => l.trim()).pop() ?? '').slice(-100);
  console.log(`[rebuild]   candidate ${key} (${blob.words}w) tail: ${JSON.stringify(tail)}`);
}
for (const key of investigate) {
  const blob = loadCompactBlob(key);
  console.log(`[rebuild]   INVESTIGATE (stamped after the cap-retry went live — do not auto-rebuild): ${key} (${blob.words}w) tail: ${JSON.stringify((blob.compact.trim().split('\n').filter((l) => l.trim()).pop() ?? '').slice(-100))}`);
}

if (!apply) {
  console.log('[rebuild] dry run only: pass --apply to back up and rebuild the candidates');
  process.exit(0);
}

// A full backup first: the repair rewrites the compact blobs, and the old
// truncated documents stay recoverable verbatim.
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = join(STATE_DIR, `thread-compacts.bak-${stamp}`);
cpSync(COMPACTS_DIR, join(backup, 'thread-compacts'), { recursive: true });
cpSync(STATE_FILE, join(backup, 'compaction-state.json'));
console.log(`[rebuild] backup written: ${backup} (restore by copying back into ${STATE_DIR})`);

let done = 0;
let failed = 0;
for (const key of candidates) {
  try {
    const r = await rebuildTruncatedCompact(key, (msg) => console.log(`[rebuild] ${msg}`));
    console.log(`[rebuild] ${key}: rebuilt (${r.batches} batches, ${r.fed}/${r.covered} covered turns re-fed, ${r.words}w${r.hitBound ? ', HIT THE BATCH BOUND: re-run needed' : ''})`);
    done += 1;
  } catch (err) {
    console.error(`[rebuild] ${key}: FAILED: ${err.message}`);
    failed += 1;
  }
}
console.log(`[rebuild] done: ${done} rebuilt, ${failed} failed, of ${candidates.length} candidates (${investigate.length} investigate-only, ${orphanTruncated.length} orphan)`);
process.exit(failed ? 1 : 0);
