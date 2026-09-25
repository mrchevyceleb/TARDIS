// Chat image attachments. Pasted/dropped images used to live only in the
// client's memory (the _user_echo event carried just a count), so a reload
// lost them. Now the runners persist each image to
// ~/.rivendell/attachments/<id> on send and the echo carries attachment refs;
// the client renders thumbnails from /api/chat/attachments/<id>, which are
// cheap URLs that survive the localStorage snapshot (data: URLs don't).

import { Router } from 'express';
import { createReadStream, existsSync, mkdirSync } from 'node:fs';
import { writeFile, rm, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { STATE_DIR } from '../config.ts';
import { asyncHandler } from './helpers.ts';

const ATTACH_DIR = join(STATE_DIR, 'attachments');

/** Absolute path of a saved attachment id, for handing a file to an agent. */
export function chatAttachmentPath(id: string): string {
  return join(ATTACH_DIR, id);
}
// A pasted screenshot is a few hundred KB; 12 MB per image leaves room for
// full-res photos without letting a runaway client fill the disk.
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_IMAGES_PER_TURN = 6;
const MAX_TURN_BYTES = 24 * 1024 * 1024;

const EXT_FOR: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** Magic-byte signature per allowed format — declared mediaType alone is not
 *  trusted (arbitrary bytes must never be served as an image from our origin). */
function matchesMagic(buf: Buffer, ext: string): boolean {
  if (ext === 'png') return buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (ext === 'jpg') return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (ext === 'webp') return buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
  if (ext === 'gif') return buf.length > 6 && buf.toString('ascii', 0, 4) === 'GIF8';
  return false;
}

export type ChatAttachmentRef = { id: string; mediaType: string };

/** Persist a turn's images; returns the refs the _user_echo event carries.
 *  NEVER throws and never blocks the loop: a bad/oversized image or a disk
 *  error drops that one image — the chat turn must always proceed. */
export async function saveChatAttachments(images: Array<{ mediaType: string; base64: string }> | undefined): Promise<ChatAttachmentRef[]> {
  if (!Array.isArray(images) || !images.length) return [];
  const out: ChatAttachmentRef[] = [];
  let total = 0;
  for (const img of images.slice(0, MAX_IMAGES_PER_TURN)) {
    try {
      // base64 inflates ~4/3 — reject by encoded length before decoding.
      if (!img.base64 || (img.base64.length * 3) / 4 > MAX_IMAGE_BYTES) continue;
      const ext = EXT_FOR[img.mediaType];
      if (!ext) continue; // declared type outside the whitelist
      const buf = Buffer.from(img.base64, 'base64');
      if (!buf.length || buf.length > MAX_IMAGE_BYTES) continue;
      if (total + buf.length > MAX_TURN_BYTES) continue;
      if (!matchesMagic(buf, ext)) continue; // bytes don't match the claim
      const id = `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const file = join(ATTACH_DIR, id);
      mkdirSync(ATTACH_DIR, { recursive: true, mode: 0o700 });
      await writeFile(file, buf, { mode: 0o600 });
      total += buf.length;
      out.push({ id, mediaType: img.mediaType });
      sweepAttachmentsIfNeeded();
    } catch (err) {
      console.warn('[chat-attachments] image skipped:', (err as Error).message);
    }
  }
  return out;
}

// Bounded store: 2GB aggregate quota with an hourly sweep that evicts
// oldest-first but never anything newer than 7 days (recent thumbs must not
// vanish from live threads).
const QUOTA_BYTES = 2 * 1024 * 1024 * 1024;
const KEEP_NEWER_THAN_MS = 7 * 24 * 60 * 60 * 1000;
let lastSweepAt = 0;
function sweepAttachmentsIfNeeded(): void {
  const now = Date.now();
  if (now - lastSweepAt < 60 * 60 * 1000) return;
  lastSweepAt = now;
  void (async () => {
    try {
      const entries = await readdir(ATTACH_DIR, { withFileTypes: true });
      const files: Array<{ name: string; size: number; mtimeMs: number }> = [];
      let total = 0;
      for (const e of entries) {
        if (!e.isFile()) continue;
        const st = await stat(join(ATTACH_DIR, e.name));
        files.push({ name: e.name, size: st.size, mtimeMs: st.mtimeMs });
        total += st.size;
      }
      if (total <= QUOTA_BYTES) return;
      files.sort((a, b) => a.mtimeMs - b.mtimeMs);
      let freed = 0;
      for (const f of files) {
        if (total <= QUOTA_BYTES) break;
        if (now - f.mtimeMs < KEEP_NEWER_THAN_MS) continue;
        await rm(join(ATTACH_DIR, f.name), { force: true });
        total -= f.size;
        freed += f.size;
      }
      console.warn(`[chat-attachments] quota sweep freed ${(freed / 1024 / 1024).toFixed(1)} MB (store over 2GB)`);
    } catch { /* dir may not exist yet */ }
  })();
}

export const chatAttachmentsRouter = Router();

chatAttachmentsRouter.get('/:id', asyncHandler(async (req, res) => {
  const id = String(req.params.id ?? '');
  // Path hygiene: generated ids are word chars + one dot; anything else is a no.
  if (!/^[\w-]+\.(png|jpg|webp|gif)$/.test(id)) {
    res.status(400).json({ error: 'bad attachment id' });
    return;
  }
  const file = join(ATTACH_DIR, id);
  if (!existsSync(file)) {
    res.status(404).json({ error: 'attachment not found' });
    return;
  }
  const mediaType = id.endsWith('.jpg') ? 'image/jpeg' : `image/${id.slice(id.lastIndexOf('.') + 1)}`;
  res.setHeader('Content-Type', mediaType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  const stream = createReadStream(file);
  stream.on('error', () => {
    if (!res.headersSent) res.status(500).json({ error: 'attachment unreadable' });
    else res.destroy();
  });
  stream.pipe(res);
}));
