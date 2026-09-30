// Rail groups state: the layout, its per-browser copy, and the optional
// cross-device sync.
//
// The browser copy (localStorage) is the source the UI runs on, so the rail
// works with no server help. A server that has /api/rail-layout adds sync:
// pull on load and on focus, push (debounced) after an edit. A push names the
// server copy it was built on; if another device wrote since, the server keeps
// its copy and this device re-applies its own not-yet-saved edits on top of it,
// so a collapse toggle on a stale phone cannot wipe a regrouping made on the
// desktop. A server without the route (404) is a normal offline case: we stay
// local, quietly, and look again much later.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Agent } from './agents';
import {
  createGroup,
  deleteGroup,
  moveAgent,
  newGroupId,
  normalizeLayout,
  OTHER_GROUP_ID,
  renameGroup,
  resolveGroups,
  placeGroup,
  setCollapsed,
  starterLayout,
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
// Edits kept for replaying onto a newer server copy. Past this (a long offline
// spell) they are squashed into one snapshot of the layout on screen, so our
// edits still win over the server's copy instead of being dropped.
const MAX_PENDING = 200;
// A sync trip that hangs must not wedge the queue behind it.
const CALL_TIMEOUT_MS = 15_000;
// Back-to-back conflicts mean devices are editing in lockstep; stop and let the
// next edit or focus pull settle it rather than looping.
const MAX_CONFLICT_RETRIES = 3;

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

type Change = (base: RailLayout) => RailLayout;

type Remote =
  | { state: 'ok'; layout: RailLayout | null; applied?: boolean }
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
    res = await fetch(ENDPOINT, { cache: 'no-store', signal: AbortSignal.timeout(CALL_TIMEOUT_MS), ...init });
  } catch {
    return { state: 'offline' };
  }
  if (res.status === 404 || res.status === 405 || res.status === 501) return absent();
  if (!res.ok) return { state: 'offline' };
  try {
    const body = await res.json() as { layout?: unknown; applied?: unknown };
    return { state: 'ok', layout: normalizeLayout(body?.layout), applied: typeof body?.applied === 'boolean' ? body.applied : undefined };
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
  // The server copy this device last saw or wrote (0 = none yet), sent with each
  // push so the server can tell whether anyone wrote in between.
  const syncedStamp = useRef(0);
  // Edits made since the server last confirmed one of our pushes, in order. Each
  // one is idempotent, so replaying it onto a copy that has it already is safe.
  const pending = useRef<Change[]>([]);
  const conflicts = useRef(0);
  // Every trip to the server (pull or push) runs alone, in order, so a pull can
  // never land between a push and the moment its acknowledgement is recorded.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const enqueue = useCallback((task: () => Promise<void>): Promise<void> => {
    queue.current = queue.current.then(task).catch(() => undefined);
    return queue.current;
  }, []);

  // No saved layout yet: run on the starter groups. They are not written back
  // until the first real edit, so every device derives the same default.
  const starter = useMemo(() => (saved ? null : starterLayout(agents)), [saved, agents]);
  const layout = saved ?? starter ?? { groups: [], collapsed: {}, updatedAt: 0 };
  const groups = useMemo(() => resolveGroups(layout, agents), [layout, agents]);

  // `persist` false keeps the copy in memory only: a copy taken from another tab
  // must not be written back to localStorage, or two tabs that each rebase onto
  // the other's write would echo stamped saves between them forever.
  const adopt = useCallback((next: RailLayout, persist = true) => {
    lastRemoteStamp = Math.max(lastRemoteStamp, next.updatedAt);
    savedRef.current = next;
    setSaved(next);
    if (persist) writeLocal(next);
  }, []);

  const schedulePush = useCallback((run: () => void) => {
    window.clearTimeout(pushTimer.current);
    pushTimer.current = window.setTimeout(run, PUSH_DEBOUNCE_MS);
  }, []);

  /** Lay this device's unsaved edits on top of `copy` (the server's, or another
   *  tab's). Returns true when something of ours is left to save. */
  const rebaseOnto = useCallback((copy: RailLayout, persist = true): boolean => {
    lastRemoteStamp = Math.max(lastRemoteStamp, copy.updatedAt);
    let merged = copy;
    for (const change of pending.current) merged = change(merged);
    if (merged === copy) {
      pending.current = [];
      adopt(copy, persist);
      return false;
    }
    adopt({ ...merged, updatedAt: Math.max(Date.now(), copy.updatedAt + 1, lastRemoteStamp + 1) }, persist);
    return true;
  }, [adopt]);

  const push = useCallback((keepalive = false): Promise<void> => {
    window.clearTimeout(pushTimer.current);
    pushTimer.current = 0;
    return enqueue(async () => {
      const mine = savedRef.current;
      if (!mine) return;
      // No sync endpoint: nothing will ever acknowledge these edits, so they are
      // not "pending" for anyone (the browser copy alone is the layout).
      if (Date.now() < absentUntil) { pending.current = []; return; }
      const sent = pending.current.length;
      const remote = await callRemote({
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ layout: mine, baseUpdatedAt: syncedStamp.current }),
        keepalive,
      });
      if (remote.state === 'absent') { pending.current = []; return; }
      if (remote.state !== 'ok' || !remote.layout) return;
      if (remote.applied === false) {
        // Another device wrote since our last look: keep their copy, replay ours.
        syncedStamp.current = remote.layout.updatedAt;
        const more = rebaseOnto(remote.layout);
        if (!more) { conflicts.current = 0; return; }
        if (conflicts.current < MAX_CONFLICT_RETRIES) { conflicts.current += 1; void push(); }
        else { conflicts.current = 0; schedulePush(() => void push()); }
        return;
      }
      conflicts.current = 0;
      // Saved. The server stamps it at least as new as ours; remember that so our
      // next push builds on it. Edits made while this push was in flight stay pending.
      syncedStamp.current = remote.layout.updatedAt;
      lastRemoteStamp = Math.max(lastRemoteStamp, remote.layout.updatedAt);
      pending.current.splice(0, sent);
    });
  }, [enqueue, rebaseOnto, schedulePush]);

  const reconcile = useCallback((remote: RailLayout | null) => {
    const mine = savedRef.current;
    syncedStamp.current = remote?.updatedAt ?? 0;
    if (remote) lastRemoteStamp = Math.max(lastRemoteStamp, remote.updatedAt);
    // The server is ahead, or two devices stamped the same millisecond with
    // different content (the server's copy is then the shared one).
    const serverAhead = remote !== null && (
      !mine
      || remote.updatedAt > mine.updatedAt
      || (remote.updatedAt === mine.updatedAt && JSON.stringify(remote) !== JSON.stringify(mine))
    );
    if (remote && serverAhead) {
      if (!mine) adopt(remote);
      else if (rebaseOnto(remote)) void push();
    } else if (mine && (!remote || mine.updatedAt > remote.updatedAt)) {
      void push();
    }
  }, [adopt, push, rebaseOnto]);

  const pull = useCallback((force = false): Promise<void> => enqueue(async () => {
    const now = Date.now();
    if (!force && now - lastPull.current < PULL_MIN_GAP_MS) return;
    lastPull.current = now;
    const remote = await callRemote();
    if (remote.state === 'ok') reconcile(remote.layout);
  }), [enqueue, reconcile]);

  useEffect(() => {
    void pull(true);
    const onFocus = () => { if (document.visibilityState === 'visible') void pull(); };
    const onHide = () => {
      if (document.visibilityState !== 'hidden') return;
      // An edit still waiting on its debounce goes out before the app sleeps.
      if (pushTimer.current) void push(true);
    };
    // Another tab of this browser saved: take its copy if it is newer, keeping
    // any edit of ours it has not seen.
    const onStorage = (e: StorageEvent) => {
      if (e.key !== LAYOUT_KEY) return;
      const next = readLocal();
      if (!next || next.updatedAt <= (savedRef.current?.updatedAt ?? 0)) return;
      if (pending.current.length) {
        // Memory only (see adopt): our own save goes out through the server path.
        if (rebaseOnto(next, false)) schedulePush(() => void push());
        return;
      }
      lastRemoteStamp = Math.max(lastRemoteStamp, next.updatedAt);
      savedRef.current = next;
      setSaved(next);
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
  }, [pull, push, rebaseOnto, schedulePush]);

  /** Run one edit against the layout on screen (saved, or the starter) and
   *  persist it with a fresh stamp that beats anything this device has seen.
   *  The edit is also remembered so a newer server copy can be re-edited. */
  const edit = useCallback((change: Change) => {
    const base = savedRef.current ?? starterLayout(agentsRef.current);
    const changed = change(base);
    if (changed === base) return;
    const next: RailLayout = { ...changed, updatedAt: Math.max(Date.now(), base.updatedAt + 1, lastRemoteStamp + 1) };
    pending.current.push(change);
    if (pending.current.length > MAX_PENDING) pending.current = [() => next];
    savedRef.current = next;
    setSaved(next);
    writeLocal(next);
    schedulePush(() => void push());
  }, [push, schedulePush]);

  const groupIdOf = useCallback((agentId: string) => (
    groups.find((g) => g.agents.some((a) => a.id === agentId))?.id ?? OTHER_GROUP_ID
  ), [groups]);

  const current = () => savedRef.current ?? starterLayout(agentsRef.current);
  const toggle = useCallback((id: string) => {
    // Decided now (open or shut), not flipped at replay time.
    const collapsed = !current().collapsed[id];
    edit((l) => setCollapsed(l, id, collapsed));
  }, [edit]);
  const create = useCallback((name: string) => {
    // Fixed up front so a replay onto a newer server copy keeps the same group.
    const id = newGroupId();
    edit((l) => createGroup(l, id, name));
  }, [edit]);
  const rename = useCallback((id: string, name: string) => edit((l) => renameGroup(l, id, name)), [edit]);
  const remove = useCallback((id: string) => edit((l) => deleteGroup(l, id)), [edit]);
  const shift = useCallback((id: string, by: -1 | 1) => {
    // Named by the neighbour it passes, so a replay cannot move it twice.
    const list = current().groups;
    const anchor = list[list.findIndex((g) => g.id === id) + by]?.id;
    if (anchor) edit((l) => placeGroup(l, id, anchor, by));
  }, [edit]);
  const move = useCallback((agentId: string, id: string, before: string | null) => edit((l) => moveAgent(l, agentId, id, before)), [edit]);

  return { groups, grouped: groups.some((g) => !g.isOther), toggle, create, rename, remove, shift, move, groupIdOf };
}
