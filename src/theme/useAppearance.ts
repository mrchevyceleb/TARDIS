import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import { fetchAppearance, saveAppearance } from '../data/api';
import { APPEARANCE_KEY, PRE_SYNC_KEY, SYNCED_KEY, defaultAppearance, normalizeAppearance, queueAppearanceEdit, readAppearance, readPendingAppearance, rememberPendingAppearance, writeAppearance, type Appearance } from './themes';

export function useAppearance() {
  const [appearance, setValue] = useState(readAppearance);
  const [syncStatus, setSyncStatus] = useState<'loading' | 'saving' | 'saved' | 'local' | 'error'>('loading');
  const [hadSavedLook] = useState(() => {
    try {
      const defaults = defaultAppearance();
      return Boolean(localStorage.getItem(APPEARANCE_KEY)) && Object.entries(appearance).some(([key, value]) => defaults[key as keyof Appearance] !== value);
    } catch { return false; }
  });
  const current = useRef(appearance);
  const pending = useRef(readPendingAppearance());
  const syncRef = useRef<() => void>(() => {});
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const setAppearance = useCallback((action: SetStateAction<Appearance>) => {
    const next = typeof action === 'function' ? action(current.current) : action;
    const changed = Object.fromEntries(Object.entries(next).filter(([key, value]) => current.current[key as keyof Appearance] !== value));
    if (!Object.keys(changed).length) return;
    pending.current = queueAppearanceEdit(next, current.current, pending.current);
    current.current = next;
    // Immediate local persistence also covers closing the tab before the debounce.
    writeAppearance(next);
    setValue(next);
    setSyncStatus('saving');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => syncRef.current(), 350);
  }, []);

  useEffect(() => {
    let active = true;
    let busy = false;
    const accept = (remote: Partial<Appearance>) => {
      const next = normalizeAppearance({ ...remote, ...pending.current }, current.current);
      if (Object.entries(next).some(([key, value]) => current.current[key as keyof Appearance] !== value)) {
        current.current = next;
        setValue(next);
      }
    };
    const sync = async () => {
      if (busy || !active || document.hidden) return;
      busy = true;
      let succeeded = false;
      let snapshot: Partial<Appearance> = {};
      let serverLook: Partial<Appearance> | null = null;
      try {
        pending.current = readPendingAppearance(pending.current);
        const remote = await fetchAppearance();
        serverLook = remote.appearance;
        if (!active) return;
        pending.current = readPendingAppearance(pending.current);
        if (remote.appearance) {
          try {
            if (hadSavedLook && !localStorage.getItem(SYNCED_KEY) && !localStorage.getItem(PRE_SYNC_KEY)
              && Object.entries(remote.appearance).some(([key, value]) => current.current[key as keyof Appearance] !== value)) {
              localStorage.setItem(PRE_SYNC_KEY, JSON.stringify(current.current));
            }
          } catch { /* sync also works without storage */ }
          accept(remote.appearance);
        }
        // A seed is only this request's payload, never a durable full-look edit.
        snapshot = remote.appearance ? { ...pending.current } : { ...current.current, ...pending.current };
        if (Object.keys(snapshot).length) {
          const saved = await saveAppearance(snapshot);
          if (!active) return;
          pending.current = readPendingAppearance(pending.current);
          for (const key of Object.keys(snapshot) as (keyof Appearance)[]) {
            if (pending.current[key] === snapshot[key]) delete pending.current[key];
          }
          rememberPendingAppearance(pending.current, snapshot);
          accept(saved.appearance);
        }
        try { localStorage.setItem(SYNCED_KEY, 'true'); } catch { /* optional migration marker */ }
        succeeded = true;
        setSyncStatus(Object.keys(pending.current).length ? 'saving' : 'saved');
      } catch (error) {
        if (active && [400, 422].includes((error as { status?: number }).status ?? 0)) {
          // Invalid edits cannot become an endless offline retry. Keep any newer
          // edits and restore the last accepted server look for rejected fields.
          pending.current = readPendingAppearance(pending.current);
          for (const key of Object.keys(snapshot) as (keyof Appearance)[]) {
            if (pending.current[key] === snapshot[key]) delete pending.current[key];
          }
          rememberPendingAppearance(pending.current);
          if (serverLook) accept(serverLook);
          setSyncStatus('error');
        } else if (active) setSyncStatus('local');
      } finally {
        busy = false;
        // Edits made during a request get their own save, rather than waiting
        // for a poll. Failed writes wait for focus, reconnect, or the next poll.
        if (active && succeeded && Object.keys(pending.current).length) {
          clearTimeout(timer.current);
          timer.current = setTimeout(() => { void sync(); }, 350);
        }
      }
    };
    const wake = () => { void sync(); };
    const storage = (event: StorageEvent) => {
      if (event.key !== APPEARANCE_KEY) return;
      pending.current = readPendingAppearance(pending.current);
      const next = readAppearance();
      if (Object.entries(next).some(([key, value]) => current.current[key as keyof Appearance] !== value)) {
        current.current = next;
        setValue(next);
      }
      wake();
    };
    syncRef.current = wake;
    wake();
    const poll = setInterval(wake, 15_000);
    window.addEventListener('storage', storage);
    window.addEventListener('focus', wake);
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      active = false;
      clearInterval(poll);
      clearTimeout(timer.current);
      window.removeEventListener('storage', storage);
      window.removeEventListener('focus', wake);
      window.removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', wake);
    };
  }, []);

  return { appearance, setAppearance, syncStatus };
}
