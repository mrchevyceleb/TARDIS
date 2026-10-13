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

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from '../src/config.ts';
import { isTruncatedCompact, listCompactBlobFiles, loadCompactBlob, rebuildTruncatedCompact } from '../src/chat/compaction.ts';

const argv = process.argv.slice(2);
// Structural parsing: options consume their own values, and only keys after
// --apply are apply keys (so `--apply 'key' --max-batches 90` never reads 90
// as a second key).
let apply = false;
let maxBatches;
const applyKeys = [];
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--apply') { apply = true; continue; }
  if (a === '--max-batches') {
    const v = argv[i + 1];
    if (v !== undefined && /^\d+$/.test(v)) {
      const n = Number(v);
      if (!Number.isSafeInteger(n) || n < 1 || n > 10000) {
        console.error(`[rebuild] invalid --max-batches value: ${v} (a positive integer up to 10000)`);
        process.exit(2);
      }
      maxBatches = n;
      i += 1;
    } else {
      console.error('[rebuild] --max-batches needs a positive integer value');
      process.exit(2);
    }
    continue;
  }
  if (a.startsWith('--')) continue;
  if (apply && a) applyKeys.push(a);
}
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

// Backup exactly the reviewed targets, each blob copied whole (every blob
// file is individually atomic, tmp+rename), with a manifest of the exact
// versions taken. No unrelated lane is touched by the repair, so the restore
// never needs to roll anything else back.
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = join(STATE_DIR, `thread-compacts.bak-${stamp}`);
mkdirSync(join(backup, 'thread-compacts'), { recursive: true });
const byKey = new Map(listCompactBlobFiles().map((f) => [f.key, f]));
const manifest = [];
for (const key of applyKeys) {
  const file = byKey.get(key);
  const blob = loadCompactBlob(key);
  if (!file || !blob) continue;
  // Raw bytes, not a re-read through the parser: the backup holds exactly
  // what was on disk, and the manifest records its digest so a restore (or
  // an audit) can prove the version.
  const bytes = readFileSync(join(COMPACTS_DIR, `${file.file}.json`));
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  writeFileSync(join(backup, 'thread-compacts', `${file.file}.json`), bytes);
  manifest.push(`${key} -> ${file.file}.json (${blob.words}w, lastCompactedSeq ${blob.lastCompactedSeq}, lastAt ${new Date(blob.lastAt).toISOString()}, sha256 ${digest})`);
}
writeFileSync(join(backup, 'MANIFEST.txt'), `Backed-up targets only (restore by copying the named file back into ~/.rivendell/thread-compacts):
${manifest.join('\n')}
`);
console.log(`[rebuild] backup written: ${backup} (${manifest.length} target blob(s), manifest inside)`);

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
