// Small shared pieces for the Desk room (Needs you + Board + card drawer).

import { useQuery } from '@tanstack/react-query';
import { createContext, useContext } from 'react';
import { MessageCircle } from 'lucide-react';
import { apiJson } from '../data/api';
import type { DeskActor, DeskPriority } from '../data/desk';
import { agentColor, DISC_INK, type Agent } from '../grok/agents';

/** Agents for owner pickers and name lookups. The sidebar already polls the
 *  roster; a minute of staleness is fine for a picker. */
export function useDeskAgents(): Agent[] {
  const query = useQuery({
    queryKey: ['desk-agents'],
    queryFn: () => apiJson<{ agents: Agent[] }>('/api/agents'),
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: 1,
  });
  return query.data?.agents ?? [];
}

export const PRIORITY_LABEL: Record<DeskPriority, string> = { high: 'High', normal: 'Normal', low: 'Low' };

/** Maps Desk priority onto the shared priority color classes. */
export function priorityClass(priority: DeskPriority): string {
  return priority === 'high' ? 'priority-high' : priority === 'low' ? 'priority-low' : 'priority-medium';
}

export function ActorChip({ actor, prefix, compact }: { actor: DeskActor; prefix?: string; compact?: boolean }) {
  const owner = actor.kind === 'owner';
  return (
    <span className={`desk-actor${owner ? ' is-owner' : ''}${compact ? ' is-compact' : ''}`} title={`${prefix ? `${prefix} ` : ''}${actor.name}`}>
      <span
        className="desk-actor-disc"
        aria-hidden="true"
        style={owner ? undefined : { background: agentColor(actor.name), color: DISC_INK }}
      >
        {actor.name.trim().slice(0, 1).toUpperCase() || '?'}
      </span>
      {compact ? null : <span className="desk-actor-name">{prefix ? `${prefix} ` : ''}{actor.name}</span>}
    </span>
  );
}

/** Pretty label for a stored link. */
export function linkLabel(link: string, agents: Agent[]): string {
  if (link.startsWith('thread:')) {
    const id = link.slice('thread:'.length);
    const agent = agents.find((a) => a.id === id);
    return `${agent?.name ?? id} thread`;
  }
  try {
    const url = new URL(link);
    const pr = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (url.hostname === 'github.com' && pr) return `${pr[2]} #${pr[3]}`;
    return url.hostname.replace(/^www\./, '') + (url.pathname.length > 1 ? url.pathname.slice(0, 24) : '');
  } catch {
    return link;
  }
}

/** Server errors arrive as JSON text; show just the message. */
export function errorText(error: unknown): string {
  const raw = (error as Error)?.message ?? String(error);
  try {
    const parsed = JSON.parse(raw) as { error?: string };
    if (parsed?.error) return parsed.error;
  } catch { /* plain text */ }
  return raw.slice(0, 200);
}

/** Opens the Desk chat with this card or item as a reference chip. */
export function DiscussButton({ onClick, subject, label }: { onClick: () => void; subject: string; label?: string }) {
  return (
    <button
      type="button"
      className={`desk-icon-btn desk-discuss-btn${label ? ' has-label' : ''}`}
      onClick={(event) => { event.stopPropagation(); onClick(); }}
      aria-label={`Discuss ${subject} in chat`}
      title="Discuss in chat"
    >
      <MessageCircle size={14} aria-hidden="true" />
      {label ? <span>{label}</span> : null}
    </button>
  );
}

/** True while the Desk chat is open beside the room. The card drawer stops
 *  acting as a modal then, so the chat stays usable. */
export const DeskChatOpenContext = createContext(false);
export function useDeskChatOpen(): boolean {
  return useContext(DeskChatOpenContext);
}
