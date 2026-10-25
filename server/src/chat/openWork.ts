import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from './config.ts';
import { parseColumn } from '../lib/deskStore.ts';

export type OpenWork = { ok: boolean; cards: number; jobs: number };

/** Read a JSON store; a missing file is the store's empty seed, any other
 *  read or parse failure is unknown (null). */
function readStore(file: string): unknown | null | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : null;
  }
}

/** An agent's open job: Desk cards it owns In progress (any alias the Desk
 *  normalizes to In progress) and its running background jobs. ok:false
 *  means the state could not be read and must be treated as open. */
export function readOpenWork(agentId: string): OpenWork {
  const desk = readStore(process.env.RIVENDELL_DESK_FILE?.trim() || join(STATE_DIR, 'desk.json'));
  const jobs = readStore(process.env.RIVENDELL_JOBS_FILE?.trim() || join(STATE_DIR, 'jobs.json'));
  if (desk === null || jobs === null) return { ok: false, cards: 0, jobs: 0 };
  const cardList = desk === undefined ? [] : (desk as { cards?: unknown }).cards;
  const jobList = jobs === undefined ? [] : jobs;
  if (!Array.isArray(cardList) || !Array.isArray(jobList)) return { ok: false, cards: 0, jobs: 0 };
  const cards = cardList.filter((c: any) => c?.owner?.id === agentId && c?.archived !== true && parseColumn(c?.column) === 'in_progress').length;
  const running = jobList.filter((j: any) => j?.agentId === agentId && j?.state === 'running').length;
  return { ok: true, cards, jobs: running };
}
