import { MCP_BASE_URL, MCP_BEARER_TOKEN } from '../config.ts';

/**
 * Call an assistant-mcp tool over HTTP. Mirrors the Railway server's
 * `POST /tools/call` shape: body `{ name, arguments }`, response
 * `{ content: [{ type: 'text', text: '<JSON string>' }] }`.
 *
 * Throws on missing config, non-2xx responses, or unparseable bodies —
 * callers should let the error propagate (no mock fallback).
 */
export async function callMcp<T = unknown>(tool: string, payload: unknown, timeoutMs = 30_000): Promise<T> {
  if (!MCP_BASE_URL) {
    throw new Error('MCP_BASE_URL is not configured');
  }

  const response = await fetch(`${MCP_BASE_URL.replace(/\/$/, '')}/tools/call`, {
    method: 'POST',
    // Fresh Thread and rolling compaction must never hold a lane forever when
    // the optional remote memory mirror is unreachable. Default 30s; a caller
    // with its own pass deadline (the durable-fact drain) passes its remaining
    // budget so no call can outlive the caller's deadline. Floor 1ms: a spent
    // budget aborts immediately instead of hanging.
    signal: AbortSignal.timeout(Math.max(timeoutMs, 1)),
    headers: {
      'Content-Type': 'application/json',
      ...(MCP_BEARER_TOKEN ? { Authorization: `Bearer ${MCP_BEARER_TOKEN}` } : {}),
    },
    body: JSON.stringify({ name: tool, arguments: payload ?? {} }),
  });

  if (!response.ok) {
    throw new Error(`MCP ${tool} failed: ${response.status} ${await response.text()}`);
  }

  const envelope = (await response.json()) as { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
  const text = envelope?.content?.[0]?.text;
  if (envelope.isError) throw new Error(typeof text === 'string' ? text : `MCP ${tool} failed`);
  if (typeof text !== 'string') {
    return envelope as unknown as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}
