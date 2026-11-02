// Desk team view (card-292afa): each team is a live room — a row of teammate
// avatars showing what each person is on, working teammates pulsing — and the
// four things Matt most needs at a glance: needs him, went live today (moved
// into Live today, ET), moving right now, stuck or late. Plain English, one
// line per item; the big piles collapse to counts. Click a zone to open it;
// items visibly travel when their stage changes. The old column board stays
// one click away (DeskBoard).

import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, AlertTriangle, ArrowRight, GripVertical, LayoutGrid, Rocket, Users } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import type { JobView } from '../chat/hooks/useJobs';
import { hasRecentTurnSignal, lastTurnSignal } from '../chat/utils/livePresence';
import type { LiveSession } from '../chat/data/types';
import { apiJson } from '../data/api';
import { resolveGroups, starterLayout, type RailLayout } from '../grok/railGroups';
import { isTodoOpen, agoText, agentTaskMap, CARD_STAGE_WORDS as STAGE_WORDS, hoursSince, openAgentThread, TASK_LABEL, taskKindOf, withHeadline, type DeskActor, type DeskCard, type DeskSnapshot, type DeskTodo } from '../data/desk';
import { agentAvatarUrl, agentColor, chatColorOf, DISC_INK, type Agent } from '../grok/agents';
import './deskTeam.css';

type Props = { desk: DeskSnapshot; dataUpdatedAt: number; agents: Agent[]; onOpenCard: (id: string) => void; onShowBoard: () => void };

type Team = { id: string; label: string; members: Agent[] };

/** A card older than this in an active column reads as stuck. */
const STUCK_HOURS = 48;
/** "Moving now" looks back this far. */
const DAY_HOURS = 24;

function cardOwnerName(card: DeskCard): string {
  return card.owner.kind === 'owner' ? 'Matt' : card.owner.name;
}

/** Same calendar day in Eastern Time — "went live today" is today, ET, not a
 *  rolling 24 hours (Max, Oct 17: Friday's ships must not show as live today
 *  on Saturday morning). */
function isTodayEt(iso: string): boolean {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
  return fmt.format(new Date(iso)) === fmt.format(new Date());
}

type ZoneFacts = {
  team: Team;
  needsMatt: DeskTodo[];
  liveToday: DeskCard[];
  moving: DeskCard[];
  workingIds: Set<string>;
  backgroundCount: number;
  quietCount: number;
  stuck: DeskCard[];
  overdue: DeskTodo[];
  parkedCount: number;
  stagingCount: number;
  staleStaging: DeskCard[];
  onNow: Map<string, { text: string; detail?: string; at?: number; source: 'live' | 'job' | 'card'; caption?: string; label?: string; ageText?: string; quiet?: boolean; starting?: boolean; jobText?: string; headline?: string; cue?: string; cardId?: string; kindLabel?: string; sections?: Array<{ title: string; meta: string; text: string; kind: 'task' | 'turn' | 'job' }> }>;
};

export function DeskTeamView({ desk, dataUpdatedAt, agents, onOpenCard, onShowBoard }: Props) {
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [openZone, setOpenZone] = useState<string | null>(null);
  const [order, setOrder] = useState<string[]>([]);
  const [dragZone, setDragZone] = useState<string | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const backdropPressed = useRef(false);
  const closeDetail = (restoreFocus = true) => {
    const id = selectedAgent;
    setSelectedAgent(null);
    if (!restoreFocus) return;
    window.requestAnimationFrame(() => {
      if (id) document.querySelector<HTMLButtonElement>(`[data-desk-agent="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
    });
  };
  const selectionExists = agents.some((agent) => agent.id === selectedAgent);
  useEffect(() => {
    if (!selectedAgent || !selectionExists) {
      if (selectedAgent) setSelectedAgent(null);
      return;
    }
    detailRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeDetail();
      } else if (event.key === 'Tab') {
        const buttons = detailRef.current?.querySelectorAll<HTMLButtonElement>('button');
        if (!buttons?.length) return;
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [selectedAgent, selectionExists]);
  const teammates = useQuery({
    queryKey: ['desk-agents'],
    queryFn: () => apiJson<{ agents: Agent[] }>('/api/agents', { signal: AbortSignal.timeout(8_000) }),
    staleTime: 4_000,
    retry: 1,
  });
  const roster = useQuery({
    queryKey: ['desk-team-layout'],
    queryFn: () => apiJson<{ layout: RailLayout | null }>('/api/rail-layout', { signal: AbortSignal.timeout(8_000) }),
    refetchInterval: 4_000,
    retry: 1,
  });
  const activity = useQuery({
    queryKey: ['live-sessions'],
    refetchOnWindowFocus: 'always',
    queryFn: () => apiJson<{ sessions: LiveSession[] }>('/api/live?activity=1', { signal: AbortSignal.timeout(8_000) }),
    refetchInterval: 4_000,
    retry: 1,
  });
  const jobs = useQuery({
    queryKey: ['jobs', 'summary'],
    queryFn: () => apiJson<{ jobs: JobView[] }>('/api/jobs?active=1', { signal: AbortSignal.timeout(8_000) }),
    refetchInterval: 4_000,
    retry: 1,
  });
  const jobsByAgent = useMemo(() => {
    const byAgent = new Map<string, JobView[]>();
    for (const job of jobs.isError ? [] : jobs.data?.jobs ?? []) {
      if (job.state !== 'running') continue;
      const running = byAgent.get(job.agentId) ?? [];
      running.push(job);
      byAgent.set(job.agentId, running);
    }
    for (const running of byAgent.values()) running.sort((a, b) => b.startedAt - a.startedAt);
    return byAgent;
  }, [jobs.data, jobs.isError]);
  // No name-based starter roster. Unseated/new teammates always have a place.
  const teams = useMemo<Team[]>(() => resolveGroups(roster.data?.layout ?? (roster.isError ? { groups: [], collapsed: {}, updatedAt: 0 } : starterLayout(agents)), agents)
    .filter((g) => g.agents.length)
    .map((g) => ({ id: g.id, label: g.isOther ? roster.isError && !roster.data ? 'Teammates · groups unavailable' : 'Other teammates' : g.name, members: g.agents })), [roster.data, roster.isError, agents]);
  const cardsById = useMemo(() => new Map(desk.cards.map((c) => [c.id, c])), [desk]);
  const liveByAgent = useMemo(() => {
    const byAgent = new Map<string, LiveSession[]>();
    // A failed poll cannot keep an old green working pulse alive.
    for (const session of activity.isError ? [] : activity.data?.sessions ?? []) {
      if (!session.busy && !session.backgroundTasks?.length) continue;
      const home = session.chatId.replace(/__acct__[a-z0-9-]+$/i, '').replace(/__bg$/, '');
      const agent = agents.find((a) => session.agentId ? a.id === session.agentId : a.home === home);
      if (!agent) continue;
      const lanes = byAgent.get(agent.id) ?? [];
      lanes.push(session);
      byAgent.set(agent.id, lanes);
    }
    // Both lanes can be busy; the most recently active lane leads, with its
    // own current-turn text. A generic busy lane never borrows another task.
    for (const lanes of byAgent.values()) lanes.sort((a, b) => Number(b.busy) - Number(a.busy) || b.lastActivityAt - a.lastActivityAt || a.chatId.localeCompare(b.chatId));
    return byAgent;
  }, [activity.data, activity.isError, agents]);

  const taskMap = useMemo(() => agentTaskMap(desk.cards, agents), [desk.cards, agents, activity.dataUpdatedAt, activity.errorUpdatedAt]);

  const facts = useMemo<ZoneFacts[]>(() => {
    return teams.map((team) => {
      const inTeam = (actor: DeskActor) => actor.kind === 'agent' && team.members.some((a) => a.id === actor.id);
      const cards = desk.cards.filter((c) => !c.archived && inTeam(c.owner));
      const needsMatt = desk.todos.filter((t) => isTodoOpen(t) && inTeam((t.cardId && cardsById.get(t.cardId)?.owner) || t.from));
      const liveToday = cards.filter((c) => c.column === 'in_production' && isTodayEt(c.columnSince ?? c.createdAt));
      const moving = cards.filter((c) => c.column === 'in_progress' && hoursSince(c.updatedAt) <= DAY_HOURS);
      const stuck = cards.filter((c) => ['in_progress', 'in_qa'].includes(c.column) && hoursSince(c.updatedAt) > STUCK_HOURS);
      const overdue = needsMatt.filter((t) => t.due && new Date(t.due).getTime() < Date.now());
      const onNow: ZoneFacts['onNow'] = new Map();
      for (const agent of team.members) {
        const lanes = liveByAgent.get(agent.id);
        const running = jobsByAgent.get(agent.id);
        const laneName = (session: LiveSession) => /__bg(?:__acct__[a-z0-9-]+)?$/i.test(session.chatId) ? 'Background turn' : 'Chat turn';
        const slot = taskMap.get(agent.id) ?? {};
        const task = withHeadline(slot);
        const taskCard = slot.current ?? slot.waiting ?? slot.next;
        const kind = taskKindOf(slot);
        const kindLabel = kind ? TASK_LABEL[kind] : 'Current task';
        const sections: NonNullable<NonNullable<ReturnType<typeof onNow.get>>['sections']> = [
          ...(taskCard && task.headline ? [{ title: kindLabel, meta: `${STAGE_WORDS[taskCard.column]} · updated ${agoText(taskCard.updatedAt)}`, text: task.headline, kind: 'task' as const }] : []),
          ...(lanes ?? []).map((session) => ({ title: session.busy ? laneName(session) : 'Background task', meta: `${hasRecentTurnSignal(session) ? 'Active' : session.busy ? 'Quiet · no signal in 2+ minutes' : 'Running'} · last signal ${agoText(new Date(lastTurnSignal(session)).toISOString())}`, text: session.activity?.detail || session.activity?.text || (session.backgroundTasks?.length ? session.backgroundTasks.join(' · ') : 'No visible activity update yet.'), kind: 'turn' as const })),
          ...(running ?? []).map((job) => ({ title: 'Background job', meta: `Started ${agoText(new Date(job.startedAt).toISOString())}`, text: job.name, kind: 'job' as const })),
        ];
        const activeLane = lanes?.find((session) => hasRecentTurnSignal(session));
        // Recent job work leads when the only open turns have gone quiet.
        if (running?.length && !activeLane) {
          const label = running.length === 1 ? 'Background job' : `${running.length} background jobs`;
          const ageText = `Started ${agoText(new Date(running[0].startedAt).toISOString())}`;
          const cue = `${label} · ${ageText}`;
          onNow.set(agent.id, { text: running[0].name, sections, label, ageText, caption: cue, headline: task.headline, cue: taskCard ? cue : undefined, kindLabel, cardId: taskCard?.id, jobText: lanes?.some((lane) => lane.busy) ? 'Also has a quiet open turn' : undefined, at: running[0].startedAt, source: 'job' });
          continue;
        }
        if (lanes?.length) {
          const lane = activeLane ?? lanes[0];
          const at = lane.activity?.at ?? lastTurnSignal(lane);
          const quiet = lane.busy && !hasRecentTurnSignal(lane);
          const starting = lane.busy && !quiet && !lane.activity;
          const label = lane.busy ? `${quiet ? 'Quiet ' : starting ? 'Starting ' : ''}${laneName(lane).toLowerCase()}` : 'Background task';
          const ageText = `${lane.activity ? 'Updated' : 'Last signal'} ${agoText(new Date(at).toISOString())}`;
          const text = lane.busy ? lane.activity?.text || (starting ? 'A new turn is getting underway' : 'Waiting for a fresh activity update') : `Running in background: ${lane.backgroundTasks?.join(' · ')}`;
          const cue = `${label} · ${ageText}`;
          onNow.set(agent.id, { text, label, ageText, caption: cue, headline: task.headline, cue: taskCard ? cue : undefined, kindLabel, cardId: taskCard?.id, quiet, starting, sections, jobText: running?.length ? `Job: ${running[0].name}${running.length > 1 ? ` · +${running.length - 1} more` : ''}` : lanes.length > 1 ? `+${lanes.length - 1} more lane${lanes.length > 2 ? 's' : ''}` : undefined, at, source: lane.busy ? 'live' : 'job' });
          continue;
        }
        if (taskCard && task.headline) onNow.set(agent.id, { text: task.headline, headline: task.headline, kindLabel, cue: `${kindLabel} · updated ${agoText(taskCard.updatedAt)}`, cardId: taskCard.id, label: kindLabel, ageText: `Updated ${agoText(taskCard.updatedAt)}`, caption: `${kindLabel} · ${task.headline}`, at: Date.parse(taskCard.updatedAt), source: 'card', sections });
      }
      return {
        team,
        needsMatt,
        liveToday,
        moving,
        workingIds: new Set(team.members.filter((a) => liveByAgent.get(a.id)?.some((lane) => hasRecentTurnSignal(lane))).map((a) => a.id)),
        quietCount: team.members.filter((a) => liveByAgent.get(a.id)?.some((lane) => lane.busy) && !liveByAgent.get(a.id)?.some((lane) => hasRecentTurnSignal(lane))).length,
        backgroundCount: team.members.filter((a) => jobsByAgent.has(a.id)).length,
        stuck,
        overdue,
        parkedCount: cards.filter((c) => c.column === 'not_started').length,
        stagingCount: cards.filter((c) => c.column === 'on_staging' && hoursSince(c.updatedAt) <= STUCK_HOURS).length,
        staleStaging: cards.filter((c) => c.column === 'on_staging' && !(hoursSince(c.updatedAt) <= STUCK_HOURS)),
        onNow,
      };
    });
  // Poll timestamps advance deadlines even when the snapshot is shared.
  }, [desk, dataUpdatedAt, cardsById, teams, liveByAgent, jobsByAgent, taskMap, activity.dataUpdatedAt, activity.errorUpdatedAt]);

  // Items visibly travel: a card whose stage changed since the last snapshot
  // gets the travel note for a few seconds.
  const prevColumns = useRef(new Map<string, string>());
  const [traveling, setTraveling] = useState<Set<string>>(new Set());
  useEffect(() => {
    const changed: string[] = [];
    for (const c of desk.cards) {
      const prev = prevColumns.current.get(c.id);
      if (prev && prev !== c.column) changed.push(c.id);
      prevColumns.current.set(c.id, c.column);
    }
    if (!changed.length) return;
    setTraveling(new Set(changed));
    const t = window.setTimeout(() => setTraveling(new Set()), 3200);
    return () => window.clearTimeout(t);
  }, [desk]);

  const orderedIds = [...order.filter((id) => facts.some((f) => f.team.id === id)), ...facts.map((f) => f.team.id).filter((id) => !order.includes(id))];
  const orderedFacts = orderedIds.map((id) => facts.find((f) => f.team.id === id)).filter((f): f is ZoneFacts => Boolean(f));

  const onDrop = (targetId: string) => {
    if (!dragZone || dragZone === targetId) return;
    setOrder((cur) => {
      const next = [...cur, ...orderedIds.filter((id) => !cur.includes(id))].filter((id) => id !== dragZone);
      next.splice(next.indexOf(targetId), 0, dragZone);
      return next;
    });
    setDragZone(null);
  };

  const selected = agents.find((a) => a.id === selectedAgent);
  const selectedLine = facts.find((f) => f.team.members.some((a) => a.id === selectedAgent))?.onNow.get(selectedAgent ?? '');
  return (
    <div className="desk-team">
      <div className="desk-team-head">
        <span className="desk-team-title">One glance per team</span>
        <button type="button" className="desk-team-board" onClick={onShowBoard} title="Open the column board">
          <LayoutGrid size={13} /> Column board
        </button>
      </div>
      <p className="desk-team-freshness" role="status">
        {activity.isError ? 'Live turns could not refresh.' : activity.isPending ? 'Connecting to live activity…' : 'Updates every 4 seconds · quiet turns have no signal for 2+ minutes'}
        {roster.isError ? ' Team groups could not refresh.' : ''}
        {jobs.isError ? ' Background jobs could not refresh.' : ''}
        {teammates.isError ? ' Teammates could not refresh.' : ''}
      </p>
      <div className="desk-team-zones">
        {teammates.isPending && !agents.length ? <div className="desk-zone-empty" role="status">Loading teammates…</div> : orderedFacts.map((f) => {
          const isOpen = openZone === f.team.id;
          const attention = f.needsMatt.length + f.stuck.length + f.overdue.length + f.staleStaging.length;
          const counts = [
            f.parkedCount ? `${f.parkedCount} queued` : '',
            f.stagingCount ? `${f.stagingCount} on staging · under 2 days` : '',
            f.staleStaging.length ? `${f.staleStaging.length} on staging · 2+ days` : '',
          ].filter(Boolean);
          return (
            <section
              key={f.team.id}
              className={`desk-zone${isOpen ? ' open' : ''}${attention ? ' has-attention' : ''}${dragZone === f.team.id ? ' dragging' : ''}`}
              draggable
              onDragStart={() => setDragZone(f.team.id)}
              onDragEnd={() => setDragZone(null)}
              onDragOver={(e) => { if (dragZone && dragZone !== f.team.id) e.preventDefault(); }}
              onDrop={() => onDrop(f.team.id)}
            >
              <button type="button" className="desk-zone-head" onClick={() => setOpenZone(isOpen ? null : f.team.id)} aria-expanded={isOpen}>
                <GripVertical size={13} className="desk-zone-grip" aria-hidden="true" />
                <span className="desk-zone-name">{f.team.label}</span>
                <span className="desk-zone-lead">{f.team.members.length} teammates · {f.workingIds.size} active now</span>
                <ArrowRight size={14} className={`desk-zone-chevron${isOpen ? ' turned' : ''}`} aria-hidden="true" />
              </button>
              <div className="desk-zone-room" aria-label="Who is here and what they are on">
                {f.team.members.map((agent) => {
                  const name = agent.name;
                  const on = f.onNow.get(agent.id);
                  const working = f.workingIds.has(agent.id) && !on?.quiet;
                  const color = agentColor(name);
                  const chatColor = chatColorOf(agent);
                  const avatarUrl = agent ? agentAvatarUrl(agent) : null;
                  return (
                    <button
                      type="button"
                      onClick={() => setSelectedAgent((id) => id === agent.id ? null : agent.id)}
                      aria-expanded={selectedAgent === agent.id}
                      aria-haspopup="dialog"
                      aria-controls={selectedAgent === agent.id ? 'desk-person-dialog' : undefined}
                      data-desk-agent={agent.id}
                      key={agent.id}
                      className={`desk-avatar-tile${on?.quiet ? ' awaiting-update' : ''}${on?.starting ? ' starting-turn' : ''}${working ? ' working' : ''}${on ? ' has-on' : ''}${on?.source === 'job' ? ' has-job' : ''}${selectedAgent === agent.id ? ' expanded' : ''}`}
                      title={`${name} — ${on?.headline ? `${on.kindLabel ?? 'Current task'}: ${on.headline}${on.cue ? ` · ${on.cue}` : ''}` : on ? `${on.caption ?? 'Activity'}: ${on.text}` : activity.isError ? 'Live activity unavailable' : 'No current task'}`}
                    >
                      <span
                        className="desk-avatar"
                        style={chatColor ? { background: `var(--bt-cc-${chatColor}, ${color})`, color: DISC_INK } : { background: color, color: DISC_INK }}
                        aria-hidden="true"
                      >
                        {avatarUrl ? <img className="desk-avatar-img" src={avatarUrl} alt="" /> : name.slice(0, 1)}
                        {working ? <span className="desk-avatar-pulse" /> : null}
                      </span>
                      <span className="desk-avatar-name">{name}</span>
                      <span className={`desk-avatar-source${working ? ' is-live' : ''}`}><span>{on?.headline ? (on.cue ?? (on.kindLabel ?? 'Current task')) : (on?.label ?? (activity.isError ? 'Live unavailable' : activity.isPending ? 'Connecting' : 'No current task'))}</span>{!on?.headline && on?.at ? <span className="desk-avatar-age">{on.ageText ?? `Updated ${agoText(new Date(on.at).toISOString())}`}</span> : null}</span>
                      {on?.headline ? <span className="desk-avatar-on">{on.headline}</span> : on ? <span className="desk-avatar-on">{on.text}</span> : <span className="desk-avatar-on is-quiet">{activity.isError || activity.isPending ? 'Checking current activity' : 'No current task'}</span>}
                      {on?.jobText ? <span className="desk-avatar-job">{on.jobText}</span> : null}
                    </button>
                  );
                })}
              </div>
              {counts.length ? <div className="desk-zone-counts">{counts.map((part) => <span key={part}>{part}</span>)}</div> : null}
              <div className="desk-zone-glance" role="status">
                {f.needsMatt.length
                  ? <span className="desk-glance needs"><Users size={12} /> {f.needsMatt.length} thing{f.needsMatt.length === 1 ? '' : 's'} need Matt</span>
                  : <span className="desk-glance calm">Nothing needs Matt</span>}
                {f.liveToday.length
                  ? <span className="desk-glance live"><Rocket size={12} /> {f.liveToday.length} went live today</span>
                  : null}
                {f.workingIds.size ? <span className="desk-glance moving"><Activity size={12} /> {f.workingIds.size} active now</span> : <span className="desk-glance calm">No recent turn activity</span>}
                {f.quietCount ? <span className="desk-glance quiet" title="Open turns with no process signal in over 2 minutes">{f.quietCount} awaiting updates</span> : null}
                {f.backgroundCount ? <span className="desk-glance">{f.backgroundCount} with background jobs</span> : null}
                {f.moving.length ? <span className="desk-glance">{f.moving.length} in-progress cards updated in 24h</span> : null}
                {f.stuck.length || f.overdue.length
                  ? <span className="desk-glance stuck"><AlertTriangle size={12} /> {[
                      f.stuck.length ? `${f.stuck.length} stuck ${STUCK_HOURS / 24}+ day${STUCK_HOURS / 24 === 1 ? '' : 's'}` : '',
                      f.overdue.length ? `${f.overdue.length} overdue` : '',
                    ].filter(Boolean).join(' · ')}</span>
                  : null}
              </div>
              {isOpen ? (
                <div className="desk-zone-detail">
                  <ZoneList
                    label="Needs Matt"
                    empty="Nothing needs Matt right now."
                    items={f.needsMatt.map((t) => {
                      const cid = t.cardId;
                      return { id: t.id, line: t.title, note: t.due && new Date(t.due).getTime() < Date.now() ? 'overdue' : undefined, onClick: cid ? () => onOpenCard(cid) : undefined };
                    })}
                  />
                  <ZoneList
                    label="Went live today"
                    empty="Nothing went live today."
                    items={f.liveToday.map((c) => ({ id: c.id, line: c.title, note: cardOwnerName(c), onClick: () => onOpenCard(c.id) }))}
                  />
                  <ZoneList
                    label="Recent in-progress updates"
                    empty="No in-progress cards updated in 24 hours."
                    items={f.moving.map((c) => ({ id: c.id, line: c.title, note: cardOwnerName(c), onClick: () => onOpenCard(c.id) }))}
                  />
                  <ZoneList
                    label="Staging needs an update"
                    empty="No stale staging cards."
                    items={f.staleStaging.map((c) => ({ id: c.id, line: c.title, note: `${cardOwnerName(c)} · ${agoText(c.updatedAt)}`, onClick: () => onOpenCard(c.id) }))}
                  />
                  <ZoneList
                    label="Stuck or late"
                    empty="Nothing stuck or late."
                    items={[
                      ...f.stuck.map((c) => ({ id: c.id, line: c.title, note: `${STAGE_WORDS[c.column]} · ${agoText(c.updatedAt)}`, onClick: () => onOpenCard(c.id) })),
                      ...f.overdue.filter((t) => !f.stuck.some((c) => c.id === t.cardId)).map((t) => {
                        const cid = t.cardId;
                        return { id: `todo-${t.id}`, line: t.title, note: 'needs Matt · overdue', onClick: cid ? () => onOpenCard(cid) : undefined };
                      }),
                    ]}
                  />
                </div>
              ) : null}
            </section>
          );
        })}
        {!teammates.isPending && !agents.length ? <div className="desk-zone-empty">{teammates.isError ? 'The teammate roster is unavailable. It refreshes automatically.' : 'No teammates have been added yet.'}</div> : null}
      </div>
      {selected ? createPortal(
        <div className="desk-person-overlay" onPointerDown={(event) => { backdropPressed.current = event.target === event.currentTarget; }} onClick={(event) => { if (backdropPressed.current && event.target === event.currentTarget) closeDetail(); }}>
          <div className="desk-person-dialog" id="desk-person-dialog" ref={detailRef} role="dialog" aria-modal="true" aria-labelledby="desk-person-title">
            <div className="desk-person-head">
              <div className="desk-person-identity">
                <span className="desk-person-avatar" style={{ background: agentColor(selected.name), color: DISC_INK }} aria-hidden="true">{agentAvatarUrl(selected) ? <img src={agentAvatarUrl(selected)!} alt="" /> : selected.name.slice(0, 1)}</span>
                <div><strong id="desk-person-title">{selected.name}</strong><span className="desk-person-subtitle">{selectedLine?.sections?.length ? `${selectedLine.sections.length} activity ${selectedLine.sections.length === 1 ? 'source' : 'sources'}` : 'Activity at a glance'}</span></div>
              </div>
              <button type="button" className="desk-team-board" onClick={() => closeDetail()}>Close</button>
            </div>
            <div className="desk-person-sections">
              {selectedLine?.sections?.length ? selectedLine.sections.map((section, index) => <section className={`desk-person-section is-${section.kind}`} key={`${section.title}-${index}`}><div className="desk-person-section-head"><strong>{section.title}</strong><span>{section.meta}</span></div><p className="desk-person-copy">{section.text}</p></section>) : <section className="desk-person-section"><div className="desk-person-section-head"><strong>{selectedLine ? 'Current task' : 'No current activity'}</strong>{selectedLine?.at ? <span>Updated {agoText(new Date(selectedLine.at).toISOString())}</span> : null}</div><p className="desk-person-copy">{selectedLine?.text ?? 'No live turn or recent card update.'}</p></section>}
            </div>
            {selectedLine?.cardId ? <button type="button" className="desk-team-board" onClick={() => { const id = selectedLine.cardId!; closeDetail(false); onOpenCard(id); }}>Open the card <ArrowRight size={12} /></button> : null}
            <button type="button" className="desk-team-board" onClick={() => { closeDetail(false); openAgentThread(selected.id); }}>Open {selected.name}'s thread <ArrowRight size={12} /></button>
          </div>
        </div>, document.body,
      ) : null}
      {traveling.size ? (
        <div className="desk-travel-note" role="status">
          {traveling.size} item{traveling.size === 1 ? '' : 's'} changed stage just now
        </div>
      ) : null}
    </div>
  );
}

function ZoneList({ label, empty, items }: { label: string; empty: string; items: Array<{ id: string; line: string; note?: string; onClick?: () => void }> }) {
  return (
    <div className="desk-zone-group">
      <div className="desk-zone-group-label">{label}</div>
      {items.length ? (
        items.map((it) => (
          <button
            key={it.id}
            type="button"
            className={`desk-zone-item${it.note === 'overdue' ? ' is-overdue' : ''}`}
            onClick={it.onClick}
            disabled={!it.onClick}
          >
            <span className="desk-zone-item-line">{it.line}</span>
            {it.note ? <span className="desk-zone-item-note">{it.note}</span> : null}
          </button>
        ))
      ) : (
        <div className="desk-zone-empty">{empty}</div>
      )}
    </div>
  );
}
