import { spawn } from 'node:child_process';

const OUTPUT_CAP = 16_000;
let warned = false;

/** Optional, local-only OCR for model/tool-result accessibility. A screenshot
 * has already been shared with the model; OCR adds no new authority. Failure
 * never turns proven keyboard input into an uncertain/retryable operation. */
export async function computerOcr(image: unknown, signal?: AbortSignal): Promise<string | undefined> {
  if (process.env.RIVENDELL_COMPUTER_OCR === 'off' || typeof image !== 'string' || image.length > 3 * 1024 * 1024) return undefined;
  let input: Buffer;
  try { input = Buffer.from(image, 'base64'); } catch { return undefined; }
  if (!input.length || input.length > 2 * 1024 * 1024) return undefined;
  const command = process.env.RIVENDELL_COMPUTER_OCR_COMMAND?.trim() || 'tesseract';
  try {
    const text = await new Promise<string>((resolve, reject) => {
      let stdout = '', stderr = '', settled = false;
      const child = spawn(command, ['stdin', 'stdout', '--psm', '6'], { stdio: ['pipe', 'pipe', 'pipe'], signal });
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error) reject(error); else resolve(stdout);
      };
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('OCR timed out')); }, 10_000);
      timer.unref?.();
      child.stdout.on('data', chunk => { if (stdout.length < OUTPUT_CAP) stdout = (stdout + chunk.toString('utf8')).slice(0, OUTPUT_CAP); });
      child.stderr.on('data', chunk => { if (stderr.length < 1000) stderr = (stderr + chunk.toString('utf8')).slice(0, 1000); });
      child.on('error', finish);
      child.on('close', code => finish(code === 0 ? undefined : new Error(stderr || `OCR exited ${code}`)));
      child.stdin.end(input);
    });
    const cleaned = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
    return cleaned ? cleaned.slice(0, 8000) : undefined;
  } catch (error) {
    if (!warned && !signal?.aborted) {
      warned = true;
      console.warn(`[computer] OCR unavailable; screenshots still work: ${error instanceof Error ? error.message : String(error)}`);
    }
    return undefined;
  }
}
