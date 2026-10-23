import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { STATE_DIR } from './config.ts';
import { bareChatId } from './threadKey.ts';

const providers = new Map<string, string>();
export class OpenRouterCompatibilityError extends Error {}
const signedValue = (block: any): string | undefined => block?.type === 'redacted_thinking' ? block.data
  : block?.type === 'thinking' ? block.signature : undefined;
const signatureKey = (model: string, value: string) => createHash('sha256').update(model).update('\0').update(value).digest('hex');
export type OpenRouterTranscript = { profile: string; project?: string };

/** Native tool deferral is an Anthropic protocol extension, not ordinary
 * function calling. Other OpenRouter models need the complete tool schemas. */
export function openRouterToolSearch(model: string): boolean {
  return /^~?anthropic\//i.test(model);
}

/** Remember only signature fingerprints and their producer, never thinking
 * text. Native history supplies the same evidence after a process restart. */
export function rememberOpenRouterProvider(model: string, provider: unknown, blocks: any[]): void {
  if (!/^google\/gemini/i.test(model) || typeof provider !== 'string' || !provider) return;
  for (const block of blocks) {
    const value = signedValue(block);
    if (typeof value !== 'string' || !value) continue;
    providers.set(signatureKey(model, value), provider);
    while (providers.size > 1024) providers.delete(providers.keys().next().value!);
  }
}

async function savedProviders(lane: string, id: string, values: Set<string>, signal: AbortSignal, source?: OpenRouterTranscript): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  let location: any;
  try { location = JSON.parse(await readFile(join(STATE_DIR, 'native-claude-locations.json'), 'utf8'))[bareChatId(lane)]; } catch { /* Non-agent threads use the runner's actual profile. */ }
  let path: string | undefined;
  if (location?.id === id) path = join(location.profile, 'projects', location.project, `${id}.jsonl`);
  else if (source?.project) path = join(source.profile, 'projects', source.project, `${id}.jsonl`);
  else if (source) {
    const root = join(source.profile, 'projects');
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(root, entry.name, `${id}.jsonl`);
      try { await access(candidate); } catch { continue; }
      if (path) return found; // Never guess between two native transcripts.
      path = candidate;
    }
  }
  if (!path) return found;
  const size = (await stat(path)).size;
  // Usually the previous response is a few KB from the end. Older signatures
  // can precede a large tool result; that fallback remains asynchronous too.
  for (const start of new Set([Math.max(0, size - 2 * 1024 * 1024), 0])) {
    let count = 0;
    const input = createReadStream(path, { start, end: Math.max(0, size - 1), highWaterMark: 64 * 1024, signal });
    const lines = createInterface({ input, crlfDelay: Infinity });
    let readError: Error | undefined;
    input.on('error', error => { readError = error; lines.close(); });
    try {
      for await (const line of lines) {
        if (++count % 500 === 0) await new Promise<void>(resolve => setImmediate(resolve));
        signal.throwIfAborted();
        if (line.length > 32 * 1024 * 1024 || !line.includes('"provider"')) continue;
        let row: any; try { row = JSON.parse(line); } catch { continue; }
        const message = row.message;
        if (row.type !== 'assistant' || !/^google\/gemini/i.test(message?.model || '')
            || !Array.isArray(message.content) || typeof message.provider !== 'string' || !message.provider) continue;
        for (const block of message.content) {
          const value = signedValue(block);
          // The opaque signature itself proves provenance, including older
          // Gemini models and native sidechains. Never infer it from the lane.
          if (typeof value === 'string' && values.has(value)) found.set(value, message.provider);
        }
      }
      if (readError) throw readError;
    } finally { lines.close(); input.destroy(); }
    if (found.size === values.size) return found;
  }
  return found;
}

/** Google and Google AI Studio cannot consume one another's Gemini thought
 * signatures. OpenRouter's sticky routing still fails over between them.
 * Pin the proven producer while signed context is present, including compact.
 * A new native summary naturally clears that constraint; no new session. */
export async function pinOpenRouterProvider(request: any, lane: string, id: string | null, signal: AbortSignal, source?: OpenRouterTranscript): Promise<boolean> {
  if (!/^google\/gemini/i.test(request.model || '')) return false;
  const values: string[] = [...new Set<string>((request.messages ?? []).flatMap((message: any) => message.role === 'assistant' && Array.isArray(message.content)
    ? message.content : []).map(signedValue).filter((value: unknown): value is string => typeof value === 'string' && value.length > 0))];
  if (!values.length) return false;
  const known = new Map<string, string>();
  for (const value of values) {
    const provider = providers.get(signatureKey(request.model, value));
    if (provider) known.set(value, provider);
  }
  if (known.size < values.length && id) {
    try {
      const saved = await savedProviders(lane, id, new Set(values.filter(value => !known.has(value))), signal, source);
      for (const [value, provider] of saved) {
        known.set(value, provider);
        rememberOpenRouterProvider(request.model, provider, [{ type: 'redacted_thinking', data: value }]);
      }
    }
    catch { signal.throwIfAborted(); }
  }
  if (new Set(known.values()).size > 1) throw new OpenRouterCompatibilityError('Gemini cannot combine signed replies from different providers. Your conversation is saved. Return to the previous brain to continue.');
  // Legacy native rows may have no provider metadata. Preserve their existing
  // routing rather than inventing a provider or creating a permanent retry loop.
  const provider = known.get(values.at(-1)!);
  if (!provider) { console.warn('[native provider] Gemini signature producer is unavailable; preserving native routing'); return false; }
  const selected = request.provider ?? {};
  if (Array.isArray(selected.only) && !selected.only.includes(provider)) throw new OpenRouterCompatibilityError('This Gemini response needs its original provider. Your conversation is safe. Please restore that provider to continue.');
  request.provider = { ...selected, only: [provider], allow_fallbacks: false };
  return true;
}
