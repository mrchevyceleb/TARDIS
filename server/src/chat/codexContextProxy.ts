import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import * as zlib from 'node:zlib';
import WebSocket, { WebSocketServer } from 'ws';
import { recordNativeCall, recordNativeCompactBoundary } from './sessionMetrics.ts';
import { STATE_DIR } from './config.ts';

const capsuleFile = join(STATE_DIR, 'native-v2-capsules.json');
const MAX_PAYLOAD = 100 * 1024 * 1024;
const capsuleHash = (value: string) => createHash('sha256').update(value).digest('hex');
function savedCapsules(): Map<string, string[]> {
  try {
    const values = JSON.parse(readFileSync(capsuleFile, 'utf8'));
    return new Map(Array.isArray(values) ? values.filter(row => Array.isArray(row) && typeof row[0] === 'string'
      && Array.isArray(row[1]) && row[1].every((hash: unknown) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))).slice(-256) : []);
  } catch { return new Map(); }
}
const capsules = savedCapsules();
function rememberCapsules(key: string, items: any[]): boolean {
  const hashes = items.filter(item => item?.type === 'compaction' && typeof item.encrypted_content === 'string')
    .map(item => capsuleHash(item.encrypted_content));
  if (!hashes.length) return false;
  const retained = [...new Set([...(capsules.get(key) ?? []), ...hashes])].slice(-2);
  if (capsules.size >= 256 && !capsules.has(key)) capsules.delete(capsules.keys().next().value!);
  capsules.set(key, retained);
  try {
    mkdirSync(STATE_DIR, { recursive: true }); const tmp = `${capsuleFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify([...capsules]), { mode: 0o600 }); renameSync(tmp, capsuleFile);
  } catch { /* Without persisted provenance a later process passes through. */ }
  return true;
}

/** The native encrypted summary already covers everything before it. Keep the
 * fixed instructions and the last request as a reminder, rather than resending
 * the engine's entire retained user-message tail. Native files are untouched. */
export function compactCodexRequest(body: string, knownV2: readonly string[] = []): string {
  const request = JSON.parse(body);
  // A server-side continuation owns its prior context. Pruning an incremental
  // request would neither remove that context nor preserve its full contract.
  if (!Array.isArray(request.input) || request.previous_response_id) return body;
  const boundary = request.input.findLastIndex((item: any) => item.type === 'compaction' && typeof item.encrypted_content === 'string');
  if (boundary < 0 || !knownV2.includes(capsuleHash(request.input[boundary].encrypted_content))) return body;
  const lastUser = request.input.slice(0, boundary).findLastIndex((item: any) => {
    const text = typeof item.content === 'string' ? item.content
      : Array.isArray(item.content) ? item.content.map((part: any) => part.text || '').join('\n') : '';
    return item.role === 'user' && !/^\s*(?:<skill\b|<turn_aborted>|<user_shell_command>|<environment_context>|# AGENTS\.md instructions\b)/.test(text);
  });
  const retained = request.input.filter((item: any, index: number) => {
    const text = Array.isArray(item.content) ? item.content.map((part: any) => part.text || '').join('\n') : '';
    const fixedUserInstructions = item.role === 'user'
      && /^(?:# AGENTS\.md instructions\b|<environment_context>)/.test(text);
    return index >= boundary || item.role === 'system' || item.role === 'developer'
      || fixedUserInstructions || index === lastUser;
  });
  if (retained.length === request.input.length) return body;
  request.input = retained;
  return JSON.stringify(request);
}

/** Loopback-only, per-turn route. Credentials remain in the native CLI, and
 * are forwarded only to its existing ChatGPT subscription endpoint. */
export async function codexContextProxy(metadata: {
  lane: string; sessionId(): string | null; model: string; resumed: boolean;
  harnessChars: number; harnessPhase: 'startup' | 'turn';
}): Promise<{ baseUrl: string; close(): void }> {
  const key = randomUUID();
  const routePrefix = `/${key}/backend-api/codex`;
  const server = createServer(async (req, res) => {
    const parsed = new URL(req.url || '/', 'http://localhost');
    if (!parsed.pathname.startsWith(`${routePrefix}/`)) { res.writeHead(404).end(); return; }
    const aborter = new AbortController();
    req.on('aborted', () => aborter.abort());
    res.on('close', () => { if (!res.writableFinished) aborter.abort(); });
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_PAYLOAD) { res.writeHead(413).end(); return; }
        chunks.push(Buffer.from(chunk));
      }
      const originalBytes = Buffer.concat(chunks);
      const rootId = metadata.sessionId();
      const root = Boolean(rootId && req.headers['thread-id'] === rootId);
      const responseRequest = req.method === 'POST' && parsed.pathname.endsWith('/responses');
      let body: Buffer | string = originalBytes;
      let auxiliary = false;
      let v2 = false;
      if (root && responseRequest && originalBytes.length) {
        try {
        const encoding = req.headers['content-encoding'];
        const decode = encoding === 'gzip' ? zlib.gunzipSync : encoding === 'br' ? zlib.brotliDecompressSync
          : encoding === 'deflate' ? zlib.inflateSync : encoding === 'zstd' ? (zlib as any).zstdDecompressSync : undefined;
        if (!encoding || decode) {
          const original = (decode ? decode(originalBytes, { maxOutputLength: MAX_PAYLOAD }) : originalBytes).toString('utf8');
          const request = JSON.parse(original);
          v2 = request.input?.some((item: any) => item.type === 'compaction_trigger') === true;
          auxiliary = request.generate === false || v2;
          const projected = compactCodexRequest(original, capsules.get(`${metadata.lane}|${rootId}`));
          if (projected !== original) body = projected;
        }
        } catch { body = originalBytes; } // Unknown encodings/JSON retain their native transport contract.
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (!value || ['host', 'content-length', 'connection', 'transfer-encoding', 'accept-encoding'].includes(name)) continue;
        if (name === 'content-encoding' && typeof body === 'string') continue;
        headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      const requestStartedAt = Date.now();
      const response = await fetch(`https://chatgpt.com/backend-api/codex${parsed.pathname.slice(routePrefix.length)}${parsed.search}`, {
        method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method || '') ? undefined : body,
        signal: aborter.signal,
      });
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        if (!['connection', 'content-length', 'content-encoding', 'transfer-encoding'].includes(name)) responseHeaders[name] = value;
      });
      res.writeHead(response.status, responseHeaders);
      if (!response.body) { res.end(); return; }
      const stream = Readable.fromWeb(response.body as any);
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      if (!root || !responseRequest || !response.ok) { stream.pipe(res); return; }
      const decoder = new StringDecoder('utf8'); let buffer = ''; let reported = false;
      const compactItems: any[] = [];
      const absorb = (line: string) => {
        if (!line.startsWith('data:')) return;
        try {
          const event = JSON.parse(line.slice(5));
          if (v2 && event.type === 'response.output_item.done' && event.item?.type === 'compaction') compactItems.push(event.item);
          const usage = event.response?.usage;
          if (reported || event.type !== 'response.completed' || !usage?.input_tokens) return;
          reported = true;
          if (v2 && rememberCapsules(`${metadata.lane}|${rootId}`, [...compactItems, ...(event.response?.output ?? [])]))
            recordNativeCompactBoundary(metadata.lane, 'codex', rootId, Date.now());
          recordNativeCall({ lane: metadata.lane, engine: 'codex', provider: 'openai', model: metadata.model,
            sessionId: rootId!, requestStartedAt, auxiliary, input: Number(usage.input_tokens),
            cached: Number(usage.input_tokens_details?.cached_tokens || 0), output: Number(usage.output_tokens || 0),
            harnessChars: metadata.harnessChars, harnessPhase: metadata.harnessPhase, resumed: metadata.resumed });
          metadata.resumed = true;
        } catch { /* Non-usage frames pass through unchanged. */ }
      };
      const observer = new Transform({
        transform(chunk, _encoding, callback) {
          buffer += decoder.write(chunk);
          let split: number;
          while ((split = buffer.indexOf('\n')) >= 0) {
            absorb(buffer.slice(0, split).trim()); buffer = buffer.slice(split + 1);
          }
          if (buffer.length > MAX_PAYLOAD) buffer = '';
          callback(null, chunk);
        },
        flush(callback) { buffer += decoder.end(); if (buffer.trim()) absorb(buffer.trim()); callback(); },
      });
      observer.on('error', () => res.destroy());
      stream.pipe(observer).pipe(res);
    } catch {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      if (!res.destroyed) res.end(JSON.stringify({ error: { message: 'The native Codex provider connection failed.' } }));
    }
  });
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  const upgradeHeaders = new WeakMap<object, string[]>();
  websocketServer.on('headers', (headers, request) => headers.push(...(upgradeHeaders.get(request) ?? [])));
  const upstreamSockets = new Set<WebSocket>();
  server.on('upgrade', (req, socket, head) => {
    const parsed = new URL(req.url || '/', 'http://localhost');
    if (parsed.pathname !== `${routePrefix}/responses`) { socket.destroy(); return; }
    // A native socket may prewarm before thread.started reaches stdout. Its
    // identity must be checked at each request, not frozen at upgrade time.
    const socketSessionId = typeof req.headers['thread-id'] === 'string' ? req.headers['thread-id'] : null;
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (!value || ['host', 'connection', 'upgrade', 'content-length'].includes(name) || name.startsWith('sec-websocket-')) continue;
      headers[name] = Array.isArray(value) ? value.join(', ') : value;
    }
    const upstream = new WebSocket(`wss://chatgpt.com/backend-api/codex/responses${parsed.search}`, { headers, handshakeTimeout: 15_000, maxPayload: MAX_PAYLOAD });
    upstream.on('upgrade', response => {
      const forwarded = Object.entries(response.headers).flatMap(([name, value]) => {
        if (!/^(?:x-codex-|x-reasoning-|x-ratelimit-|x-openai-|openai-|retry-after$)/i.test(name)) return [];
        return (Array.isArray(value) ? value : [value]).flatMap(item =>
          typeof item === 'string' && !/[\r\n]/.test(item) ? [`${name}: ${item}`] : []);
      });
      upgradeHeaders.set(req, forwarded);
    });
    upstreamSockets.add(upstream);
    upstream.once('close', () => upstreamSockets.delete(upstream));
    let admitted = false, refused = false;
    socket.on('error', () => upstream.terminate());
    socket.on('close', () => { if (!admitted) upstream.terminate(); });
    // Preserve authentication/limit HTTP errors instead of converting them
    // into an already-upgraded socket's generic abnormal disconnect.
    upstream.on('unexpected-response', (_request, response) => {
      refused = true;
      const chunks: Buffer[] = []; let size = 0, finished = false;
      const finish = () => {
        if (finished) return; finished = true;
        const body = Buffer.concat(chunks);
        const reason = (response.statusMessage || 'Provider refused connection').replace(/[\r\n]/g, '');
        const responseHeaders = ['content-type', 'content-encoding', 'www-authenticate', 'retry-after'].flatMap(name => {
          const value = response.headers[name];
          return typeof value === 'string' && !/[\r\n]/.test(value) ? [`${name}: ${value}`] : [];
        });
        if (!socket.destroyed) socket.end(Buffer.concat([Buffer.from([
          `HTTP/1.1 ${response.statusCode || 502} ${reason}`, 'Connection: close', `Content-Length: ${body.length}`,
          ...responseHeaders, '', '',
        ].join('\r\n')), body]));
      };
      response.on('data', chunk => {
        const bytes = Buffer.from(chunk); const remaining = 65536 - size;
        if (remaining > 0) { const kept = bytes.subarray(0, remaining); chunks.push(kept); size += kept.length; }
        if (bytes.length > remaining) { finish(); response.destroy(); }
      });
      response.on('end', finish); response.on('error', finish); response.on('close', finish);
    });
    upstream.on('error', () => {
      if (!admitted && !refused && !socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    });
    upstream.once('open', () => {
      if (socket.destroyed) { upstream.terminate(); return; }
      websocketServer.handleUpgrade(req, socket, head, downstream => {
        admitted = true;
        type Intent = { sessionId: string | null; started: number; auxiliary: boolean; v2: boolean; compactItems: any[] };
        const pendingRequests: Intent[] = [];
        const requests = new Map<string, Intent>();
        const closePeer = (peer: WebSocket, code: number, reason: Buffer) => {
          if (peer.readyState !== WebSocket.OPEN) return;
          if ([1005, 1006, 1015].includes(code)) peer.close(1011, 'Native provider connection closed.');
          else peer.close(code, reason);
        };
        downstream.on('error', () => upstream.terminate());
        upstream.on('error', () => { if (downstream.readyState === WebSocket.OPEN) downstream.close(1011, 'Native provider connection failed.'); });
        downstream.on('close', (code, reason) => closePeer(upstream, code, reason));
        upstream.on('close', (code, reason) => closePeer(downstream, code, reason));
        downstream.on('message', (data, binary) => {
          let body = data.toString();
          if (!binary) {
            try {
              const request = JSON.parse(body);
              if (request.type === 'response.create') {
                const v2 = request.input?.some((item: any) => item.type === 'compaction_trigger') === true;
                pendingRequests.push({ sessionId: socketSessionId, started: Date.now(), auxiliary: request.generate === false || v2, v2, compactItems: [] });
                if (socketSessionId && socketSessionId === metadata.sessionId())
                  body = compactCodexRequest(body, capsules.get(`${metadata.lane}|${socketSessionId}`));
              }
            } catch { /* Unknown frames remain unchanged. */ }
          }
          if (upstream.readyState === WebSocket.OPEN) upstream.send(binary ? data : body, { binary });
        });
        upstream.on('message', (data, binary) => {
          if (!binary) {
            try {
              const event = JSON.parse(data.toString());
              if (event.type === 'response.created' && event.response?.id) {
                const intent = pendingRequests.shift(); if (intent) requests.set(event.response.id, intent);
              }
              const responseId = event.response?.id || event.response_id;
              const intent = requests.get(responseId);
              if (event.type === 'response.output_item.done' && event.item?.type === 'compaction') {
                const owner = intent ?? (requests.size === 1 ? [...requests.values()][0] : undefined);
                if (owner?.v2) owner.compactItems.push(event.item);
              }
              const usage = event.response?.usage;
              if (event.type === 'response.completed' && intent) {
                requests.delete(responseId);
                const rootId = metadata.sessionId();
                const root = Boolean(rootId && intent.sessionId === rootId);
                if (root && intent.v2 && rememberCapsules(`${metadata.lane}|${rootId}`, [...intent.compactItems, ...(event.response?.output ?? [])]))
                  recordNativeCompactBoundary(metadata.lane, 'codex', rootId, Date.now());
                if (root && usage?.input_tokens) {
                  recordNativeCall({ lane: metadata.lane, engine: 'codex', provider: 'openai', model: metadata.model,
                    sessionId: rootId!, requestStartedAt: intent.started, auxiliary: intent.auxiliary, input: Number(usage.input_tokens),
                    cached: Number(usage.input_tokens_details?.cached_tokens || 0), output: Number(usage.output_tokens || 0),
                    harnessChars: metadata.harnessChars, harnessPhase: metadata.harnessPhase, resumed: metadata.resumed });
                  metadata.resumed = true;
                }
              }
              if (event.type === 'error' || event.type === 'response.failed' || event.type === 'response.incomplete') {
                if (responseId) { if (!requests.delete(responseId)) pendingRequests.shift(); }
                else { requests.clear(); pendingRequests.length = 0; }
              }
            } catch { /* Observe usage and opaque capsule hashes, never save response content. */ }
          }
          if (downstream.readyState === WebSocket.OPEN) downstream.send(data, { binary });
        });
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  server.unref();
  const port = (server.address() as { port: number }).port;
  return { baseUrl: `http://127.0.0.1:${port}${routePrefix}`, close: () => {
    for (const socket of upstreamSockets) socket.terminate();
    for (const socket of websocketServer.clients) socket.terminate();
    websocketServer.close(); server.close(); server.closeAllConnections();
  } };
}
