import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Fast path: Groq whisper-large-v3-turbo. Round-trips a typical dictation
// section in well under a second, versus the local CPU model that reloads
// faster-whisper for every chunk. The local venv stays as a fallback.
const GROQ_TRANSCRIPTIONS_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

let active = false;
export function transcriptionReady() {
  return Boolean(process.env.GROQ_API_KEY || process.env.CONTENT_TRANSCRIBE_PYTHON);
}

async function transcribeRemote(bytes: Buffer) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type: 'audio/wav' }), 'recording.wav');
  form.append('model', process.env.RIVENDELL_DICTATION_STT_MODEL || 'whisper-large-v3-turbo');
  form.append('response_format', 'json');
  const response = await fetch(GROQ_TRANSCRIPTIONS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw Object.assign(new Error(`Transcription service failed (${response.status}${detail ? `: ${detail.slice(0, 180)}` : ''}).`), { status: 502 });
  }
  const result = await response.json() as { text?: unknown };
  if (typeof result.text !== 'string' || result.text.length > 10000) throw new Error('Invalid transcript');
  return { text: result.text };
}

async function transcribeLocal(bytes: Buffer) {
  const python = process.env.CONTENT_TRANSCRIBE_PYTHON;
  if (!python) throw Object.assign(new Error('Dictation transcription is unavailable. You can still type your message.'), { status: 503 });
  // One local model in memory at a time; the remote path never takes this lock.
  if (active) throw Object.assign(new Error('Another recording is being transcribed. Try again shortly.'), { status: 409 });
  active = true; let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), 'tardis-dictation-')); const file = join(dir, 'recording.webm'); await writeFile(file, bytes, { mode: 0o600 });
    const script = fileURLToPath(new URL('../../../scripts/content-transcribe.py', import.meta.url));
    const { stdout } = await promisify(execFile)(python, [script, file], { timeout: 120000, maxBuffer: 256000, windowsHide: true });
    const result = JSON.parse(stdout); if (typeof result.text !== 'string' || result.text.length > 10000) throw new Error('Invalid transcript');
    return { text: result.text };
  } finally { active = false; if (dir) await rm(dir, { recursive: true, force: true }); }
}

export async function transcribeContent(bytes: Buffer) {
  if (process.env.GROQ_API_KEY) {
    try { return await transcribeRemote(bytes); }
    catch (error) {
      // Fall through to local whisper when it exists, so one API hiccup never
      // loses a recording. Without a local model the failure must surface.
      if (!process.env.CONTENT_TRANSCRIBE_PYTHON) throw error;
      console.warn('[dictation] remote transcription failed, falling back to local:', error instanceof Error ? error.message : error);
    }
  }
  return transcribeLocal(bytes);
}
