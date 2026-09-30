// Left-rail agent groups, shared by every device so the same layout (and the
// same collapsed state) follows Matt from desktop to phone.
// Store: ~/.rivendell/rail-layout.json
//
// The whole layout is one small document. The copy with the newer `updatedAt`
// wins; ids are agent ids, so a device that lacks an agent just ignores it.

import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from '../config.ts';

export type RailGroup = { id: string; name: string; agentIds: string[] };
export type RailLayout = {
  groups: RailGroup[];
  collapsed: Record<string, true>;
  updatedAt: number;
};

const FILE = join(STATE_DIR, 'rail-layout.json');
const OTHER_GROUP_ID = 'other';
const MAX_GROUPS = 40;
const MAX_MEMBERS = 200;
const NAME_MAX = 32;

function cleanName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim();
}

/** Anything in, a well-formed layout (or null) out. Mirrors the client rules. */
export function normalizeRailLayout(value: unknown): RailLayout | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { groups?: unknown; collapsed?: unknown; updatedAt?: unknown };
  if (!Array.isArray(raw.groups)) return null;
  const seenGroups = new Set<string>();
  const seenAgents = new Set<string>();
  const groups: RailGroup[] = [];
  for (const item of raw.groups.slice(0, MAX_GROUPS)) {
    if (!item || typeof item !== 'object') continue;
    const g = item as { id?: unknown; name?: unknown; agentIds?: unknown };
    const id = typeof g.id === 'string' ? g.id.trim() : '';
    const name = cleanName(g.name);
    if (!id || id === OTHER_GROUP_ID || !name || seenGroups.has(id)) continue;
    seenGroups.add(id);
    const agentIds: string[] = [];
    if (Array.isArray(g.agentIds)) {
      for (const agentId of g.agentIds.slice(0, MAX_MEMBERS)) {
        if (typeof agentId !== 'string' || !agentId || seenAgents.has(agentId)) continue;
        seenAgents.add(agentId);
        agentIds.push(agentId);
      }
    }
    groups.push({ id, name, agentIds });
  }
  const collapsed: Record<string, true> = {};
  if (raw.collapsed && typeof raw.collapsed === 'object') {
    for (const [key, flag] of Object.entries(raw.collapsed as Record<string, unknown>)) {
      if (flag === true && (key === OTHER_GROUP_ID || seenGroups.has(key))) collapsed[key] = true;
    }
  }
  const updatedAt = typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) && raw.updatedAt > 0 ? raw.updatedAt : 0;
  return { groups, collapsed, updatedAt };
}

export function readRailLayout(): RailLayout | null {
  let raw: string;
  try {
    raw = readFileSync(FILE, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    return normalizeRailLayout(JSON.parse(raw));
  } catch {
    // A torn file must not wedge sync; the next accepted PUT replaces it.
    return null;
  }
}

function save(layout: RailLayout): void {
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(layout, null, 2)}\n`);
  try {
    renameSync(tmp, FILE);
  } catch {
    // Windows cannot replace via rename; overwrite in place instead.
    writeFileSync(FILE, readFileSync(tmp));
    try { unlinkSync(tmp); } catch { /* leftover tmp is harmless */ }
  }
}

/** Store the incoming layout only when it is newer than what we hold. Either
 *  way the caller gets the copy that is now authoritative. */
export function saveRailLayout(incoming: RailLayout): { layout: RailLayout; applied: boolean } {
  const current = readRailLayout();
  if (current && current.updatedAt >= incoming.updatedAt) return { layout: current, applied: false };
  save(incoming);
  return { layout: incoming, applied: true };
}
