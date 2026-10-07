// tsx entry for the no-vision image guard (card-faf580). Called by
// scripts/vision-read-guard.sh with one image file path, or by device-mcp
// with `--stdin <mediaType>` and base64 on stdin. Prints the vision proxy's
// description on stdout. Any failure exits nonzero so the caller falls back
// to a plain no-image note. The standing vision proxy config
// (RIVENDELL_VISION_BASE_URL / _MODEL / _API_KEY) rides the CLI child env:
// the subscription scrub strips provider keys but not these.
import { readFileSync } from 'node:fs';
import { describeImageBase64, describeImageFile } from '../src/chat/vision-adapter.ts';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  try {
    if (argv[0] === '--stdin') {
      const mediaType = argv[1] || 'image/jpeg';
      const base64 = readFileSync(0, 'utf8').trim();
      if (!base64) {
        console.error('vision-read-hook: empty stdin');
        process.exit(1);
      }
      process.stdout.write(await describeImageBase64(base64, mediaType));
      return;
    }
    const file = argv[0];
    if (!file) {
      console.error('usage: vision-read-hook.ts <image-file> | --stdin <mediaType>');
      process.exit(1);
    }
    process.stdout.write(await describeImageFile(file));
  } catch (error) {
    console.error(`vision describe failed: ${(error as Error)?.message ?? error}`);
    process.exit(1);
  }
}

await main();
