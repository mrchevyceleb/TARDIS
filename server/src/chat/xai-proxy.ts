import http from 'node:http';
import https from 'node:https';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { getXaiAuth } from '../routes/xai-oauth.ts';
import { TRANSCRIPT_GUIDANCE } from './transcriptGuidance.ts';

// xAI's Anthropic-compatible endpoint (https://api.x.ai/v1/messages) rejects
// `role: "system"` entries inside the `messages` array with a 400
// "Invalid message role." The stock `claude` CLI, however, sends the system
// prompt as BOTH a top-level `system` field (just the billing header) AND a
// `role: "system"` message in `messages` (Anthropic accepts this as a system
// reminder; z.ai does too, which is why the zai engine needs no proxy). xAI
// does not, so a direct ANTHROPIC_BASE_URL=https://api.x.ai spawn 400s on the
// very first turn.
//
// This is a tiny localhost transform proxy that sits between the claude CLI
// and xAI: it folds every `role: "system"` message into the top-level `system`
// field, then forwards the request verbatim to xAI and streams the response
// back unchanged.
//
// It is ALSO where auth happens. The claude CLI sends whatever
// ANTHROPIC_AUTH_TOKEN held when it spawned, and a process env is immutable
// once running — so a SuperGrok OAuth token baked in at spawn goes stale in
// place (they live ~6h; sessions live longer) and xAI starts 403ing with
// "The OAuth2 access token could not be validated".
//
// So no token is baked in at all. xaiEnv() seeds the child with PROXY_SECRET,
// a random per-process value that never expires; the proxy recognises it and
// swaps it for a freshly-refreshed subscription token on every request. That
// kills the staleness bug at the root (nothing expirable is frozen into an
// env) and doubles as caller identity, so a stray local process that finds the
// port can't spend the operator's plan. Callers that don't present the secret (the
// GROK_PERSONAL_API_KEY path) forward their own header untouched.
//
// Started once per server process on an ephemeral 127.0.0.1 port and reused by
// every xAI chat session (xaiEnv points ANTHROPIC_BASE_URL at it).

const XAI_UPSTREAM = process.env.RIVENDELL_XAI_UPSTREAM?.trim() || 'https://api.x.ai';
const configuredFastRetries = Number(process.env.RIVENDELL_XAI_FAST_RETRIES ?? 2);
const XAI_FAST_RETRIES = Number.isInteger(configuredFastRetries)
  ? Math.min(3, Math.max(0, configuredFastRetries))
  : 2;
const MAX_RETRY_BODY_BYTES = 1024 * 1024;

export function isTransientXaiCapacity(status: number, body: string): boolean {
  // A capacity 429 explicitly rejected the request before generation. Do not
  // replay ambiguous 5xx responses that may have accepted billable work.
  return status === 429 && /\bmodel\s+is\s+currently\s+at\s+capacity\b/i.test(body);
}

// Per-process credential. xaiEnv() seeds the child's ANTHROPIC_AUTH_TOKEN with
// THIS instead of a real token, which is what makes the whole scheme work:
// nothing expirable is ever frozen into a child env, and the proxy can tell its
// own claude children apart from any other process that stumbles onto the port.
// Without it, binding 127.0.0.1 would hand the operator's subscription to any local
// caller that asked — loopback is not identity on a shared machine.
const PROXY_SECRET = randomBytes(32).toString('hex');

/** The value xaiEnv() must put in ANTHROPIC_AUTH_TOKEN for OAuth injection. */
export function xaiProxySecret(): string {
  return PROXY_SECRET;
}

function presentsProxySecret(header: string | undefined): boolean {
  if (!header) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return false;
  const got = Buffer.from(m[1]);
  const want = Buffer.from(PROXY_SECRET);
  return got.length === want.length && timingSafeEqual(got, want);
}

// A token with a CR/LF or other control char would let a malformed credential
// file smuggle extra headers into the upstream request.
const HEADER_SAFE = /^[\x20-\x7E]+$/;

let server: http.Server | null = null;
let port = 0;
let readyPromise: Promise<string> | null = null;

/** Normalize a system content payload (string | content blocks) into text blocks. */
function toSystemBlocks(value: unknown): Array<Record<string, unknown>> {
  if (typeof value === 'string') {
    return value ? [{ type: 'text', text: value }] : [];
  }
  if (Array.isArray(value)) {
    return value.filter((b) => b && typeof b === 'object') as Array<Record<string, unknown>>;
  }
  return [];
}

/** Fold `role: "system"` messages into the top-level `system` field, and
 *  coerce tool input_schema.required to an array. xAI's validator rejects a
 *  missing/null `required` ("/required: null is not of type array"); Anthropic
 *  accepts both. Returns the original string if the body isn't JSON. */
export function transformRequest(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body; // not JSON — forward unchanged
  }
  // JSON.parse('null') -> null; JSON.parse('"x"') -> string. Only transform
  // object-shaped requests; anything else forwards unchanged.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return body;
  const obj = parsed as Record<string, unknown>;
  const messages = Array.isArray(obj.messages) ? (obj.messages as Array<Record<string, unknown>>) : null;
  if (messages) {
    const systemBlocks = toSystemBlocks(obj.system);
    const kept: Array<Record<string, unknown>> = [];
    for (const msg of messages) {
      if (msg && msg.role === 'system') {
        for (const block of toSystemBlocks(msg.content)) systemBlocks.push(block);
      } else {
        kept.push(msg);
      }
    }
    obj.messages = kept;
    // Apply at system priority on every request, including warm Claude-CLI
    // processes. A user-turn reminder alone loses to CLI progress narration.
    systemBlocks.push({ type: 'text', text: TRANSCRIPT_GUIDANCE });
    obj.system = systemBlocks;
  }
  if (Array.isArray(obj.tools)) {
    for (const tool of obj.tools as Array<Record<string, unknown>>) {
      const schema = tool?.input_schema as Record<string, unknown> | undefined;
      if (schema && !Array.isArray(schema.required)) schema.required = [];
      // xAI's deserializer REQUIRES a string `description` on every custom tool
      // (one that carries an input_schema); a missing one 422s the WHOLE request
      // ("tools[0]: missing field `description`") and derails the turn. Anthropic
      // omits it on some tools. Backfill a placeholder so a single
      // description-less tool can't sink a Grok turn. Scoped to tools WITH an
      // input_schema (real custom/MCP tools) — Anthropic server tools (no
      // input_schema, e.g. WebSearch) are left untouched; those are disabled for
      // xai at the CLI layer, since xAI couldn't execute them even if they parsed.
      if (schema && typeof tool.description !== 'string') {
        tool.description = typeof tool.name === 'string' && tool.name ? tool.name : 'tool';
      }
    }
  }
  return JSON.stringify(obj);
}

function startServer(): Promise<string> {
  return new Promise((resolve, reject) => {
    // Cap request bodies so a runaway/malformed local caller can't exhaust
    // memory. Claude's largest payloads (big system prompt + tool defs) are
    // well under 10MB; abort anything bigger.
    const MAX_BODY_BYTES = 10 * 1024 * 1024;
    const srv = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let aborted = false;
      let upstream: http.ClientRequest | null = null;
      // If the claude CLI disconnects mid-stream (stop/interrupt/shutdown), tear
      // down the upstream too so xAI stops generating (and billing) into a void.
      // Guarded by res.writableEnded so a NORMAL completion (response fully sent)
      // never destroys a finished upstream — req/res 'close' fire on success too.
      const cleanup = () => {
        if (aborted || res.writableEnded) return;
        aborted = true;
        try { upstream?.destroy(); } catch {}
      };
      req.on('data', (c: Buffer) => {
        if (aborted) return;
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          aborted = true;
          try { res.writeHead(413, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 413, message: 'xAI proxy: request body too large' } })); } catch {}
          try { upstream?.destroy(); } catch {}
          try { req.destroy(); } catch {}
          return;
        }
        chunks.push(c);
      });
      req.on('error', cleanup);
      req.on('aborted', cleanup);
      res.on('close', cleanup);
      const fail = (code: number, message: string) => {
        if (res.headersSent || res.writableEnded) return;
        try {
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', code, message } }));
        } catch {}
      };
      const handleEnd = async () => {
        if (aborted) return;
        let outBody: string;
        try {
          outBody = transformRequest(Buffer.concat(chunks).toString('utf8'));
        } catch (err) {
          console.warn(`[xai-proxy] transform error: ${(err as Error).message}`);
          fail(400, 'xAI proxy: failed to parse request');
          return;
        }
        const headers: Record<string, string> = {
          'content-type': req.headers['content-type'] || 'application/json',
          'content-length': Buffer.byteLength(outBody).toString(),
          // Capacity 429s are inspected before forwarding. Keep those small
          // error bodies deterministic instead of negotiating gzip/Brotli.
          'accept-encoding': 'identity',
        };
        // Forward auth + anthropic version headers claude set; drop hop-by-hop.
        if (req.headers['authorization']) headers['authorization'] = String(req.headers['authorization']);
        if (req.headers['x-api-key']) headers['x-api-key'] = String(req.headers['x-api-key']);
        if (req.headers['anthropic-version']) headers['anthropic-version'] = String(req.headers['anthropic-version']);
        if (req.headers['anthropic-beta']) headers['anthropic-beta'] = String(req.headers['anthropic-beta']);

        // Only a child WE seeded gets the subscription. It proves that by
        // presenting the proxy secret, which we then swap for a live token —
        // so a frozen env can never carry an expiring credential, and an
        // unrelated local process can't spend the operator's plan.
        if (presentsProxySecret(headers['authorization'])) {
          const auth = await getXaiAuth();
          if (aborted || res.writableEnded) return; // client vanished mid-refresh
          if (auth.mode !== 'oauth') {
            // Never forward the secret upstream, and never silently drop to the
            // metered key: say plainly that the subscription needs reconnecting.
            const why = auth.mode === 'error' ? auth.reason : 'no SuperGrok token stored';
            console.warn(`[xai-proxy] refusing request: ${why}`);
            fail(503, `SuperGrok subscription unavailable (${why}). Reconnect at /xai-oauth.`);
            return;
          }
          if (!HEADER_SAFE.test(auth.token)) {
            console.warn('[xai-proxy] stored token contains non-header-safe characters');
            fail(503, 'SuperGrok token is malformed. Reconnect at /xai-oauth.');
            return;
          }
          headers['authorization'] = `Bearer ${auth.token}`;
          delete headers['x-api-key']; // never let a stale key outrank the sub
        }
        // Anything else (the GROK_PERSONAL_API_KEY path, or the
        // RIVENDELL_XAI_BASE_URL override) forwards its own header untouched.

        const sendAttempt = (attempt: number) => {
          if (aborted || res.writableEnded) return;
          upstream = https.request(
            XAI_UPSTREAM + (req.url || ''),
            { method: req.method, headers },
            (up) => {
              const status = up.statusCode ?? 200;
              if (status !== 429) {
                try { res.writeHead(status, up.headers); } catch { cleanup(); return; }
                up.on('error', () => cleanup());
                up.pipe(res);
                return;
              }

              const retryChunks: Buffer[] = [];
              let retrySize = 0;
              let settled = false;
              let ended = false;
              const responseTimer = setTimeout(() => {
                failBufferedResponse('xAI proxy: timed out reading upstream capacity response');
              }, 10_000);
              responseTimer.unref();
              const failBufferedResponse = (message: string) => {
                if (settled) return;
                settled = true;
                clearTimeout(responseTimer);
                try { up.destroy(); } catch {}
                if (!res.headersSent) fail(502, message);
                else try { res.destroy(); } catch {}
              };
              up.on('data', (chunk: Buffer) => {
                if (settled) return;
                retrySize += chunk.length;
                if (retrySize > MAX_RETRY_BODY_BYTES) {
                  failBufferedResponse('xAI proxy: upstream error response was too large');
                  return;
                }
                retryChunks.push(chunk);
              });
              up.once('error', () => failBufferedResponse('xAI proxy: upstream capacity response failed'));
              up.once('aborted', () => failBufferedResponse('xAI proxy: upstream capacity response aborted'));
              up.once('close', () => {
                if (!ended) failBufferedResponse('xAI proxy: upstream capacity response closed early');
              });
              up.once('end', () => {
                ended = true;
                if (settled || aborted || res.writableEnded) return;
                settled = true;
                clearTimeout(responseTimer);
                const body = Buffer.concat(retryChunks).toString('utf8');
                if (attempt < XAI_FAST_RETRIES && isTransientXaiCapacity(status, body)) {
                  const waitMs = 500 * (attempt + 1);
                  console.warn(`[xai-proxy] transient upstream ${status}; fast retry ${attempt + 1}/${XAI_FAST_RETRIES} in ${waitMs}ms`);
                  setTimeout(() => sendAttempt(attempt + 1), waitMs).unref();
                  return;
                }
                try { res.writeHead(status, up.headers); } catch { cleanup(); return; }
                try { res.end(Buffer.concat(retryChunks)); } catch { cleanup(); }
              });
            },
          );
          upstream.on('error', (err) => {
            console.warn(`[xai-proxy] upstream error: ${(err as Error).message}`);
            // Headers may already be sent (mid-stream) — only write a 502 body if
            // the response is still writable and unset.
            if (!res.headersSent) {
              try { res.writeHead(502, { 'content-type': 'application/json' }); } catch {}
              try { res.end(JSON.stringify({ error: { code: 502, message: 'xAI proxy upstream error' } })); } catch {}
            } else {
              try { res.destroy(); } catch {}
            }
          });
          upstream.on('aborted', () => cleanup());
          try { upstream.write(outBody); upstream.end(); } catch { cleanup(); }
        };
        sendAttempt(0);
      };
      // handleEnd is async, and 'end' is an EventEmitter callback — a rejection
      // escaping it would be an unhandledRejection, which kills the whole
      // always-on server rather than failing one request.
      req.on('end', () => {
        handleEnd().catch((err) => {
          console.warn(`[xai-proxy] request handler error: ${(err as Error).message}`);
          fail(500, 'xAI proxy: internal error');
          cleanup();
        });
      });
    });
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      port = typeof addr === 'object' && addr ? addr.port : 0;
      server = srv;
      console.log(`[xai-proxy] listening on 127.0.0.1:${port} -> ${XAI_UPSTREAM}`);
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

/** Ensure the proxy is up and return its base URL. Safe to call repeatedly.
 *  A failed startup resets so the next call retries rather than latching a
 *  permanent rejection. */
export function ensureXaiProxy(): Promise<string> {
  if (server && port) return Promise.resolve(`http://127.0.0.1:${port}`);
  if (!readyPromise) {
    readyPromise = startServer().catch((err) => {
      readyPromise = null; // allow retry on the next call
      throw err;
    });
  }
  return readyPromise;
}

/** Synchronous base URL for xaiEnv(). Only valid after ensureXaiProxy() resolved. */
export function xaiProxyBaseUrl(): string {
  return port ? `http://127.0.0.1:${port}` : '';
}

export function shutdownXaiProxy(): void {
  if (server) {
    try { server.close(); } catch {}
    server = null;
    port = 0;
    readyPromise = null;
  }
}
