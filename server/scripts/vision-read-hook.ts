// tsx entry for the no-vision image guard (card-faf580). Called by
// scripts/vision-read-guard.sh with one image file path, or by device-mcp
// with `--stdin <mediaType>` and base64 on stdin. Prints the vision proxy's
// description on stdout. Any failure exits nonzero so the caller falls back
// to a plain no-image note. The standing vision proxy config
// (RIVENDELL_VISION_BASE_URL / _MODEL / _API_KEY) rides the CLI child env:
// the subscription scrub strips provider keys but not these.
import { describeImageBase64, describeImageFile, MAX_IMAGE_B64_CHARS } from '../src/chat/vision-adapter.ts';

// The stdin path is for device captures: images only, and bounded while being
// read (review 2). An oversized or non-image payload exits before it is ever
// buffered in full; the decoded-size check inside the adapter stays as
// defense in depth.
const STDIN_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']);

function readStdinBounded(maxChars: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    process.stdin.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxChars) {
        process.stdin.destroy();
        reject(new Error(`stdin image exceeds the encoded size limit (~${Math.round(maxChars / 1024 / 1024)}MB base64)`));
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on('error', reject);
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').trim()));
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  try {
    if (argv[0] === '--stdin') {
      const mediaType = argv[1] || 'image/jpeg';
      if (!STDIN_MEDIA_TYPES.has(mediaType)) {
        console.error(`vision-read-hook: unsupported stdin media type: ${mediaType}`);
        process.exit(1);
      }
      const base64 = await readStdinBounded(MAX_IMAGE_B64_CHARS);
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
