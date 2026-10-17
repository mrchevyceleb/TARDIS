// The per-agent live checklist (card-a77246, Matt, Oct 17): the invoking
// agent's own running checklist, rendered in the sidebar next to its chat.
// The agent drives it through the sidebar_checklist tool (an HTTP front like
// every team tool, posting to /api/checklists); this store is the single
// writer's truth, and every mutation bumps updatedAt so the broadcast the
// route sends is always fresh. Never written by hand: the pins rule applies
// (hand edits do not reach the tool or the live event).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { writeJsonAtomic } from './deskStore.ts';

const FILE = process.env.RIVENDELL_CHECKLIST_FILE || join(homedir(), '.rivendell', 'checklists.json');

export type ChecklistItem = {
  id: string;
  /** The thing being done, one short line. */
  text: string;
  /** A short live status line the agent keeps current as the work moves. */
  status?: string;
  /** A teammate name shown with their face in the sidebar. */
  assignee?: string;
  done?: boolean;
  doneAt?: number;
  doneBy?: string;
};

export type Checklist = {
  /** The owning agent id (a channel id in a channel checklist). */
  owner: string;
  title?: string;
  items: ChecklistItem[];
  createdAt: number;
  updatedAt: number;
};

/** What a mutator returns: the body only — owner and timestamps are the
 *  store's bookkeeping, filled on write. */
export type ChecklistInput = { title?: string; items: ChecklistItem[] };

type ChecklistFile = { checklists: Record<string, Checklist> };

async function loadFile(): Promise<ChecklistFile> {
  try {
    const raw = JSON.parse(await readFile(FILE, 'utf8')) as Partial<ChecklistFile>;
    if (raw && typeof raw === 'object' && raw.checklists && typeof raw.checklists === 'object') {
      return { checklists: raw.checklists };
    }
  } catch { /* fresh or corrupt file: start from empty, never throw on reads */ }
  return { checklists: {} };
}

export async function readChecklist(owner: string): Promise<Checklist | null> {
  const { checklists } = await loadFile();
  return checklists[owner] ?? null;
}

/** One mutation at a time: the file is the lock (atomic write, last write
 *  wins — the checklist is a single agent's live scratchpad, not shared
 *  state). Returning null from the mutator deletes the checklist; a thrown
 *  mutator never corrupts the file. */
export async function mutateChecklist(
  owner: string,
  mutate: (list: Checklist | null) => ChecklistInput | null,
): Promise<Checklist | null> {
  const file = await loadFile();
  const now = Date.now();
  let next: ChecklistInput | null = null;
  try {
    next = mutate(file.checklists[owner] ?? null);
  } catch {
    return file.checklists[owner] ?? null; // a bad mutation never corrupts the file
  }
  if (!next) {
    delete file.checklists[owner];
    await writeJsonAtomic(FILE, file);
    return null;
  }
  const list: Checklist = {
    ...next,
    owner,
    createdAt: file.checklists[owner]?.createdAt ?? now,
    updatedAt: now,
  };
  file.checklists[owner] = list;
  await writeJsonAtomic(FILE, file);
  return list;
}

export function newChecklistId(): string {
  return `ci${Math.random().toString(36).slice(2, 9)}`;
}
