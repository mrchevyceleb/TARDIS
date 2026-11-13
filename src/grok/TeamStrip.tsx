// The team as a room seats it when the full rail steps aside: a slim column of
// faces (Dock), stations across the top (Crew), or a strip under the phone's
// header. Every face carries the same truth as the rail: online, working, and
// how many replies are waiting.

import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { agentTaskMap, agentTaskSubline, useDeskCardsLight, useDeskPrs, type TaskQueryState } from '../data/desk';
import type { TeamView } from '../theme/roomParts';
import { agentAvatarUrl, agentColor, agentMark, DISC_INK, type Agent } from './agents';
import { teamOrder, type TeamPresence } from './teamPresence';
import { fitName } from './fitName';
import './teamStrip.css';

export function TeamStrip({ agents, presence, activeAgentId, orientation, team, onOpenAgent, lead }: {
  agents: Agent[];
  presence: TeamPresence;
  activeAgentId?: string;
  orientation: 'column' | 'row';
  team: TeamView;
  onOpenAgent: (agent: Agent) => void;
  /** The control that opens the whole rail (the dock keeps it at the top). */
  lead?: ReactNode;
}) {
  const members = useMemo(() => teamOrder(agents), [agents]);
  const stations = orientation === 'row' && team === 'seats';
  const tasks = useDeskCardsLight(stations);
  const prs = useDeskPrs(stations);
  const taskMap = useMemo(() => agentTaskMap(tasks.data?.cards ?? [], agents), [tasks.data, agents, tasks.dataUpdatedAt]);
  const tasksState: TaskQueryState = tasks.isError ? 'error' : tasks.data ? 'ready' : 'loading';
  const prsState: TaskQueryState = prs.isError || prs.data?.stale || prs.data?.unknown ? 'error' : !prs.data || prs.data.pending ? 'loading' : 'ready';

  // Keep the open conversation's face in view as the strip scrolls.
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeAgentId, orientation]);

  return (
    <nav className={`team-strip is-${orientation}`} aria-label="Your team">
      {lead}
      <div className="team-strip-list" ref={list}>
        {members.map((a) => {
          const working = presence.busy.has(a.id);
          const online = presence.live.has(a.id);
          const unread = a.muted ? 0 : a.unread ?? 0;
          const url = agentAvatarUrl(a);
          const state = working ? 'working' : online ? 'online' : 'free';
          const status = working ? 'Working' : online ? 'Online' : 'Free';
          const doing = stations ? agentTaskSubline(taskMap.get(a.id) ?? {}, (prs.data?.prs ?? []).filter((p) => p.owner === a.name), tasksState, prsState).text : '';
          return (
            <button
              key={a.id}
              type="button"
              className={`ts-member${a.muted ? ' is-muted' : ''}`}
              data-state={state}
              aria-current={a.id === activeAgentId ? 'true' : undefined}
              aria-label={`${a.name}, ${status.toLowerCase()}${unread ? `, ${unread} unread` : ''}${a.muted ? ', muted' : ''}${doing ? `. ${doing}` : ''}`}
              title={`${a.name} · ${a.role}`}
              onClick={() => onOpenAgent(a)}
            >
              <span className="ts-face" style={url ? undefined : { background: agentColor(a.name), color: DISC_INK }}>
                {url ? <img src={url} alt="" draggable={false} /> : agentMark(a)}
                {unread ? <span className="ts-unread" aria-hidden="true">{unread > 9 ? '9+' : unread}</span> : null}
              </span>
              <span className="ts-text" aria-hidden="true">
                <span className="ts-name" ref={fitName}>{a.name}</span>
                {stations ? <span className="ts-doing"><i /><span>{status}{doing ? ` · ${doing}` : ''}</span></span> : <span className="ts-role">{a.role}</span>}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
