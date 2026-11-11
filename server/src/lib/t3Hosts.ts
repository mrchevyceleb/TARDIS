// T3 Code hosts whose coding sessions TARDIS watches for its agents.
//
// Off until RIVENDELL_T3_HOSTS names at least one host. The value is JSON:
//   {"studio":{"url":"http://localhost:3773/mcp","tokenFile":"~/.config/t3/agent-token"}}
// Each host is a T3 Code MCP endpoint. The bearer token is read from its file
// on every new connection and never logged.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type T3Host = { name: string; url: string; tokenFile?: string };

let parsed: { raw: string; hosts: T3Host[] } | null = null;

export function t3Hosts(): T3Host[] {
  const raw = process.env.RIVENDELL_T3_HOSTS?.trim() ?? '';
  if (parsed?.raw === raw) return parsed.hosts;
  const hosts: T3Host[] = [];
  if (raw) {
    try {
      const value = JSON.parse(raw) as Record<string, { url?: unknown; tokenFile?: unknown }>;
      for (const [name, host] of Object.entries(value ?? {})) {
        const key = name.trim().toLowerCase();
        if (!key || typeof host?.url !== 'string' || !/^https?:\/\//.test(host.url)) throw new Error(`host "${name}" needs an http(s) url`);
        hosts.push({ name: key, url: host.url, ...(typeof host.tokenFile === 'string' && host.tokenFile ? { tokenFile: host.tokenFile } : {}) });
      }
    } catch (error) {
      console.warn(`[t3] RIVENDELL_T3_HOSTS is not usable, T3 session watching is off: ${(error as Error).message}`);
      hosts.length = 0;
    }
  }
  parsed = { raw, hosts };
  return hosts;
}

export function t3Host(name: string): T3Host | undefined {
  const key = name.trim().toLowerCase();
  return t3Hosts().find((host) => host.name === key);
}

/** A T3 tool said no (thread_not_found, run_not_found...). The host itself is fine. */
export class T3ToolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function bearer(host: T3Host): Record<string, string> {
  if (!host.tokenFile) return {};
  const path = host.tokenFile.startsWith('~/') ? join(homedir(), host.tokenFile.slice(2)) : host.tokenFile;
  return { Authorization: `Bearer ${readFileSync(path, 'utf8').trim()}` };
}

/** The one JSON-RPC reply in a response body, plain JSON or an SSE stream. */
function rpcReply(body: string): { result?: Record<string, unknown>; error?: { message?: string } } {
  const text = body.trimStart();
  if (text.startsWith('{')) return JSON.parse(text);
  const data = text.split('\n').filter((line) => line.startsWith('data:')).at(-1);
  if (!data) throw new Error('empty reply');
  return JSON.parse(data.slice(5));
}

const mcpSessions = new Map<string, Promise<string | null>>();
let rpcId = 0;

async function post(host: T3Host, session: string | null, body: Record<string, unknown>, timeoutMs: number): Promise<Response> {
  return fetch(host.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...bearer(host),
      ...(session ? { 'Mcp-Session-Id': session } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', ...body }),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function connect(host: T3Host): Promise<string | null> {
  const response = await post(host, null, {
    id: ++rpcId,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'tardis', version: '1' } },
  }, 15_000);
  if (!response.ok) throw new Error(`T3 host ${host.name} refused the connection (HTTP ${response.status})`);
  await response.text();
  const session = response.headers.get('Mcp-Session-Id');
  await (await post(host, session, { method: 'notifications/initialized' }, 15_000)).text();
  return session;
}

/** Call one T3 tool. Reconnects once when the host has dropped the MCP session. */
export async function t3Call<T>(host: T3Host, tool: string, args: Record<string, unknown>, timeoutMs = 20_000): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let pending = mcpSessions.get(host.name);
    if (!pending) {
      pending = connect(host);
      mcpSessions.set(host.name, pending);
      pending.catch(() => { if (mcpSessions.get(host.name) === pending) mcpSessions.delete(host.name); });
    }
    const session = await pending;
    const response = await post(host, session, { id: ++rpcId, method: 'tools/call', params: { name: tool, arguments: args } }, timeoutMs);
    const body = await response.text();
    if (!response.ok) {
      if (mcpSessions.get(host.name) === pending) mcpSessions.delete(host.name);
      if (attempt === 0) continue;
      throw new Error(`T3 host ${host.name} answered HTTP ${response.status}`);
    }
    const reply = rpcReply(body);
    if (reply.error) throw new Error(`T3 host ${host.name}: ${reply.error.message ?? 'request failed'}`);
    const result = reply.result ?? {};
    const text = (result.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? '';
    if (result.isError) {
      let failure: { code?: string; message?: string } = {};
      try { failure = JSON.parse(text); } catch { /* plain text failure */ }
      throw new T3ToolError(failure.code ?? 'tool_error', failure.message ?? (text.slice(0, 300) || `${tool} failed`));
    }
    return (result.structuredContent ?? JSON.parse(text)) as T;
  }
}
