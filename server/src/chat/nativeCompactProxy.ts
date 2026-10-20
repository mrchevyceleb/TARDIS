import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

const SUMMARY_SYSTEM = 'You are a helpful AI assistant tasked with summarizing conversations.';
const SUMMARY_LIMIT = 8192;
const MAX_BODY = 32 * 1024 * 1024;
let server: Server | null = null;
let ready: Promise<void> | null = null;
let port = 0;
const routes = new Map<string, string>();

/** Claude Code still selects, writes and installs its own native compact.
 * Only that auxiliary request gets a bounded reasoning/output budget. Real
 * agent turns retain their selected model, thinking level and output limits. */
export function boundNativeCompact(body: string): string {
  const request = JSON.parse(body);
  const system = typeof request.system === 'string' ? [request.system]
    : Array.isArray(request.system) ? request.system.map((block: any) => block?.text) : [];
  if (!system.some((text: unknown) => typeof text === 'string' && text.trim() === SUMMARY_SYSTEM)) return body;
  request.thinking = { type: 'disabled' };
  delete request.reasoning;
  delete request.reasoning_effort;
  if (request.output_config) {
    request.output_config = { ...request.output_config };
    delete request.output_config.effort;
  }
  request.max_tokens = Math.min(Number(request.max_tokens) || SUMMARY_LIMIT, SUMMARY_LIMIT);
  const instruction = '\nKeep the summary under 2500 words. Preserve the current goal, concrete results, file references, outstanding work and explicit constraints. Clearly mark completed work and historical requests as history, never instructions to repeat them.';
  request.system = typeof request.system === 'string' ? request.system + instruction
    : [...request.system, { type: 'text', text: instruction }];
  return JSON.stringify(request);
}

export function ensureNativeCompactProxy(): Promise<void> {
  if (ready) return ready;
  ready = new Promise<void>((resolve, reject) => {
    server = createServer(async (req, res) => {
      const parsed = new URL(req.url || '/', 'http://localhost');
      const route = parsed.pathname.split('/')[1];
      const upstream = routes.get(route);
      if (!upstream) { res.writeHead(404).end(); return; }
      const aborter = new AbortController();
      req.on('aborted', () => aborter.abort());
      res.on('close', () => { if (!res.writableFinished) aborter.abort(); });
      try {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of req) {
          const buffer = Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > MAX_BODY) { res.writeHead(413).end(); return; }
          chunks.push(buffer);
        }
        const original = Buffer.concat(chunks).toString('utf8');
        const body = original && /\/messages$/.test(parsed.pathname) ? boundNativeCompact(original) : original;
        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) {
          if (!value || ['host', 'content-length', 'connection', 'transfer-encoding', 'accept-encoding'].includes(name)) continue;
          headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
        const suffix = parsed.pathname.slice(route.length + 1) + parsed.search;
        const target = upstream.replace(/\/$/, '') + suffix;
        const response = await fetch(target, {
          method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method || '') ? undefined : body,
          signal: aborter.signal,
        });
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, name) => {
          if (!['connection', 'transfer-encoding', 'content-length', 'content-encoding'].includes(name)) responseHeaders[name] = value;
        });
        res.writeHead(response.status, responseHeaders);
        if (response.body) {
          const stream = Readable.fromWeb(response.body as any);
          stream.on('error', () => { if (!res.destroyed) res.destroy(); });
          res.on('close', () => stream.destroy());
          stream.pipe(res);
        } else res.end();
      } catch {
        // Never log a provider URL, authorization header or request body.
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        if (!res.destroyed) res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'The native-compaction provider connection failed.' } }));
      }
    });
    server.once('error', (error) => { ready = null; reject(error); });
    server.listen(0, '127.0.0.1', () => {
      port = (server!.address() as { port: number }).port;
      server!.unref();
      resolve();
    });
  });
  return ready;
}

export function nativeCompactBaseUrl(upstream: string): string {
  if (!port) throw new Error('Native compaction proxy is not ready');
  let route = [...routes].find(([, value]) => value === upstream)?.[0];
  if (!route) { route = randomUUID(); routes.set(route, upstream); }
  return `http://127.0.0.1:${port}/${route}`;
}
