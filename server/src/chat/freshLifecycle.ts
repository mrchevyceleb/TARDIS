// Fresh lifecycle hooks (card-8d427d review P1 2+3, Oct 20): the programmatic
// Fresh (POST /api/team/fresh) runs outside the WS closure, so it cannot reach
// the per-socket state the UI Fresh cleans up inline. register.ts installs
// these hooks; freshChat.ts drives them in the UI path's own order:
// `started` right after the reset epoch commits (invalidate every lane
// generation for the thread, drop held steers), and `completed` only once the
// wipe actually succeeded — the WS layer then broadcasts freshStarted, so a
// client never drops its transcript for a reset that failed (P1 3).

export type FreshLifecycleEvent = {
  logKey: string;
  repo: string;
  chatId: string;
  cli: string;
  /** The committed reset epoch (set on completed). */
  resetAt?: number;
};

export type FreshLifecycleHooks = {
  started: (event: FreshLifecycleEvent) => void;
  completed: (event: FreshLifecycleEvent) => void;
};

let hooks: FreshLifecycleHooks | null = null;

export function setFreshLifecycle(next: FreshLifecycleHooks | null): void {
  hooks = next;
}

/** Best-effort by design: the wipe is the durable act, and a hook failure must
 *  never fail a reset or leave the caller's result wrong. */
export function freshLifecycleStarted(event: FreshLifecycleEvent): void {
  try { hooks?.started(event); } catch { /* never block a reset */ }
}

export function freshLifecycleCompleted(event: FreshLifecycleEvent): void {
  try { hooks?.completed(event); } catch { /* never block a reset */ }
}
