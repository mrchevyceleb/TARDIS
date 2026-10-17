// Live checklist for one agent (card-a77246): loaded once per owner, then
// kept current by the server's 'checklist' lane events — every
// sidebar_checklist tool write broadcasts one, so the sidebar updates the
// moment the agent moves the work. Never polling.
import { useEffect, useState } from 'react';
import { apiJson } from '../data/api';

export type ChecklistItem = {
  id: string;
  text: string;
  status?: string;
  assignee?: string;
  done?: boolean;
  doneAt?: number;
  doneBy?: string;
};

export type Checklist = {
  owner: string;
  title?: string;
  items: ChecklistItem[];
  createdAt: number;
  updatedAt: number;
};

export const CHECKLIST_EVENT = 'rivendell:checklist';

export function useChecklist(owner: string | undefined, pollMs?: number): { checklist: Checklist | null; loadError: boolean } {
  const [checklist, setChecklist] = useState<Checklist | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let alive = true;
    setChecklist(null);
    setLoadError(false);
    if (!owner) return;
    const pull = () => {
      apiJson<{ checklist: Checklist | null }>(`/api/checklists/${encodeURIComponent(owner)}`)
        .then((r) => {
          if (!alive) return;
          setChecklist(r.checklist ?? null);
          setLoadError(false);
        })
        .catch(() => { if (alive) setLoadError(true); });
    };
    pull();
    // The chat socket dispatches server-pushed checklist updates as window
    // events (useChat's onmessage); a push for another owner is ignored.
    // Channel surfaces hold no chat socket yet, so no push arrives there: a
    // modest interim refresh (plus focus) keeps the channel strip current
    // until channels gain their own socket and the push path lights up.
    const onPush = (e: Event) => {
      const detail = (e as CustomEvent<{ owner?: string; checklist?: Checklist | null }>).detail;
      if (!alive || detail?.owner !== owner) return;
      setChecklist(detail.checklist ?? null);
    };
    const onFocus = () => pull();
    window.addEventListener(CHECKLIST_EVENT, onPush as EventListener);
    window.addEventListener('focus', onFocus);
    const iv = pollMs ? window.setInterval(pull, pollMs) : null;
    return () => {
      alive = false;
      window.removeEventListener(CHECKLIST_EVENT, onPush as EventListener);
      window.removeEventListener('focus', onFocus);
      if (iv) window.clearInterval(iv);
    };
  }, [owner, pollMs]);

  return { checklist, loadError };
}
