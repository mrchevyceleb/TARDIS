// Client for agent-scoped chat-message pins (right pane, not Library/Pins).

import { useCallback, useEffect, useState } from 'react';
import { apiJson } from '../data/api';

export type MessagePin = {
  id: string;
  agentId: string;
  blockId: string;
  text: string;
  ts: number;
  createdAt: number;
};

export const MESSAGE_PINS_CHANGED = 'rivendell:message-pins';
export const OPEN_PANE_EVENT = 'rivendell:open-pane';

function emitChanged(): void {
  window.dispatchEvent(new Event(MESSAGE_PINS_CHANGED));
}

export function useAgentMessagePins(agentId: string | undefined): {
  pins: MessagePin[];
  loadError: boolean;
  toggle: (target: { blockId: string; text: string; ts: number }) => Promise<void>;
  unpin: (id: string) => Promise<void>;
} {
  const [pins, setPins] = useState<MessagePin[]>([]);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let alive = true;
    setPins([]);
    setLoadError(false);
    if (!agentId) return;
    const pull = () => {
      apiJson<{ pins: MessagePin[] }>(`/api/message-pins?agentId=${encodeURIComponent(agentId)}`)
        .then((r) => {
          if (!alive) return;
          setPins(r.pins ?? []);
          setLoadError(false);
        })
        .catch(() => { if (alive) setLoadError(true); });
    };
    pull();
    const onChange = () => pull();
    window.addEventListener(MESSAGE_PINS_CHANGED, onChange);
    // Agents pin from the server side (team_pin), which raises no browser
    // event; poll at the desk's usual cadence so their notes appear.
    const iv = window.setInterval(pull, 20_000);
    return () => {
      alive = false;
      window.removeEventListener(MESSAGE_PINS_CHANGED, onChange);
      window.clearInterval(iv);
    };
  }, [agentId]);

  const toggle = useCallback(async (target: { blockId: string; text: string; ts: number }) => {
    if (!agentId) return;
    try {
      const r = await apiJson<{ pin: MessagePin | null; pinned: boolean }>('/api/message-pins', {
        method: 'POST',
        body: JSON.stringify({ agentId, ...target }),
      });
      if (r.pinned) window.dispatchEvent(new Event(OPEN_PANE_EVENT));
      emitChanged();
    } catch {
      emitChanged();
    }
  }, [agentId]);

  const unpin = useCallback(async (id: string) => {
    try {
      await apiJson(`/api/message-pins/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch {
      /* reload below restores the row if the delete missed */
    }
    emitChanged();
  }, []);

  return { pins, loadError, toggle, unpin };
}

export function scrollToPinnedMessage(blockId: string): void {
  const el = document.getElementById(`msg-pin-${blockId}`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('pin-flash');
  void (el as HTMLElement).offsetWidth;
  el.classList.add('pin-flash');
}
