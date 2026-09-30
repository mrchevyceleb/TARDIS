// Rail groups state: the layout, its per-browser copy, and the optional
// cross-device sync.
//
// The browser copy (localStorage) is the source the UI runs on, so the rail
// works with no server help. A server that has /api/rail-layout adds sync:
// pull on load and on focus, push (debounced) after an edit, and the copy with
// the newer updatedAt wins. A server without the route (404) is a normal
// offline case: we stay local, quietly, and look again much later.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Agent } from './agents';
import {
  createGroup,
  deleteGroup,
  moveAgent,
  newGroupId,
  normalizeLayout,
  OTHER_GROUP_ID,
  pruneLayout,
  renameGroup,
  resolveGroups,
  shiftGroup,
  starterLayout,
  toggleCollapsed,
  type RailLayout,
  type ResolvedGroup,
} from './railGroups';

const LAYOUT_KEY = 'rivendell:rail-layout';
const ENDPOINT = '/api/rail-layout';
const PUSH_DEBOUNCE_MS = 800;
const PULL_MIN_GAP_MS = 4_000;
// After a 404, leave the endpoint alone this long (a server upgraded while the
// app stays open starts syncing on the next focus after this window).
const ABSENT_RETRY_MS = 10 * 60_000;

// Module-level on purpose: one probe result serves every mount of the rail.
let absentUntil = 0;
let lastRemoteStamp = 0;

function readLocal(): RailLayout | null {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    return raw ? normalizeLayout(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function writeLocal(layout: RailLayout): void {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch { /* private mode */ }
}

type Remote =
  | { state: 'ok'; layout: RailLayout | null }
  | { state: 'absent' }
  | { state: 'offline' };

/** One trip to the sync endpoint. Never throws and never logs. */
async function callRemote(init?: RequestInit): Promise<Remote> {
  if (Date.now() < absentUntil) return { state: 'absent' };
  const absent = (): Remote => {
    absentUntil = Date.now() + ABSENT_RETRY_MS;
    return { state: 'absent' };
  };
  let res: Response;
  try {
    res = await fetch(ENDPOINT, { cache: 'no-store', ...init });
  } catch {
    return { state: 'offline' };
  }
  if (res.status === 404 || res.status === 405 || res.status === 501) return absent();
  if (!res.ok) return { state: 'offline' };
  try {
    const body = await res.json() as { layout?: unknown };
    return { state: 'ok', layout: normalizeLayout(body?.layout) };
  } catch {
    // A 200 that is not JSON is a catch-all page, not our route.
    return absent();
  }
}

export type RailGroupsApi = {
  /** Groups in order plus a trailing "Other" when someone is unassigned. */
  groups: ResolvedGroup[];
  /** True once at least one real (non-Other) group exists. */
  grouped: boolean;
  toggle: (groupId: string) => void;
  create: (name: string) => void;
  rename: (groupId: string, name: string) => void;
  remove: (groupId: string) => void;
  shift: (groupId: string, by: -1 | 1) => void;
  /** Move an agent to a group, before `beforeId` (null = the end). */
  move: (agentId: string, groupId: string, beforeId: string | null) => void;
  groupIdOf: (agentId: string) => string;
};

export function useRailGroups(agents: Agent[]): RailGroupsApi {
  const [saved, setSaved] = useState<RailLayout | null>(readLocal);
  const savedRef = useRef(saved);
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const pushTimer = useRef(0);
  const lastPull = useRef(0);

  // No saved layout yet: run on the starter groups. They are not written back
  // until the first real edit, so every device derives the same default.
  const starter = useMemo(() => (saved ? null : starterLayout(agents)), [saved, agents]);
  const layout = saved ?? starter ?? { groups: [], collapsed: {}, updatedAt: 0 };
  const groups = useMemo(() => resolveGroups(layout, agents), [layout, agents]);

  const adopt = useCallback((next: RailLayout) => {
    lastRemoteStamp = Math.max(lastRemoteStamp, next.updatedAt);
    savedRef.current = next;
    setSaved(next);
    writeLocal(next);
  }, []);

  const push = useCallback(async (keepalive = false) => {
    window.clearTimeout(pushTimer.current);
    pushTimer.current = 0;
    const mine = savedRef.current;
    if (!mine || Date.now() < absentUntil) return;
    const remote = await callRemote({
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layout: mine }),
      keepalive,
    });
    // The server keeps whichever copy is newer and hands that back.
    if (remote.state === 'ok' && remote.layout && remote.layout.updatedAt > (savedRef.current?.updatedAt ?? 0)) adopt(remote.layout);
  }, [adopt]);

  const reconcile = useCallback((remote: RailLayout | null) => {
    const mine = savedRef.current;
    if (remote) lastRemoteStamp = Math.max(lastRemoteStamp, remote.updatedAt);
    if (remote && (!mine || remote.updatedAt > mine.updatedAt)) adopt(remote);
    else if (mine && (!remote || mine.updatedAt > remote.updatedAt)) void push();
  }, [adopt, push]);

  const pull = useCallback(async (force = false) => {
    const now = Date.now();
    if (!force && now - lastPull.current < PULL_MIN_GAP_MS) return;
    lastPull.current = now;
    const remote = await callRemote();
    if (remote.state === 'ok') reconcile(remote.layout);
  }, [reconcile]);

  useEffect(() => {
    void pull(true);
    const onFocus = () => { if (document.visibilityState === 'visible') void pull(); };
    const onHide = () => {
      if (document.visibilityState !== 'hidden') return;
      // An edit still waiting on its debounce goes out before the app sleeps.
      if (pushTimer.current) void push(true);
    };
    // Another tab of this browser saved: take its copy if it is newer.
    const onStorage = (e: StorageEvent) => {
      if (e.key !== LAYOUT_KEY) return;
      const next = readLocal();
      if (next && next.updatedAt > (savedRef.current?.updatedAt ?? 0)) {
        lastRemoteStamp = Math.max(lastRemoteStamp, next.updatedAt);
        savedRef.current = next;
        setSaved(next);
      }
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('storage', onStorage);
      window.clearTimeout(pushTimer.current);
    };
  }, [pull, push]);

  /** Run one edit against the layout on screen (saved, or the starter) and
   *  persist it with a fresh stamp that beats anything this device has seen. */
  const edit = useCallback((change: (base: RailLayout) => RailLayout) => {
    const base = savedRef.current ?? starterLayout(agentsRef.current);
    const changed = change(base);
    if (changed === base) return;
    const known = agentsRef.current.map((a) => a.id);
    const clean = known.length ? pruneLayout(changed, known) : changed;
    const next: RailLayout = { ...clean, updatedAt: Math.max(Date.now(), base.updatedAt + 1, lastRemoteStamp + 1) };
    savedRef.current = next;
    setSaved(next);
    writeLocal(next);
    window.clearTimeout(pushTimer.current);
    pushTimer.current = window.setTimeout(() => void push(), PUSH_DEBOUNCE_MS);
  }, [push]);

  const groupIdOf = useCallback((agentId: string) => (
    groups.find((g) => g.agents.some((a) => a.id === agentId))?.id ?? OTHER_GROUP_ID
  ), [groups]);

  const toggle = useCallback((id: string) => edit((l) => toggleCollapsed(l, id)), [edit]);
  const create = useCallback((name: string) => edit((l) => createGroup(l, newGroupId(), name)), [edit]);
  const rename = useCallback((id: string, name: string) => edit((l) => renameGroup(l, id, name)), [edit]);
  const remove = useCallback((id: string) => edit((l) => deleteGroup(l, id)), [edit]);
  const shift = useCallback((id: string, by: -1 | 1) => edit((l) => shiftGroup(l, id, by)), [edit]);
  const move = useCallback((agentId: string, id: string, before: string | null) => edit((l) => moveAgent(l, agentId, id, before)), [edit]);

  return { groups, grouped: groups.some((g) => !g.isOther), toggle, create, rename, remove, shift, move, groupIdOf };
}
