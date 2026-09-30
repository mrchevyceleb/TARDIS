// Rail groups: named, collapsible sections of the agent list in the left rail.
// Pure layout logic (no React, no network) so the sidebar, the phone menu and
// the sync hook all agree on one model.
//
// The layout stores agent IDs. Display names are only used to seed the starter
// groups. Agents that no group claims (a new agent, a deleted group's members)
// fall into a derived trailing "Other" group, so nobody can ever disappear.

import type { Agent } from './agents';

export const OTHER_GROUP_ID = 'other';
export const OTHER_GROUP_NAME = 'Other';
export const GROUP_NAME_MAX = 32;
const MAX_GROUPS = 40;
const MAX_MEMBERS = 200;

export type RailGroup = { id: string; name: string; agentIds: string[] };

export type RailLayout = {
  /** User groups in display order. "Other" is derived and never stored here. */
  groups: RailGroup[];
  /** Group ids (or OTHER_GROUP_ID) that are folded shut. Absent means open. */
  collapsed: Record<string, true>;
  /** Millisecond stamp of the last edit. The newer copy wins across devices. */
  updatedAt: number;
};

export type ResolvedGroup = {
  id: string;
  name: string;
  isOther: boolean;
  /** Members that exist right now, in display order (pinned ones included). */
  agents: Agent[];
  collapsed: boolean;
};

// Shipped defaults, used only while no layout has ever been saved. Members are
// matched by display name (case-insensitive) and stored by id once resolved. A
// starter group with no matching agent on this install is simply left out.
const STARTER_GROUPS: { id: string; name: string; members: string[] }[] = [
  { id: 'rally', name: 'Rally', members: ['Kip', 'Christina', 'Maria'] },
  { id: 'ops', name: 'Ops', members: ['Becca', 'Jessica', 'Kate', 'Jill', 'Stephen'] },
  { id: 'build', name: 'Build', members: ['Naomi', 'Riley'] },
  { id: 'personal', name: 'Personal', members: ['Julia'] },
];

export function starterLayout(agents: Agent[]): RailLayout {
  const idByName = new Map<string, string>();
  for (const a of agents) {
    const key = a.name.trim().toLowerCase();
    if (key && !idByName.has(key)) idByName.set(key, a.id);
  }
  const groups: RailGroup[] = [];
  for (const starter of STARTER_GROUPS) {
    const agentIds = starter.members
      .map((name) => idByName.get(name.toLowerCase()))
      .filter((id): id is string => Boolean(id));
    if (agentIds.length) groups.push({ id: starter.id, name: starter.name, agentIds });
  }
  return { groups, collapsed: {}, updatedAt: 0 };
}

/** Trim, collapse inner whitespace, cap the length. Empty means "not a name". */
export function cleanGroupName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, GROUP_NAME_MAX).trim();
}

/** A name no other group (or the fallback group) already wears. */
function uniqueName(layout: RailLayout, name: string, exceptId?: string): string {
  const taken = new Set(layout.groups.filter((g) => g.id !== exceptId).map((g) => g.name.toLowerCase()));
  taken.add(OTHER_GROUP_NAME.toLowerCase());
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const candidate = `${name.slice(0, GROUP_NAME_MAX - suffix.length).trim()}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** Groups in order, members that exist, and a trailing "Other" only when it
 *  has someone in it. An agent listed twice keeps its first spot. */
export function resolveGroups(layout: RailLayout, agents: Agent[]): ResolvedGroup[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const placed = new Set<string>();
  const out: ResolvedGroup[] = layout.groups.map((g) => {
    const members: Agent[] = [];
    for (const id of g.agentIds) {
      const agent = byId.get(id);
      if (!agent || placed.has(id)) continue;
      placed.add(id);
      members.push(agent);
    }
    return { id: g.id, name: g.name, isOther: false, agents: members, collapsed: Boolean(layout.collapsed[g.id]) };
  });
  const rest = agents.filter((a) => !placed.has(a.id));
  if (rest.length) {
    out.push({ id: OTHER_GROUP_ID, name: OTHER_GROUP_NAME, isOther: true, agents: rest, collapsed: Boolean(layout.collapsed[OTHER_GROUP_ID]) });
  }
  return out;
}

// Every edit below returns the SAME object when nothing changed, so callers can
// skip a save (and a sync push) with a reference check.

export function toggleCollapsed(layout: RailLayout, id: string): RailLayout {
  const collapsed = { ...layout.collapsed };
  if (collapsed[id]) delete collapsed[id];
  else collapsed[id] = true;
  return { ...layout, collapsed };
}

export function createGroup(layout: RailLayout, id: string, rawName: string): RailLayout {
  const name = cleanGroupName(rawName);
  if (!name || layout.groups.length >= MAX_GROUPS) return layout;
  return { ...layout, groups: [...layout.groups, { id, name: uniqueName(layout, name), agentIds: [] }] };
}

export function renameGroup(layout: RailLayout, id: string, rawName: string): RailLayout {
  const name = cleanGroupName(rawName);
  const group = layout.groups.find((g) => g.id === id);
  if (!group || !name || name === group.name) return layout;
  const next = uniqueName(layout, name, id);
  return { ...layout, groups: layout.groups.map((g) => (g.id === id ? { ...g, name: next } : g)) };
}

/** Dropping a group just releases its members; the derived "Other" catches them. */
export function deleteGroup(layout: RailLayout, id: string): RailLayout {
  if (!layout.groups.some((g) => g.id === id)) return layout;
  const collapsed = { ...layout.collapsed };
  delete collapsed[id];
  return { ...layout, groups: layout.groups.filter((g) => g.id !== id), collapsed };
}

export function shiftGroup(layout: RailLayout, id: string, by: -1 | 1): RailLayout {
  const from = layout.groups.findIndex((g) => g.id === id);
  const to = from + by;
  if (from < 0 || to < 0 || to >= layout.groups.length) return layout;
  const groups = [...layout.groups];
  [groups[from], groups[to]] = [groups[to], groups[from]];
  return { ...layout, groups };
}

/** Put an agent into a group before `beforeId` (null = at the end). Moving to
 *  OTHER_GROUP_ID just releases the agent from every group. */
export function moveAgent(layout: RailLayout, agentId: string, toGroupId: string, beforeId: string | null): RailLayout {
  if (beforeId === agentId) return layout;
  if (toGroupId !== OTHER_GROUP_ID && !layout.groups.some((g) => g.id === toGroupId)) return layout;
  const groups = layout.groups.map((g) => ({ ...g, agentIds: g.agentIds.filter((id) => id !== agentId) }));
  if (toGroupId !== OTHER_GROUP_ID) {
    const target = groups.find((g) => g.id === toGroupId);
    if (!target || target.agentIds.length >= MAX_MEMBERS) return layout;
    const at = beforeId ? target.agentIds.indexOf(beforeId) : -1;
    if (at >= 0) target.agentIds.splice(at, 0, agentId);
    else target.agentIds.push(agentId);
  }
  const same = groups.every((g, i) => (
    g.agentIds.length === layout.groups[i].agentIds.length
    && g.agentIds.every((id, j) => id === layout.groups[i].agentIds[j])
  ));
  return same ? layout : { ...layout, groups };
}

/** Forget ids that no longer name an agent. Only call with a full agent list. */
export function pruneLayout(layout: RailLayout, knownIds: string[]): RailLayout {
  const known = new Set(knownIds);
  if (layout.groups.every((g) => g.agentIds.every((id) => known.has(id)))) return layout;
  return { ...layout, groups: layout.groups.map((g) => ({ ...g, agentIds: g.agentIds.filter((id) => known.has(id)) })) };
}

/** Accepts anything (localStorage, the network) and returns a clean layout, or
 *  null when it is not one. Duplicate groups and duplicate members are dropped. */
export function normalizeLayout(raw: unknown): RailLayout | null {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw as { groups?: unknown; collapsed?: unknown; updatedAt?: unknown };
  if (!Array.isArray(src.groups)) return null;
  const seenGroups = new Set<string>();
  const seenAgents = new Set<string>();
  const groups: RailGroup[] = [];
  for (const item of src.groups.slice(0, MAX_GROUPS)) {
    if (!item || typeof item !== 'object') continue;
    const g = item as { id?: unknown; name?: unknown; agentIds?: unknown };
    const id = typeof g.id === 'string' ? g.id.trim() : '';
    const name = cleanGroupName(g.name);
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
  if (src.collapsed && typeof src.collapsed === 'object') {
    for (const [key, value] of Object.entries(src.collapsed as Record<string, unknown>)) {
      if (value === true && (key === OTHER_GROUP_ID || seenGroups.has(key))) collapsed[key] = true;
    }
  }
  const updatedAt = typeof src.updatedAt === 'number' && Number.isFinite(src.updatedAt) && src.updatedAt > 0 ? src.updatedAt : 0;
  return { groups, collapsed, updatedAt };
}

export function newGroupId(): string {
  return `g-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
