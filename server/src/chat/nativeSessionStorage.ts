import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { STATE_DIR } from './config.ts';
import { bareChatId, isAgentThread } from './threadKey.ts';
import { recordNativeFailure } from './sessionMetrics.ts';

type Location = { profile: string; project: string; id: string };
const file = join(STATE_DIR, 'native-claude-locations.json');
function locations(): Record<string, Location> {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
}

/** Resolve symlinked profiles/project directories even when the final target
 * has not been created yet. Node's copy guard compares canonical paths too, so
 * this must happen before deciding whether a native transcript needs moving. */
function canonicalDirectory(path: string): string {
  const missing: string[] = [];
  let existing = resolve(path);
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    missing.unshift(basename(existing));
    existing = parent;
  }
  return join(realpathSync(existing), ...missing);
}
/** Provider credentials retain their own profiles. Only the engine's full
 * native transcript moves when a lane changes provider. No summary/reseed. */
export function prepareClaudeNativeStorage(lane: string, profile: string, resumeId: string | null, cwd?: string, sourceProfiles: string[] = []): { project?: string; reseed?: boolean; accept(id: string): void } {
  const agent = isAgentThread(lane) ? bareChatId(lane) : `${cwd ?? ''}|${lane}`;
  const project = `tardis-${createHash('sha256').update(agent).digest('hex').slice(0, 24)}`;
  const target = join(profile, 'projects', project);
  const previous = locations()[agent];
  let reseed = false;
  if (resumeId) {
    let source: string | undefined;
    if (previous?.id === resumeId) {
      const recorded = join(previous.profile, 'projects', previous.project);
      if (existsSync(join(recorded, `${resumeId}.jsonl`))) source = recorded;
    }
    if (!source) {
      // One-time adoption of a session created before the location registry.
      // Inspect only immediate native project directories for this exact ID.
      for (const candidate of new Set([previous?.profile, profile, ...sourceProfiles].filter((value): value is string => Boolean(value)))) {
        const root = join(candidate, 'projects');
        try { source = readdirSync(root).map(name => join(root, name)).find(dir => existsSync(join(dir, `${resumeId}.jsonl`))); } catch {}
        if (source) break;
      }
    }
    if (!source || !existsSync(join(source, `${resumeId}.jsonl`))) {
      if (isAgentThread(lane)) {
        recordNativeFailure(lane, 'claude-code', 'Saved native transcript is missing. Queued messages are retained; native recovery or Matt’s Fresh thread is required.');
        throw new Error('The saved native transcript is unavailable; refusing to replace this session.');
      }
      reseed = true;
    }
    if (source && canonicalDirectory(source) !== canonicalDirectory(target)) {
      mkdirSync(target, { recursive: true });
      const temporary = join(target, `${resumeId}.jsonl.tmp`);
      copyFileSync(join(source, `${resumeId}.jsonl`), temporary);
      renameSync(temporary, join(target, `${resumeId}.jsonl`));
      if (existsSync(join(source, resumeId))) cpSync(join(source, resumeId), join(target, resumeId), { recursive: true });
    }
  }
  return { project, reseed, accept(id: string) {
    const all = locations();
    all[agent] = { profile, project, id };
    mkdirSync(STATE_DIR, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
    renameSync(tmp, file);
  } };
}

/** Resolve the current on-disk transcript without assuming Claude's legacy
 * cwd-derived project name. Session IDs are globally unique. */
export function claudeNativeTranscriptPath(id: string): string | null {
  const location = Object.values(locations()).find(item => item.id === id);
  if (!location) return null;
  const path = join(location.profile, 'projects', location.project, `${id}.jsonl`);
  return existsSync(path) ? path : null;
}

/** Claude's native compactor writes a portable user summary. Keep the full
 * transcript and copy only its own summary into the other engine's input. */
export function readClaudeHandover(lane: string, id: string): string {
  const location = locations()[bareChatId(lane)];
  if (!location || location.id !== id) throw new Error('The native handover transcript is unavailable.');
  const lines = readFileSync(join(location.profile, 'projects', location.project, `${id}.jsonl`), 'utf8').trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const event = JSON.parse(lines[i]);
    if (event.type !== 'user' || !event.isCompactSummary) continue;
    const content = event.message?.content;
    const note = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(item => item.type === 'text').map(item => item.text).join('\n') : '';
    if (note) return note;
  }
  throw new Error('The previous engine did not save a readable handover.');
}
