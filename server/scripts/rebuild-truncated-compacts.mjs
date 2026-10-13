// One-time maintenance: rebuild rolling compacts truncated before the
// output-cap retry landed (c7de444). Compacts written by the old code could
// end mid-sentence and lose their tail forever; the durable log (archive +
// hot) still has every covered turn, so each truncated compact can be
// rebuilt from source through the same generation path the live compaction
// uses.
//
// Nothing is rewritten automatically: the dry run reports candidates, and
// --apply takes the EXPLICIT reviewed key list. Every rebuild is one atomic
// commit (a bound hit or a race writes nothing), guarded by a cross-process
// check against the live server, with a full backup written first.
//
// Usage, from a repo checkout with node_modules present:
//   node --import tsx server/scripts/rebuild-truncated-compacts.mjs                        # dry run
//   node --import tsx server/scripts/rebuild-truncated-compacts.mjs --apply '<key>' [more]  # rebuild the reviewed list
//   ... --max-batches 90                                                                     # raise the per-run bound

import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from '../src/config.ts';
import { isTruncatedCompact, listCompactBlobFiles, loadCompactBlob, rebuildTruncatedCompact } from '../src/chat/compaction.ts';

const argv = process.argv.slice(2);
const applyIdx = argv.indexOf('--apply');
const apply = applyIdx >= 0;
const applyKeys = apply ? argv.slice(applyIdx + 1).filter((a) => !a.startsWith('--') && a !== '') : [];
const maxBatchesIdx = argv.indexOf('--max-batches');
const maxBatches = maxBatchesIdx >= 0 && /^\d+$/.test(argv[maxBatchesIdx + 1] ?? '') ? parseInt(argv[maxBatchesIdx + 1], 10) : undefined;
const COMPACTS_DIR = join(STATE_DIR, 'thread-compacts');
const STATE_FILE = join(STATE_DIR, 'compaction-state.json');
// The output-cap retry went live at the Oct 13 2026 17:14:43 ET restart. A
// truncated compact stamped after that is not a pre-fix truncation: it is a
// live-bug signal to investigate with the team, never something to rewrite.
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
console.log(`[rebuild] ${keys.length} state keys, ${withCompact} with a rolling compact, ${flagged.length} truncated (${candidates.length} pre-cap-retry candidates, ${investigate.length} post-cap-retry to investigate), ${orphanTruncated.length} orphan file(s)`);
for (const key of candidates) {
  const blob = loadCompactBlob(key);
  const tail = (blob.compact.trim().split('\n').filter((l) => l.trim()).pop() ?? '').slice(-100);
  console.log(`[rebuild]   candidate ${key} (${blob.words}w, lastAt ${new Date(blob.lastAt).toISOString()}) tail: ${JSON.stringify(tail)}`);
}
for (const key of investigate) {
  const blob = loadCompactBlob(key);
  console.log(`[rebuild]   INVESTIGATE (stamped after the cap-retry went live — a live-bug signal, do not rewrite): ${key} (${blob.words}w, lastAt ${new Date(blob.lastAt).toISOString()})`);
}
if (candidates.length) {
  const list = candidates.map((k) => `'${k}'`).join(' ');
  console.log(`[rebuild] reviewed and dry-run-verified candidates. To rebuild exactly these, run:`);
  console.log(`[rebuild]   node --import tsx server/scripts/rebuild-truncated-compacts.mjs --apply ${list}`);
}

if (!apply) {
  console.log('[rebuild] dry run only: --apply needs the explicit reviewed key list');
  process.exit(0);
}
if (!applyKeys.length) {
  console.error('[rebuild] --apply requires the explicit reviewed key list (the dry run prints the command)');
  process.exit(2);
}
const unknown = applyKeys.filter((k) => !candidates.includes(k));
if (unknown.length) {
  console.error(`[rebuild] refusing: not reviewed pre-cap-retry candidates: ${unknown.join(', ')}`);
  process.exit(2);
}

// A full backup first: the repair rewrites the compact blobs. Each blob file
// is individually atomic (tmp+rename), so every copied file is coherent; a
// live write during the copy can only leave the backup a mix of older and
// newer per-file versions, never a torn file. On restore, prefer each blob's
// own lastAt over the state file's cadence — adoptCompaction reconciles
// newer-wins.
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = join(STATE_DIR, `thread-compacts.bak-${stamp}`);
cpSync(COMPACTS_DIR, join(backup, 'thread-compacts'), { recursive: true });
cpSync(STATE_FILE, join(backup, 'compaction-state.json'));
writeFileSync(join(backup, 'README.txt'), 'Backup taken before the truncated-compact rebuild. Restore by copying thread-compacts/* back into ~/.rivendell/thread-compacts and compaction-state.json back into ~/.rivendell. Each blob file is atomic; on restore prefer each blob\'s own lastAt over the state cadence (adoptCompaction reconciles newer-wins).\n');
console.log(`[rebuild] backup written: ${backup}`);

let done = 0;
let failed = 0;
for (const key of applyKeys) {
  try {
    const r = await rebuildTruncatedCompact(key, (msg) => console.log(`[rebuild] ${msg}`), maxBatches);
    console.log(`[rebuild] ${key}: rebuilt (${r.batches} batches, ${r.fed}/${r.covered} covered turns re-fed, ${r.words}w)`);
    done += 1;
  } catch (err) {
    console.error(`[rebuild] ${key}: FAILED: ${err.message}`);
    failed += 1;
  }
}
console.log(`[rebuild] done: ${done} rebuilt, ${failed} failed, of ${applyKeys.length} requested`);
process.exit(failed ? 1 : 0);
