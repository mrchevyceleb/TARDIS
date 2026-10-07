import express, { Router, raw } from 'express';
import { createReadStream, createWriteStream, mkdirSync } from 'node:fs';
import { link, realpath, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { extname, basename, join, resolve as resolvePath, sep as pathSep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeFileName, storeWorkspaceFile, workspaceRoot } from '../lib/workspace.ts';
import { trustedWebSocketOrigin } from '../lib/origin.ts';
import { emitScribe } from '../worker/scribe.ts';
import { STATE_DIR } from '../config.ts';
import { mapWorkspaceError } from './docs.ts';
import { asyncHandler } from './helpers.ts';

export const filesRouter = Router();

// Stream a file from the OneDrive-synced ASSISTANT-HUB workspace at its real
// content type. Used by Hall link cards (Browser button) and by `rivendell://`
// fallbacks when the one-time Windows handler is not installed. Tailscale ACLs
// are the authn boundary — anyone on the tailnet can reach this, same as the
// rest of `:8091`. Path is workspace-relative; absolute paths and `..` escapes
// are refused.
filesRouter.get('/raw', asyncHandler(async (req, res) => {
  const requested = String(req.query.path || '');
  if (!requested) {
    res.status(400).json({ error: 'path is required' });
    return;
  }
  const root = workspaceRoot();
  // Reject obvious absolute paths up front so we never resolve them against
  // the workspace root by accident.
  if (requested.startsWith('/') || /^[A-Za-z]:[\\/]/.test(requested)) {
    res.status(400).json({ error: 'path must be workspace-relative' });
    return;
  }
  const lexicalAbs = resolvePath(root, requested);

  // Resolve symlinks on both the workspace root and the requested target. A
  // lexical prefix check alone wouldn't catch a symlink inside the workspace
  // pointing somewhere else on disk — `stat` would happily follow it.
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = await realpath(root);
  } catch {
    res.status(500).json({ error: 'workspace root is not accessible' });
    return;
  }
  try {
    realTarget = await realpath(lexicalAbs);
  } catch {
    res.status(404).json({ error: 'file not found' });
    return;
  }
  const rootWithSep = realRoot.endsWith(pathSep) ? realRoot : realRoot + pathSep;
  if (realTarget !== realRoot && !realTarget.startsWith(rootWithSep)) {
    res.status(400).json({ error: 'path is outside the workspace' });
    return;
  }

  let info;
  try {
    info = await stat(realTarget);
  } catch {
    res.status(404).json({ error: 'file not found' });
    return;
  }
  if (!info.isFile()) {
    res.status(400).json({ error: 'path is not a file' });
    return;
  }

  const name = basename(realTarget);
  const contentType = mimeFor(realTarget);
  const forceDownload = req.query.download === '1' || req.query.download === 'true';
  const dispositionType = forceDownload || !browserSafe(contentType) ? 'attachment' : 'inline';

  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `${dispositionType}; filename="${quoteFilename(name)}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  res.setHeader('Accept-Ranges', 'bytes');
  // Workspace files are user-controlled and may contain hostile scripts (a
  // saved HTML report, a malformed SVG). When we serve them inline at
  // TARDIS's own origin, sandbox the response so any embedded JS can't
  // reach back into /api/* routes. Mirrors the artifacts route's policy.
  if (dispositionType === 'inline') {
    res.setHeader(
      'Content-Security-Policy',
      "sandbox; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:",
    );
  }

  const range = parseRange(req.headers.range, info.size);
  if (range) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${info.size}`);
    res.setHeader('Content-Length', String(range.end - range.start + 1));
    createReadStream(realTarget, { start: range.start, end: range.end }).pipe(res);
    return;
  }

  res.setHeader('Content-Length', String(info.size));
  createReadStream(realTarget).pipe(res);
}));

// One-time installer for the Windows-side `rivendell://` URL handler. Served
// as a plain-text PowerShell script the operator downloads on each Windows PC and runs
// once. The script registers an HKCU URL scheme entry and writes a sibling
// handler script that translates `rivendell://open?winpath=...` URLs into
// `Start-Process` against the OneDrive-synced ASSISTANT-HUB copy.
filesRouter.get('/installer/windows.ps1', asyncHandler(async (_req, res) => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const scriptPath = resolvePath(here, '..', '..', '..', 'scripts', 'windows', 'install-rivendell-handler.ps1');
  let info;
  try {
    info = await stat(scriptPath);
  } catch {
    res.status(500).json({ error: 'installer script missing on server' });
    return;
  }
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="install-rivendell-handler.ps1"');
  res.setHeader('Content-Length', String(info.size));
  res.setHeader('Cache-Control', 'no-store');
  createReadStream(scriptPath).pipe(res);
}));

function parseRange(header: string | undefined, totalSize: number): { start: number; end: number } | null {
  if (!header || !header.startsWith('bytes=')) return null;
  const spec = header.slice('bytes='.length).split(',')[0]?.trim();
  if (!spec) return null;
  const [startStr, endStr] = spec.split('-');
  const start = startStr ? Number.parseInt(startStr, 10) : NaN;
  const end = endStr ? Number.parseInt(endStr, 10) : totalSize - 1;
  if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || end >= totalSize || start > end) return null;
  return { start, end };
}

function quoteFilename(name: string): string {
  return name.replace(/["\\\r\n]/g, '');
}

function browserSafe(contentType: string): boolean {
  if (contentType.startsWith('text/')) return true;
  if (contentType.startsWith('image/')) return true;
  if (contentType.startsWith('audio/')) return true;
  if (contentType.startsWith('video/')) return true;
  if (contentType === 'application/pdf') return true;
  if (contentType === 'application/json') return true;
  if (contentType === 'application/javascript') return true;
  return false;
}

const MIME_BY_EXT: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.mdx': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.doc': 'application/msword',
  '.xls': 'application/vnd.ms-excel',
  '.ppt': 'application/vnd.ms-powerpoint',
};

function mimeFor(path: string): string {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

// Drop a file onto the console and it lands in the workspace (inbox/ is the
// usual destination). Body is the raw file, workspace-relative destination,
// never overwrites. There is no app-layer auth, so two things keep a random
// web page from posting files here from a browser on the tailnet: only
// application/octet-stream is accepted (a non-simple type, so a cross-site
// request needs a CORS preflight this server never answers), and any Origin
// that is sent must be one the operator trusts.
const UPLOAD_BODY_LIMIT = '200mb';
const UPLOAD_TYPE = 'application/octet-stream';

// Refuse untrusted origins before the body parser buffers anything.
function requireTrustedOrigin(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!trustedWebSocketOrigin(req)) {
    res.status(403).json({ error: 'origin not trusted' });
    return;
  }
  next();
}

filesRouter.post('/upload', requireTrustedOrigin, raw({ type: UPLOAD_TYPE, limit: UPLOAD_BODY_LIMIT }), asyncHandler(async (req, res) => {
  const body: unknown = req.body;
  if (!Buffer.isBuffer(body)) {
    res.status(415).json({ error: `send the file as ${UPLOAD_TYPE}` });
    return;
  }
  const requested = String(req.query.path || '').trim();
  if (!requested) {
    res.status(400).json({ error: 'path is required' });
    return;
  }
  if (requested.startsWith('/') || /^[A-Za-z]:[\\/]/.test(requested)) {
    res.status(400).json({ error: 'path must be workspace-relative' });
    return;
  }
  // Every segment has to be legal on every platform the workspace syncs to.
  const segments = requested.replace(/\\/g, '/').split('/').filter(Boolean).map(safeFileName);
  if (segments.length === 0 || segments.some((segment) => !segment)) {
    res.status(400).json({ error: 'path needs a usable file name' });
    return;
  }
  const destination = segments.join('/');
  try {
    const result = await storeWorkspaceFile(destination, body);
    // The file is on disk at this point; the activity log is best effort.
    try {
      await emitScribe({
        level: 'system',
        text: `Workspace: received ${result.path}`,
        payload: { kind: 'workspace-change', op: 'add', path: result.path, by: 'human' },
      });
    } catch (error) {
      console.error('[files] upload logged to scribe failed:', error);
    }
    res.status(201).json(result);
  } catch (err) {
    const { status, message } = mapWorkspaceError(err);
    res.status(status).json({ error: message });
  }
}));

// ---- big-file streaming upload (any type, multi-GB) -------------------------------

/** Big uploads land here, OUTSIDE the Syncthing-synced workspace so a 5 GB
 *  video never syncs to Matt's PC and iPad, and outside the chat-attachment
 *  store so the 2 GB attachment sweep never touches them. Per-day folders. */
const UPLOAD_STREAM_DIR = join(STATE_DIR, 'uploads');
/** Same cap as Riley's :8798 phone upload page. */
const UPLOAD_STREAM_MAX_BYTES = 16 * 1024 * 1024 * 1024;

// Streams any file type straight to disk (Riley's PUT pattern): the body is
// piped, never buffered in memory, so a multi-GB phone upload cannot balloon
// RAM. Same two guards as /upload above: octet-stream only (a non-simple
// type, so a cross-site POST needs a CORS preflight this server never
// answers) and a trusted Origin. The response carries the saved absolute
// path so the client can put it in the message and any agent can open the
// file. Node's requestTimeout is handled globally in index.ts (see the
// comment there: on Node 25 it is measured from request start with no reset
// on body data, so even an actively-flowing multi-GB body longer than the
// deadline would be cut).
filesRouter.post('/upload-stream', requireTrustedOrigin, (req, res) => {
  const type = String(req.headers['content-type'] ?? '').toLowerCase();
  if (!type.startsWith(UPLOAD_TYPE)) {
    res.status(415).json({ error: `send the file as ${UPLOAD_TYPE}` });
    return;
  }
  const expected = Number(req.headers['content-length'] ?? 0);
  if (!Number.isFinite(expected) || expected <= 0 || expected > UPLOAD_STREAM_MAX_BYTES) {
    res.status(400).json({ error: 'Content-Length must be between 1 byte and 16 GB' });
    return;
  }
  const name = safeFileName(String(req.query.name ?? '').trim().split(/[\\/]/).pop() ?? '') || 'file';
  const dir = join(UPLOAD_STREAM_DIR, new Date().toISOString().slice(0, 10));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Unique exclusive temp file: two concurrent uploads of the same name never
  // share a .part file or race one destination (review 1). The final name is
  // claimed atomically with link(2), which never overwrites; EEXIST just takes
  // the next numeric suffix (Riley's -2, -3, ...).
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  const temp = join(dir, `.${stem}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}.part`);
  const out = createWriteStream(temp, { mode: 0o600, flags: 'wx' });
  let received = 0;
  let settled = false;
  // Cleanup waits for the stream to really close before unlinking the temp
  // file (a rm racing an open descriptor can fail and leave residue), and a
  // failed cleanup is logged, never swallowed (review 1).
  const outClosed = new Promise<void>((resolve) => out.on('close', resolve));
  const cleanupTemp = () => {
    out.destroy();
    void outClosed
      .then(() => rm(temp, { force: true }))
      .catch((err) => console.warn('[files] upload temp cleanup failed:', (err as Error)?.message ?? err));
  };
  const fail = (status: number, message: string) => {
    if (settled) return;
    settled = true;
    if (!res.headersSent) res.status(status).json({ error: message });
    cleanupTemp();
    req.destroy();
  };
  req.on('data', (chunk: Buffer) => {
    received += chunk.length;
    if (received > UPLOAD_STREAM_MAX_BYTES) fail(413, 'over the 16 GB cap');
  });
  req.on('error', () => fail(400, 'the upload stream failed'));
  req.on('close', () => {
    if (!settled && !req.complete) fail(400, 'the upload was cut off');
  });
  out.on('error', () => fail(500, 'could not write the upload'));
  req.pipe(out);
  out.on('finish', () => {
    if (settled) return;
    if (received !== expected) {
      fail(400, 'the upload ended early');
      return;
    }
    // link(2) claims the destination atomically and never overwrites. settled
    // only flips after the claim succeeds (review 1): a claim error still
    // answers the request with 500 and cleans up the temp file.
    (async () => {
      for (let i = 1; ; i += 1) {
        const target = join(dir, i === 1 ? name : `${stem}-${i}${ext}`);
        try {
          await link(temp, target);
          return target;
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
        }
      }
    })().then(
      (dest) => {
        settled = true;
        console.log(`[files] stream upload saved ${dest} (${received} bytes)`);
        if (!res.destroyed) res.status(201).json({ path: dest, name: basename(dest), bytes: received });
        // The claim already made the file visible; the temp unlink is
        // best-effort and logged, never a client failure.
        void rm(temp, { force: true }).catch((err) =>
          console.warn('[files] upload temp unlink failed:', (err as Error)?.message ?? err),
        );
      },
      () => fail(500, 'could not save the upload'),
    );
  });
});
