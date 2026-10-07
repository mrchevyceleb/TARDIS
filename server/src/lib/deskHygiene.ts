// Desk card hygiene: deterministic nudges, no model in the loop.
//
// Every minute the scheduler notes which agents have a live turn (routine and
// job wakes excluded where the lane can tell) and adds a minute to that
// agent's tally for the current Eastern day. At 08:00, 10:00, 12:00, 14:00
// and 16:00 America/New_York, every day, each agent gets at most ONE message
// in its own thread listing its stale cards (In progress with no activity for
// 6 hours, or Waiting with no open Needs-you item behind it) and, when it has
// worked 30+ minutes today while owning no In progress card, a nudge to card
// that work. The 10:00 slot also reviews that agent's Pipeline cards with no
// activity for 3+ days. Outside the slots, an agent whose lane has been quiet
// for 20+ minutes while it owns Up next work gets one idle pickup message an
// hour, any hour, pointing at its top Up next card. Silent when nothing
// qualifies. The human owner is never messaged, and cards they own are never
// listed.
//
// RIVENDELL_DESK_HYGIENE=off disables it; RIVENDELL_DESK_HYGIENE_DRY_RUN=1
// logs the would-be messages instead of delivering. State lives in
// ~/.rivendell/desk-hygiene.json (RIVENDELL_DESK_HYGIENE_FILE overrides).

import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DESK_OWNER_NAME, DESK_ROOM_ENABLED, STATE_DIR } from '../config.ts';
import { readDesk, type DeskCard, type DeskData } from './deskStore.ts';
import { bareChatId } from '../chat/threadKey.ts';

const TICK_MS = 60_000;
const FIRST_TICK_MS = 15_000;
const TIME_ZONE = 'America/New_York';
const SLOT_HOURS = [8, 10, 12, 14, 16] as const;
/** A slot still fires this long after its time (restart catch-up). */
const SLOT_WINDOW_MIN = 20;
/** Queued checks for a slot are dropped after this; the next slot re-checks. */
const PENDING_TTL_MS = 60 * 60_000;
const IN_PROGRESS_STALE_MS = 6 * 60 * 60_000;
const NO_CARD_MINUTES = 30;
/** Pipeline cards with no activity this long are reviewed in the 10:00 slot. */
const PIPELINE_STALE_MS = 3 * 24 * 60 * 60_000;
/** The one daily slot that carries the Pipeline review. */
const PIPELINE_SLOT_HOUR = 10;
/** A lane this quiet while its agent owns Up next work is idle. */
const IDLE_QUIET_MS = 20 * 60_000;
/** At most one idle pickup per agent per hour. */
const IDLE_RESEND_MS = 60 * 60_000;
const MAX_LINES = 10;
/** Deliveries per tick, so one slot never eats the team's shared per-minute
 *  handoff budget (teamBus allows 20 a minute across everyone). */
const MAX_SENDS_PER_TICK = 4;
const TITLE_MAX = 80;

const STALE_HEAD = 'These Desk cards look stale. Move or update each one now (board_card_move / board_card_comment), or tell me why not.\nParking in Pipeline is not a way to clear this list.';

const PIPELINE_HEAD = 'Pipeline is only for work blocked outside the team or parked by Matt. For each card: restart it (Up next), finish it (Done: shipped is Done, owed proof is not a reason to keep a card open), hand it to whoever has the ball (board_card_update owner), or close it as Done if it\'s a duplicate or dead. Re-parking needs a new reason and what restarts it.';

const IDLE_GUIDANCE = 'You\'re idle with Up next work. Start this now. If you\'re waiting on a job or another lane, start it in parallel. If it\'s truly blocked, move it to Pipeline with what restarts it.';

export type HygieneAgent = { id: string; name: string; home: string };
export type HygieneDelivery = { delivered: boolean; reason?: string };

export type HygieneDeps = {
  now: () => number;
  readDesk: () => Promise<DeskData>;
  listAgents: () => HygieneAgent[] | Promise<HygieneAgent[]>;
  /** Ids of agents with a live turn right now (routine and job wakes left out
   *  where the lane can tell them apart). */
  liveAgentIds: (agents: HygieneAgent[]) => Set<string> | Promise<Set<string>>;
  /** agent id -> epoch ms that lane was last known active: busy sessions
   *  report nowMs, automation wakes included (a lane mid-turn is not idle),
   *  and a session that went quiet between ticks still reports its last
   *  activity, so a short turn is never mistaken for idle time. Optional:
   *  falls back to liveAgentIds, treated as busy now. */
  occupiedAgentActivity?: (agents: HygieneAgent[], nowMs: number) => Map<string, number> | Promise<Map<string, number>>;
  deliver: (message: { to: string; text: string }) => Promise<HygieneDelivery>;
  log: (line: string) => void;
  stateFile: string;
  dryRun: boolean;
  ownerName: string;
};

type HygieneState = {
  version: 1;
  /** Eastern YYYY-MM-DD the minute tallies belong to. */
  day: string;
  /** agent id -> minutes with a live turn today. */
  minutes: Record<string, number>;
  /** Slot keys ("YYYY-MM-DD HH:00") already handled today, sent or not. */
  fired: string[];
  /** Agents still to check for the latest slot (deliveries are paced). */
  pending: { slot: string; at: number; agents: string[] } | null;
  /** agent id -> epoch ms it was last seen busy (any turn, automation included). */
  lastBusy: Record<string, number>;
  /** agent id -> epoch ms of its last idle pickup message. */
  lastIdleNudge: Record<string, number>;
};

const OFF_VALUES = new Set(['off', '0', 'false', 'no']);
const ON_VALUES = new Set(['1', 'true', 'yes', 'on']);

export function hygieneEnabled(): boolean {
  return !OFF_VALUES.has((process.env.RIVENDELL_DESK_HYGIENE ?? '').trim().toLowerCase());
}

function hygieneDryRun(): boolean {
  return ON_VALUES.has((process.env.RIVENDELL_DESK_HYGIENE_DRY_RUN ?? '').trim().toLowerCase());
}

function hygieneStateFile(): string {
  return process.env.RIVENDELL_DESK_HYGIENE_FILE?.trim() || join(STATE_DIR, 'desk-hygiene.json');
}

// ---- Eastern clock and slots ----------------------------------------------------

const etFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Eastern calendar day and minute of the day for an instant. */
export function etClock(ms: number): { day: string; minute: number } {
  const parts: Record<string, string> = {};
  for (const part of etFormat.formatToParts(new Date(ms))) parts[part.type] = part.value;
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minute: (Number(parts.hour) % 24) * 60 + Number(parts.minute) };
}

function slotKey(day: string, hour: number): string {
  return `${day} ${String(hour).padStart(2, '0')}:00`;
}

/** Hour of a slot key ("YYYY-MM-DD HH:00"), or -1 when unreadable. */
function slotHourOf(slot: string): number {
  const hour = Number(slot.slice(-5, -3));
  return Number.isInteger(hour) ? hour : -1;
}

/** The slot whose catch-up window contains this minute, if any. */
function dueSlot(clock: { day: string; minute: number }): string | null {
  for (const hour of SLOT_HOURS) {
    const start = hour * 60;
    if (clock.minute >= start && clock.minute < start + SLOT_WINDOW_MIN) return slotKey(clock.day, hour);
  }
  return null;
}

// ---- findings -------------------------------------------------------------------

/** Newest of the card's own update, its column move, and its latest comment. */
function lastActivityMs(card: DeskCard): number {
  let latest = -Infinity;
  for (const iso of [card.updatedAt, card.columnSince, card.createdAt, ...card.comments.map((c) => c.at)]) {
    const ts = Date.parse(iso);
    if (Number.isFinite(ts) && ts > latest) latest = ts;
  }
  return latest;
}

function ownedBy(card: DeskCard, agent: HygieneAgent): boolean {
  if (card.owner.kind !== 'agent') return false;
  return card.owner.id === agent.id || card.owner.name.trim().toLowerCase() === agent.name.trim().toLowerCase();
}

type StaleLine = { card: DeskCard; kind: 'in_progress' | 'waiting'; lastMs: number };
type PipelineLine = { card: DeskCard; lastMs: number };
type Finding = { stale: StaleLine[]; noCardMinutes: number | null; pipeline: PipelineLine[] };

function findingFor(
  agent: HygieneAgent,
  desk: DeskData,
  minutes: number,
  nowMs: number,
  opts: { pipelineReview?: boolean } = {},
): Finding | null {
  const own = desk.cards.filter((c) => !c.archived && ownedBy(c, agent));
  const backed = new Set(desk.todos.filter((t) => t.status === 'open' && t.cardId).map((t) => t.cardId));
  const inProgress = own.filter((c) => c.column === 'in_progress');
  const stale: StaleLine[] = [
    ...inProgress
      .map((card) => ({ card, kind: 'in_progress' as const, lastMs: lastActivityMs(card) }))
      .filter((line) => Number.isFinite(line.lastMs) && nowMs - line.lastMs >= IN_PROGRESS_STALE_MS)
      .sort((a, b) => a.lastMs - b.lastMs),
    ...own
      .filter((c) => c.column === 'waiting' && !backed.has(c.id))
      .map((card) => ({ card, kind: 'waiting' as const, lastMs: lastActivityMs(card) }))
      .filter((line) => Number.isFinite(line.lastMs))
      .sort((a, b) => a.lastMs - b.lastMs),
  ];
  const pipeline: PipelineLine[] = opts.pipelineReview
    ? own
        .filter((c) => c.column === 'pipeline')
        .map((card) => ({ card, lastMs: lastActivityMs(card) }))
        .filter((line) => Number.isFinite(line.lastMs) && nowMs - line.lastMs >= PIPELINE_STALE_MS)
        .sort((a, b) => a.lastMs - b.lastMs)
    : [];
  const noCardMinutes = minutes >= NO_CARD_MINUTES && inProgress.length === 0 ? minutes : null;
  return stale.length || pipeline.length || noCardMinutes !== null ? { stale, noCardMinutes, pipeline } : null;
}

function ageText(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes >= 24 * 60) return `${Math.floor(minutes / 1440)}d`;
  return `${Math.floor(minutes / 60)}h`;
}

/** One line, straight quotes and no dashes that read as em dashes. */
function cleanTitle(title: string): string {
  const flat = title.replace(/\s+/g, ' ').replace(/[\u2013\u2014]/g, '-').replace(/"/g, "'").trim();
  return flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX - 3).trimEnd()}...` : flat;
}

function composeMessage(finding: Finding, ownerName: string, nowMs: number): string {
  const blocks: string[] = [];
  if (finding.stale.length) {
    const lines = finding.stale.slice(0, MAX_LINES).map(({ card, kind, lastMs }) => {
      const why = kind === 'in_progress'
        ? `In progress, last update ${ageText(nowMs - lastMs)} ago`
        : `Waiting on ${ownerName} but no open Needs-you item`;
      return `[desk:${card.id}] "${cleanTitle(card.title)}" (${why})`;
    });
    if (finding.stale.length > MAX_LINES) lines.push(`+${finding.stale.length - MAX_LINES} more`);
    blocks.push([STALE_HEAD, ...lines].join('\n'));
  }
  if (finding.pipeline.length) {
    const lines = finding.pipeline.slice(0, MAX_LINES).map(({ card, lastMs }) =>
      `[desk:${card.id}] "${cleanTitle(card.title)}" (no activity for ${ageText(nowMs - lastMs)})`);
    if (finding.pipeline.length > MAX_LINES) lines.push(`+${finding.pipeline.length - MAX_LINES} more`);
    blocks.push([PIPELINE_HEAD, ...lines].join('\n'));
  }
  if (finding.noCardMinutes !== null) {
    blocks.push(`You have had live turns for ${finding.noCardMinutes} minutes today and own no In progress card. If any of that was task work, create or reuse a card (board_cards first) so the Desk shows what you are on. If it was only conversation, no card is needed.`);
  }
  return blocks.join('\n\n');
}

// ---- state ----------------------------------------------------------------------

function parseState(raw: string): HygieneState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.day !== 'string' || !Array.isArray(obj.fired) || !obj.minutes || typeof obj.minutes !== 'object') return null;
  const minutes: Record<string, number> = {};
  for (const [id, value] of Object.entries(obj.minutes as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) minutes[id] = Math.floor(value);
  }
  const rawPending = obj.pending as Record<string, unknown> | null | undefined;
  const pending = rawPending && typeof rawPending.slot === 'string' && typeof rawPending.at === 'number' && Array.isArray(rawPending.agents)
    ? { slot: rawPending.slot, at: rawPending.at, agents: rawPending.agents.filter((a): a is string => typeof a === 'string') }
    : null;
  const epochMap = (value: unknown): Record<string, number> => {
    const out: Record<string, number> = {};
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [id, ms] of Object.entries(value as Record<string, unknown>)) {
        if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) out[id] = ms;
      }
    }
    return out;
  };
  return {
    version: 1,
    day: obj.day,
    minutes,
    fired: obj.fired.filter((s): s is string => typeof s === 'string'),
    pending,
    lastBusy: epochMap(obj.lastBusy),
    lastIdleNudge: epochMap(obj.lastIdleNudge),
  };
}

async function loadState(file: string, log: (line: string) => void): Promise<HygieneState | null> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const state = parseState(raw);
  if (!state) log(`[desk-hygiene] state file was unreadable; starting it fresh (${file})`);
  return state;
}

async function saveState(file: string, state: HygieneState): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const handle = await open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close().catch(() => {});
  }
  try {
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/** First run: every slot already past today counts as handled, so a start at
 *  3pm does not fire a pile of catch-up nudges. The next slot fires normally. */
function seedState(clock: { day: string; minute: number }): HygieneState {
  return {
    version: 1,
    day: clock.day,
    minutes: {},
    fired: SLOT_HOURS.filter((hour) => hour * 60 <= clock.minute).map((hour) => slotKey(clock.day, hour)),
    pending: null,
    lastBusy: {},
    lastIdleNudge: {},
  };
}

// ---- tick -----------------------------------------------------------------------

/** Last-known activity per lane. Busy sessions count as active now (any
 *  turn, automation wakes included: a lane mid-turn is not idle), and a
 *  session that went quiet between two minute ticks still reports its last
 *  activity, so a short turn never reads as idle time. */
async function occupiedAgentActivityFromRunners(agents: HygieneAgent[], nowMs: number): Promise<Map<string, number>> {
  const runner = await import('../chat/runner.ts');
  const byHome = new Map(agents.map((a) => [a.home, a.id]));
  const out = new Map<string, number>();
  for (const session of runner.activeChatSessions()) {
    const id = byHome.get(bareChatId(session.chatId));
    if (!id) continue;
    const ms = session.busy ? nowMs : session.lastActivityAt;
    if (!Number.isFinite(ms)) continue;
    const prev = out.get(id);
    if (prev === undefined || ms > prev) out.set(id, ms);
  }
  return out;
}

async function liveAgentIdsFromRunners(agents: HygieneAgent[]): Promise<Set<string>> {
  const runner = await import('../chat/runner.ts');
  const byHome = new Map(agents.map((a) => [a.home, a.id]));
  const out = new Set<string>();
  for (const session of runner.activeChatSessions()) {
    if (!session.busy) continue;
    const id = byHome.get(bareChatId(session.chatId));
    if (!id || out.has(id)) continue;
    // Claude-family and Pi lanes know a routine or job wake started the turn.
    // Codex and Grok lanes do not, so their busy time all counts.
    const lane = runner.liveLaneSession(runner.laneLogKey(session.cli, session.cwd, session.chatId));
    if (lane && lane.cli === session.cli && lane.isAutomationTurn()) continue;
    out.add(id);
  }
  return out;
}

function defaultDeps(): HygieneDeps {
  return {
    now: () => Date.now(),
    readDesk,
    listAgents: async () => (await import('../chat/agents.ts')).listAgents(),
    liveAgentIds: liveAgentIdsFromRunners,
    occupiedAgentActivity: occupiedAgentActivityFromRunners,
    deliver: async ({ to, text }) => {
      const { deliverTeamMessage } = await import('../chat/teamBus.ts');
      // A plain named sender (never source 'desk', which is the human owner):
      // it lands as a teammate handoff, so it waits out the 60s handoff
      // hold-off and does not arm the reply-first nudge.
      return deliverTeamMessage({ from: 'Desk', to, text, wait: false });
    },
    log: (line) => console.log(line),
    stateFile: hygieneStateFile(),
    dryRun: hygieneDryRun(),
    ownerName: DESK_OWNER_NAME,
  };
}

export type HygieneTickReport = { skipped?: 'off'; seeded?: boolean; slot?: string; sent: string[]; checked: string[] };

/** One scheduler step. Tests and the proof harness pass their own deps. */
export async function runDeskHygieneTick(overrides: Partial<HygieneDeps> = {}): Promise<HygieneTickReport> {
  const report: HygieneTickReport = { sent: [], checked: [] };
  if (!hygieneEnabled()) return { ...report, skipped: 'off' };
  const defaults = defaultDeps();
  const deps: HygieneDeps = {
    ...defaults,
    ...overrides,
    // A caller that stubs liveAgentIds but not occupiedAgentActivity must
    // not fall through to the real runner scan: its live set stands in for
    // the lanes. Production (no overrides) keeps the real activity scan.
    occupiedAgentActivity: overrides.occupiedAgentActivity
      ?? (overrides.liveAgentIds
        ? (agents, nowMs) => Promise.resolve(overrides.liveAgentIds!(agents))
          .then((ids) => new Map(Array.from(ids, (id) => [id, nowMs] as const)))
        : defaults.occupiedAgentActivity),
  };
  const nowMs = deps.now();
  const clock = etClock(nowMs);
  const save = (state: HygieneState) => saveState(deps.stateFile, state);

  let state = await loadState(deps.stateFile, deps.log);
  let dirty = false;
  if (!state) {
    state = seedState(clock);
    dirty = true;
    report.seeded = true;
    deps.log(`[desk-hygiene] first run: ${state.fired.length} earlier slot(s) today marked handled`);
  }
  if (state.day !== clock.day) {
    state.day = clock.day;
    state.minutes = {};
    dirty = true;
  }
  const today = `${clock.day} `;
  if (state.fired.some((key) => !key.startsWith(today))) {
    state.fired = state.fired.filter((key) => key.startsWith(today));
    dirty = true;
  }

  // Never the owner (should one ever appear in the roster), and never an agent
  // the operator listed in RIVENDELL_DESK_HYGIENE_SKIP (comma-separated ids,
  // for lanes that only run routines or conversation).
  const skip = new Set((process.env.RIVENDELL_DESK_HYGIENE_SKIP ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
  const owner = DESK_OWNER_NAME.trim().toLowerCase();
  const agents = (await deps.listAgents()).filter((a) => a.id !== 'owner' && a.name.trim().toLowerCase() !== owner && !skip.has(a.id.toLowerCase()));
  const known = new Set(agents.map((a) => a.id));
  for (const id of await deps.liveAgentIds(agents)) {
    if (!known.has(id)) continue;
    state.minutes[id] = (state.minutes[id] ?? 0) + 1;
    dirty = true;
  }
  const activity = deps.occupiedAgentActivity
    ? await deps.occupiedAgentActivity(agents, nowMs)
    : new Map(Array.from(await deps.liveAgentIds(agents), (id) => [id, nowMs] as const));
  for (const [id, ms] of activity) {
    if (!known.has(id) || !Number.isFinite(ms)) continue;
    const last = Math.min(ms, nowMs); // a future stamp can never extend the clock
    if ((state.lastBusy[id] ?? -1) < last) {
      state.lastBusy[id] = last;
      dirty = true;
    }
  }
  // A lane first seen now (new roster entry, or a state file from before
  // this field existed) starts its quiet clock at this tick, so a restart
  // never bursts pickup messages. Implausible clocks (zero, or in the
  // future) reset the same way: always the quiet direction.
  for (const agent of agents) {
    const busy = state.lastBusy[agent.id];
    if (busy === undefined || busy <= 0 || busy > nowMs) {
      state.lastBusy[agent.id] = nowMs;
      dirty = true;
    }
    const nudged = state.lastIdleNudge[agent.id];
    if (nudged !== undefined && nudged > nowMs) {
      state.lastIdleNudge[agent.id] = 0;
      dirty = true;
    }
  }

  const slot = dueSlot(clock);
  if (slot && !state.fired.includes(slot)) {
    state.fired.push(slot);
    state.pending = { slot, at: nowMs, agents: agents.map((a) => a.id) };
    dirty = true;
    report.slot = slot;
    deps.log(`[desk-hygiene] slot ${slot} ET: checking ${agents.length} agent(s)`);
  }
  if (state.pending && nowMs - state.pending.at > PENDING_TTL_MS) {
    deps.log(`[desk-hygiene] slot ${state.pending.slot} ET: dropped ${state.pending.agents.length} unchecked agent(s)`);
    state.pending = null;
    dirty = true;
  }

  if (state.pending?.agents.length) {
    const pending = state.pending;
    const desk = await deps.readDesk();
    const pipelineReview = slotHourOf(pending.slot) === PIPELINE_SLOT_HOUR;
    let sends = 0;
    while (pending.agents.length && sends < MAX_SENDS_PER_TICK) {
      const id = pending.agents[0];
      const agent = agents.find((a) => a.id === id);
      const finding = agent ? findingFor(agent, desk, state.minutes[id] ?? 0, nowMs, { pipelineReview }) : null;
      pending.agents.shift();
      dirty = true;
      report.checked.push(id);
      if (!agent || !finding) continue;
      const text = composeMessage(finding, deps.ownerName, nowMs);
      const counts = `stale=${finding.stale.filter((s) => s.kind === 'in_progress').length} waiting=${finding.stale.filter((s) => s.kind === 'waiting').length} minutes=${state.minutes[id] ?? 0} nocard=${finding.noCardMinutes !== null ? 'yes' : 'no'}${pipelineReview ? ` pipeline=${finding.pipeline.length}` : ''}`;
      const cards = [...finding.stale, ...finding.pipeline].map((s) => s.card.id).join(',') || '-';
      sends += 1;
      if (deps.dryRun) {
        deps.log(`[desk-hygiene] dry run, would message ${agent.id} (${counts} cards=${cards}):\n${text}`);
        report.sent.push(id);
        continue;
      }
      // At most once: the agent leaves the queue on disk before the send, so a
      // crash mid-delivery can drop a nudge but never repeat one.
      await save(state);
      dirty = false;
      let result: HygieneDelivery;
      try {
        result = await deps.deliver({ to: agent.id, text });
      } catch (error) {
        result = { delivered: false, reason: (error as Error).message };
      }
      if (result.delivered) {
        report.sent.push(id);
        deps.log(`[desk-hygiene] ${agent.id}: ${counts} cards=${cards} sent`);
      } else if (/rate limit/i.test(result.reason ?? '')) {
        pending.agents.unshift(id);
        report.checked.pop();
        dirty = true;
        deps.log(`[desk-hygiene] ${agent.id}: rate limited, retrying next tick`);
        break;
      } else {
        deps.log(`[desk-hygiene] ${agent.id}: ${counts} cards=${cards} not delivered (${result.reason ?? 'unknown reason'})`);
      }
    }
    if (!pending.agents.length) {
      state.pending = null;
      dirty = true;
    }
  }

  // Idle pickup, any hour: one message an hour to an agent whose lane has
  // been quiet for 20+ minutes while it owns Up next work. Skipped while a
  // slot sweep is still delivering, so an agent never gets two Desk messages
  // in the same minute.
  if (!state.pending?.agents.length) {
    const due = agents.filter((a) =>
      nowMs - (state.lastBusy[a.id] ?? nowMs) >= IDLE_QUIET_MS
      && nowMs - (state.lastIdleNudge[a.id] ?? 0) >= IDLE_RESEND_MS);
    if (due.length) {
      const desk = await deps.readDesk();
      let sends = 0;
      for (const agent of due) {
        if (sends >= MAX_SENDS_PER_TICK) break;
        // An agent the slot sweep touched this tick already had its one
        // message (or its clean check); its pickup waits for the next tick.
        if (report.checked.includes(agent.id)) continue;
        // First card in the Up next column is the board's top card.
        const top = desk.cards.find((c) => !c.archived && c.column === 'up_next' && ownedBy(c, agent));
        if (!top) continue;
        const text = `[desk:${top.id}] "${cleanTitle(top.title)}"\n${IDLE_GUIDANCE}`;
        state.lastIdleNudge[agent.id] = nowMs;
        dirty = true;
        sends += 1;
        if (deps.dryRun) {
          deps.log(`[desk-hygiene] dry run, would idle-message ${agent.id} (up_next=${top.id}):\n${text}`);
          report.sent.push(agent.id);
          continue;
        }
        // At most once: the nudge time is on disk before the send, so a crash
        // mid-delivery can drop a nudge but never repeat one.
        await save(state);
        dirty = false;
        let result: HygieneDelivery;
        try {
          result = await deps.deliver({ to: agent.id, text });
        } catch (error) {
          result = { delivered: false, reason: (error as Error).message };
        }
        if (result.delivered) {
          report.sent.push(agent.id);
          deps.log(`[desk-hygiene] ${agent.id}: idle up_next=${top.id} sent`);
        } else if (/rate limit/i.test(result.reason ?? '')) {
          state.lastIdleNudge[agent.id] = 0;
          dirty = true;
          deps.log(`[desk-hygiene] ${agent.id}: idle rate limited, retrying next tick`);
          break;
        } else {
          deps.log(`[desk-hygiene] ${agent.id}: idle up_next=${top.id} not delivered (${result.reason ?? 'unknown reason'})`);
        }
      }
    }
  }

  if (dirty) await save(state);
  return report;
}

// ---- scheduler ------------------------------------------------------------------

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

export function startDeskHygieneScheduler(): boolean {
  if (timer) return true;
  if (!hygieneEnabled()) {
    console.log('[desk-hygiene] off (RIVENDELL_DESK_HYGIENE=off)');
    return false;
  }
  if (!DESK_ROOM_ENABLED) {
    console.log('[desk-hygiene] off (the Desk room is off)');
    return false;
  }
  const run = () => {
    if (inFlight) return;
    inFlight = true;
    void runDeskHygieneTick()
      .catch((error) => console.warn(`[desk-hygiene] tick failed: ${(error as Error).message}`))
      .finally(() => { inFlight = false; });
  };
  timer = setInterval(run, TICK_MS);
  timer.unref();
  // A restart just inside a slot window should not wait a full minute.
  setTimeout(run, FIRST_TICK_MS).unref();
  if (hygieneDryRun()) console.log('[desk-hygiene] dry run: nudges are logged, not delivered');
  return true;
}
