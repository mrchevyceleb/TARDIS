import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
/** Provider credentials retain their own profiles. Only the engine's full
 * native transcript moves when a lane changes provider. No summary/reseed. */
export function prepareClaudeNativeStorage(lane: string, profile: string, resumeId: string | null): { project?: string; accept(id: string): void } {
  if (!isAgentThread(lane)) return { accept() {} };
  const agent = bareChatId(lane);
  const project = `tardis-${createHash('sha256').update(agent).digest('hex').slice(0, 24)}`;
  const target = join(profile, 'projects', project);
  const previous = locations()[agent];
  if (resumeId) {
    let source: string | undefined;
    if (previous?.id === resumeId) {
      const recorded = join(previous.profile, 'projects', previous.project);
      if (existsSync(join(recorded, `${resumeId}.jsonl`))) source = recorded;
    }
    if (!source) {
      // One-time adoption of a session created before the location registry.
      // Inspect only immediate native project directories for this exact ID.
      for (const candidate of new Set([previous?.profile, profile].filter((value): value is string => Boolean(value)))) {
        const root = join(candidate, 'projects');
        try { source = readdirSync(root).map(name => join(root, name)).find(dir => existsSync(join(dir, `${resumeId}.jsonl`))); } catch {}
        if (source) break;
      }
    }
    if (!source || !existsSync(join(source, `${resumeId}.jsonl`))) {
      recordNativeFailure(lane, 'claude-code', 'Saved native transcript is missing. Queued messages are retained; native recovery or Matt’s Fresh thread is required.');
      throw new Error('The saved native transcript is unavailable; refusing to replace this session.');
    }
    if (source !== target) {
      mkdirSync(target, { recursive: true });
      const temporary = join(target, `${resumeId}.jsonl.tmp`);
      copyFileSync(join(source, `${resumeId}.jsonl`), temporary);
      renameSync(temporary, join(target, `${resumeId}.jsonl`));
      if (existsSync(join(source, resumeId))) cpSync(join(source, resumeId), join(target, resumeId), { recursive: true });
    }
  }
  return { project, accept(id: string) {
    const all = locations();
    all[agent] = { profile, project, id };
    mkdirSync(STATE_DIR, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
    renameSync(tmp, file);
  } };
}
