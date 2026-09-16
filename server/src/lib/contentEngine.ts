import { listAgents, brainForAgent } from '../chat/agents.ts';

export class ContentEngineError extends Error {
  constructor(message: string, public status = 502, public details?: unknown) { super(message); }
}

/** Private server-to-server connection. Credentials never enter a browser. */
export async function contentEngineRequest(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const base = process.env.RALLYPOINT_ENGINE_URL?.trim();
  const token = process.env.RALLYPOINT_ENGINE_TOKEN?.trim();
  if (!base || !token) throw new ContentEngineError('The content engine is not connected yet.', 503);
  const target = new URL(base);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
    throw new ContentEngineError('The content engine connection needs attention.', 503);
  }
  if (target.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname.toLowerCase())) {
    throw new ContentEngineError('Remote content engines require HTTPS. HTTP is supported only on this computer.', 503);
  }
  const timeout = AbortSignal.timeout(360_000);
  const response = await fetch(new URL(`/api/content${path}`, target), {
    method, redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => null) as { error?: unknown } | null;
  if (!response.ok) {
    throw new ContentEngineError(typeof data?.error === 'string' ? data.error : 'The content engine could not complete that request.', response.status, data);
  }
  return data;
}

/** A companion's current brain also supplies its content-writing engine. */
export function contentBrainForAgent(name: string) {
  const normalized = name.trim().toLowerCase();
  const agent = listAgents().find((item) => item.id === name || item.name.trim().toLowerCase() === normalized);
  if (!agent) throw new ContentEngineError('Choose an existing teammate to create content.', 400);
  const { engine, model, effort } = brainForAgent(agent);
  return { engine, model, effort };
}
