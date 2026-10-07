// tsx entry for the no-vision Read guard (card-faf580). Called by
// scripts/vision-read-guard.sh with one image file path; prints the vision
// proxy's description on stdout. Any failure exits nonzero so the bash
// wrapper falls back to the plain no-image note. The standing vision proxy
// config (RIVENDELL_VISION_BASE_URL / _MODEL / _API_KEY) rides the CLI child
// env: the subscription scrub strips provider keys but not these.
import { describeImageFile } from '../src/chat/vision-adapter.ts';

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: vision-read-hook.ts <image-file>');
    process.exit(1);
  }
  try {
    const description = await describeImageFile(file);
    process.stdout.write(description);
  } catch (error) {
    console.error(`vision describe failed: ${(error as Error)?.message ?? error}`);
    process.exit(1);
  }
}

await main();
