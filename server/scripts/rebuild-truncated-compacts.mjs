// One-time maintenance: rebuild rolling compacts truncated before the
// output-cap retry landed (c7de444). Compacts written by the old code could
// end mid-sentence and lose their tail forever; the durable log still has
// every covered turn, so each truncated compact is rebuilt from source
// through the same generation path the live compaction uses.
//
// Usage, from a repo checkout with node_modules present:
//   node --import tsx server/scripts/rebuild-truncated-compacts.mjs            # dry run: report
//   node --import tsx server/scripts/rebuild-truncated-compacts.mjs --apply   # rebuild

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from '../src/config.ts';
import { isTruncatedCompact, loadCompactBlob, rebuildTruncatedCompact } from '../src/chat/compaction.ts';

const apply = process.argv.includes('--apply');

let keys = [];
try {
  keys = Object.keys(JSON.parse(readFileSync(join(STATE_DIR, 'compaction-state.json'), 'utf8')));
} catch (err) {
  console.error(`[rebuild] cannot read compaction state: ${err.message}`);
  process.exit(1);
}

const flagged = [];
let withCompact = 0;
for (const key of keys) {
  const blob = loadCompactBlob(key);
  if (!blob) continue;
  withCompact += 1;
  if (isTruncatedCompact(blob.compact)) flagged.push(key);
}
console.log(`[rebuild] ${keys.length} state keys, ${withCompact} with a rolling compact, ${flagged.length} truncated (${apply ? 'APPLY' : 'dry run'})`);
for (const key of flagged) {
  const blob = loadCompactBlob(key);
  const tail = (blob.compact.trim().split('\n').filter((l) => l.trim()).pop() ?? '').slice(-100);
  console.log(`[rebuild]   ${key} (${blob.words}w) tail: ${JSON.stringify(tail)}`);
}

if (!apply) {
  console.log('[rebuild] dry run only: pass --apply to rebuild the flagged compacts');
  process.exit(0);
}

let done = 0;
let failed = 0;
for (const key of flagged) {
  try {
    const r = await rebuildTruncatedCompact(key, (msg) => console.log(`[rebuild] ${msg}`));
    console.log(`[rebuild] ${key}: rebuilt (${r.batches} batches, ${r.fed}/${r.covered} covered turns re-fed, ${r.words}w${r.hitBound ? ', HIT THE BATCH BOUND: re-run needed' : ''})`);
    done += 1;
  } catch (err) {
    console.error(`[rebuild] ${key}: FAILED: ${err.message}`);
    failed += 1;
  }
}
console.log(`[rebuild] done: ${done} rebuilt, ${failed} failed, of ${flagged.length} flagged`);
process.exit(failed ? 1 : 0);
