// Desk team view (card-292afa): each team is a live room — a row of teammate
// avatars showing what each person is on, working teammates pulsing — and the
// four things Matt most needs at a glance: needs him, went live today (moved
// into Live today, ET), moving right now, stuck or late. Plain English, one
// line per item; the big piles collapse to counts. Click a zone to open it;
// items visibly travel when their stage changes. The old column board stays
// one click away (DeskBoard).

import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, AlertTriangle, ArrowRight, GripVertical, LayoutGrid, Rocket, Users } from 'lucide-react';
import { useLive } from '../chat/hooks/useLive';
import { agoText, hoursSince, type DeskCard, type DeskSnapshot, type DeskTodo } from '../data/desk';
import { agentAvatarUrl, agentColor, chatColorOf, DISC_INK, type Agent } from '../grok/agents';
import './deskTeam.css';

type Props = { desk: DeskSnapshot; agents: Agent[]; onOpenCard: (id: string) => void; onShowBoard: () => void };

// The team zones, per Matt's brief. Leads render first; everyone else keeps
// roster order within the zone.
const TEAMS: Array<{ id: string; label: string; lead: string; members: string[] }> = [
  { id: 'rally', label: 'Rally', lead: 'Kip', members: ['Kip', 'Christina', 'Maria', 'Adam', 'Quinn', 'Wren'] },
  { id: 'game', label: 'Game Studio', lead: 'Riley', members: ['Riley', 'Tim', 'Piper', 'Felix'] },
  { id: 'max', label: "Max's Team", lead: 'Max', members: ['Max', 'Jill', 'Becca', 'Jessica', 'Kate', 'Naomi', 'Stephen', 'Samwise', 'Julia'] },
];

/** A card older than this in an active column reads as stuck. */
const STUCK_HOURS = 48;
/** "On now" only counts in-progress work touched this recently: a finished
 * card that was never moved on the board is not what someone is on (Max,
 * Oct 17: Christina kept showing the finished Sud packet). */
const ON_NOW_HOURS = 48;
/** "Moving now" looks back this far. */
const DAY_HOURS = 24;

const STAGE_WORDS: Record<string, string> = {
  not_started: 'parked',
  in_progress: 'in progress',
  on_staging: 'waiting on staging',
  in_qa: 'with Sud QA',
  in_production: 'live',
};

function cardOwnerName(card: DeskCard): string {
  return card.owner.kind === 'owner' ? 'Matt' : card.owner.name;
}

function todoTeamName(todo: DeskTodo, cardsById: Map<string, DeskCard>): string | null {
  if (todo.cardId) {
    const card = cardsById.get(todo.cardId);
    if (card) return cardOwnerName(card);
  }
  return todo.from.kind === 'agent' ? todo.from.name : null;
}

/** Same calendar day in Eastern Time — "went live today" is today, ET, not a
 *  rolling 24 hours (Max, Oct 17: Friday's ships must not show as live today
 *  on Saturday morning). */
function isTodayEt(iso: string): boolean {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
  return fmt.format(new Date(iso)) === fmt.format(new Date());
}

type ZoneFacts = {
  team: (typeof TEAMS)[number];
  needsMatt: DeskTodo[];
  liveToday: DeskCard[];
  moving: DeskCard[];
  workingNames: Set<string>;
  stuck: DeskCard[];
  overdue: DeskTodo[];
  parkedCount: number;
  stagingCount: number;
  /** What each teammate is on: their newest in-progress card title. */
  onNow: Map<string, string>;
};

export function DeskTeamView({ desk, agents, onOpenCard, onShowBoard }: Props) {
  const [openZone, setOpenZone] = useState<string | null>(null);
  const [order, setOrder] = useState<string[]>(() => TEAMS.map((t) => t.id));
  const [dragZone, setDragZone] = useState<string | null>(null);
  const live = useLive();

  const agentsByHome = useMemo(() => {
    const m = new Map<string, Agent>();
    for (const a of agents) m.set(a.home, a);
    return m;
  }, [agents]);
  const agentsByName = useMemo(() => {
    const m = new Map<string, Agent>();
    for (const a of agents) m.set(a.name, a);
    return m;
  }, [agents]);

  const cardsById = useMemo(() => new Map(desk.cards.map((c) => [c.id, c])), [desk]);
  const memberSet = useMemo(() => new Set(TEAMS.flatMap((t) => t.members)), []);

  // Working right now: live sessions mid-turn, mapped to teammate names
  // through the roster. Background lanes carry __bg (and account aliases
  // carry __acct__) — strip both, then match the agent home or name (Max,
  // Oct 17: Quinn alone showed while Kip, Christina, Maria, Adam and Wren
  // were all mid-turn on their background lanes).
  const workingNames = useMemo(() => {
    const names = new Set<string>();
    for (const s of live) {
      if (!s.busy) continue;
      const base = s.chatId.replace(/__acct__.*$/, '').replace(/__bg$/, '');
      const agent = agentsByHome.get(base) ?? agentsByHome.get(s.chatId) ?? agentsByName.get(base.replace(/^bot-/, ''));
      const name = agent?.name ?? base.replace(/^bot-/, '');
      if (memberSet.has(name)) names.add(name);
    }
    return names;
  }, [live, agentsByHome, agentsByName, memberSet]);

  const facts = useMemo<ZoneFacts[]>(() => {
    return TEAMS.map((team) => {
      const inTeam = (name: string) => team.members.includes(name) || name === team.lead;
      const cards = desk.cards.filter((c) => !c.archived && inTeam(cardOwnerName(c)));
      const needsMatt = desk.todos.filter((t) => t.status === 'open' && inTeam(todoTeamName(t, cardsById) ?? ''));
      const liveToday = cards.filter((c) => c.column === 'in_production' && isTodayEt(c.columnSince ?? c.createdAt));
      const moving = cards.filter((c) => c.column === 'in_progress' && hoursSince(c.updatedAt) <= DAY_HOURS);
      const stuck = cards.filter((c) => ['in_progress', 'in_qa'].includes(c.column) && hoursSince(c.updatedAt) > STUCK_HOURS);
      const overdue = needsMatt.filter((t) => t.due && new Date(t.due).getTime() < Date.now());
      const onNow = new Map<string, string>();
      for (const name of team.members) {
        const mine = cards
          .filter((c) => c.column === 'in_progress' && cardOwnerName(c) === name && hoursSince(c.updatedAt) <= ON_NOW_HOURS)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        if (mine[0]) onNow.set(name, mine[0].title);
      }
      return {
        team,
        needsMatt,
        liveToday,
        moving,
        workingNames: new Set(team.members.filter((m) => workingNames.has(m))),
        stuck,
        overdue,
        parkedCount: cards.filter((c) => c.column === 'not_started').length,
        stagingCount: cards.filter((c) => c.column === 'on_staging').length,
        onNow,
      };
    });
  }, [desk, cardsById, workingNames]);

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

  const orderedFacts = order.map((id) => facts.find((f) => f.team.id === id)).filter((f): f is ZoneFacts => Boolean(f));

  const onDrop = (targetId: string) => {
    if (!dragZone || dragZone === targetId) return;
    setOrder((cur) => {
      const next = cur.filter((id) => id !== dragZone);
      next.splice(next.indexOf(targetId), 0, dragZone);
      return next;
    });
    setDragZone(null);
  };

  return (
    <div className="desk-team">
      <div className="desk-team-head">
        <span className="desk-team-title">One glance per team</span>
        <button type="button" className="desk-team-board" onClick={onShowBoard} title="Open the column board">
          <LayoutGrid size={13} /> Column board
        </button>
      </div>
      <div className="desk-team-zones">
        {orderedFacts.map((f) => {
          const isOpen = openZone === f.team.id;
          const attention = f.needsMatt.length + f.stuck.length + f.overdue.length;
          const counts = [
            f.parkedCount ? `${f.parkedCount} parked` : '',
            f.stagingCount ? `${f.stagingCount} on staging` : '',
          ].filter(Boolean).join(' · ');
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
                <span className="desk-zone-lead">{f.team.lead}'s team</span>
                {counts ? <span className="desk-zone-counts" aria-hidden="true">{counts}</span> : null}
                <ArrowRight size={14} className={`desk-zone-chevron${isOpen ? ' turned' : ''}`} aria-hidden="true" />
              </button>
              <div className="desk-zone-room" aria-label="Who is here and what they are on">
                {f.team.members.map((name) => {
                  const agent = agentsByName.get(name);
                  const working = f.workingNames.has(name);
                  const on = f.onNow.get(name);
                  const color = agentColor(name);
                  const chatColor = chatColorOf(agent);
                  const avatarUrl = agent ? agentAvatarUrl(agent) : null;
                  return (
                    <div
                      key={name}
                      className={`desk-avatar-tile${working ? ' working' : ''}${on ? ' has-on' : ''}`}
                      title={on ? `${name} — ${on}` : working ? `${name} is working right now` : name}
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
                      {on ? <span className="desk-avatar-on">{on}</span> : <span className="desk-avatar-on is-quiet">nothing in progress</span>}
                    </div>
                  );
                })}
              </div>
              <div className="desk-zone-glance" role="status">
                {f.needsMatt.length
                  ? <span className="desk-glance needs"><Users size={12} /> {f.needsMatt.length} thing{f.needsMatt.length === 1 ? '' : 's'} need Matt</span>
                  : <span className="desk-glance calm">Nothing needs Matt</span>}
                {f.liveToday.length
                  ? <span className="desk-glance live"><Rocket size={12} /> {f.liveToday.length} went live today</span>
                  : null}
                {f.moving.length || f.workingNames.size
                  ? <span className="desk-glance moving"><Activity size={12} /> {f.moving.length} moving{f.workingNames.size ? ` · ${[...f.workingNames].join(', ')} working` : ''}</span>
                  : <span className="desk-glance calm">Quiet right now</span>}
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
                    label="Moving now"
                    empty={f.workingNames.size ? `${[...f.workingNames].join(', ')} working, no cards moved today.` : 'Nothing moving right now.'}
                    items={f.moving.map((c) => ({ id: c.id, line: c.title, note: cardOwnerName(c), onClick: () => onOpenCard(c.id) }))}
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
      </div>
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
