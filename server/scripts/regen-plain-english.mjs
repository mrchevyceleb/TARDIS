// One-time maintenance (Matt, Oct 14): regenerate rolling compacts in plain
// English after the COMPACT_SYSTEM prompt gained the plain-English rule.
// Each regeneration is ONE generation over the existing document with no
// new material: a single atomic commit, cross-process CAS against the
// original blob, the RAG mirror refreshed, and nothing written on any abort
// (a live compaction in flight, an oversized or identical result, a document
// that still ends mid-sentence, or a race). Coverage, cadence, and the
// state record never move.
//
// Usage, from a repo checkout with node_modules present:
//   node --import tsx server/scripts/regen-plain-english.mjs                 # the five lanes below
//   node --import tsx server/scripts/regen-plain-english.mjs --keys '<key>' [more]

import { regenerateCompactPlainEnglish } from '../src/chat/compaction.ts';

const DEFAULT_KEYS = [
  'thread|/home/mrchevyceleb/ASSISTANT-HUB|bot-kip',
  'thread|/home/mrchevyceleb/ASSISTANT-HUB|bot-quinn',
  'thread|/home/mrchevyceleb/ASSISTANT-HUB|bot-wren',
  'thread|/home/mrchevyceleb/ASSISTANT-HUB|bot-adam',
  'thread|/home/mrchevyceleb/ASSISTANT-HUB|bot-maria',
];

const argv = process.argv.slice(2);
let keys: string[] = DEFAULT_KEYS;
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--keys') {
    keys = argv.slice(i + 1).filter((k) => Boolean(k));
    break;
  }
}
if (!keys.length) {
  console.error('[regen] --keys needs at least one thread key');
  process.exit(2);
}

let failed = 0;
for (const key of keys) {
  try {
    const { words } = await regenerateCompactPlainEnglish(key, (msg) => console.log(`[regen] ${msg}`));
    console.log(`[regen] ${key}: regenerated (${words} words)`);
  } catch (err) {
    failed += 1;
    console.error(`[regen] ${key}: not regenerated: ${err instanceof Error ? err.message : String(err)}`);
  }
}
console.log(`[regen] done: ${keys.length - failed}/${keys.length} regenerated${failed ? ' (see the errors above; nothing was written for those lanes)' : ''}`);
process.exit(failed ? 1 : 0);
