// /api/desk: the owner's "Needs you" list and the board of agent work.
// Backs the Desk room and the desk_* / board_* tools in the team MCP.
// Callers identify an agent author with `agent` (name or id); no `agent`
// means the owner is acting from the UI.

import { Router, type NextFunction, type Request, type Response } from 'express';
import { listAgents, type Agent } from '../chat/agents.ts';
import { deliverTeamMessage } from '../chat/teamBus.ts';
import { DESK_OWNER_NAME } from '../config.ts';
import { isQuietHours, notifyTodoTouched } from '../lib/deskNotify.ts';
import {
  DESK_COLUMNS,
  DeskError,
  answerTodo,
  archiveCard,
  claimAnswerDelivery,
  commentCard,
  createCard,
  createTodo,
  deleteComment,
  deleteTodo,
  moveCard,
  parseColumn,
  readDesk,
  setAnswerDelivery,
  setTodoStatus,
  updateCard,
  updateTodo,
  type DeskActor,
  type DeskCard,
  type DeskComment,
  type DeskTodo,
} from '../lib/deskStore.ts';

export const deskRouter = Router();

const COLUMN_META = DESK_COLUMNS.map((key) => ({
  key,
  title: {
    not_started: 'Not started',
    in_progress: 'In progress',
    in_qa: 'In QA (Sud)',
    on_staging: 'Merged to staging',
    in_production: 'Live in production',
  }[key],
}));

const OWNER_ALIASES = new Set(['owner', 'user', 'human', 'you', DESK_OWNER_NAME.toLowerCase()]);

function ownerActor(): DeskActor {
  return { kind: 'owner', id: 'owner', name: DESK_OWNER_NAME };
}

function findAgent(value: string) {
  const needle = value.trim().toLowerCase();
  if (!needle) return undefined;
  const agents = listAgents();
  return agents.find((a) => a.id.toLowerCase() === needle)
    ?? agents.find((a) => a.name.trim().toLowerCase() === needle);
}

/** Who wrote this. Lenient: an unknown agent name still gets credit so a
 *  lane with a stale roster never loses its note. */
function resolveAuthor(value: unknown): DeskActor {
  const raw = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
  if (!raw) return ownerActor();
  const agent = findAgent(raw);
  if (agent) return { kind: 'agent', id: agent.id, name: agent.name };
  if (OWNER_ALIASES.has(raw.toLowerCase())) return ownerActor();
  return { kind: 'agent', id: raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent', name: raw };
}

/** Who a card belongs to. Strict: a typo must not invent a ghost owner. */
function resolveOwner(value: unknown, fallback?: DeskActor): DeskActor | undefined {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') throw new DeskError(400, 'owner must be a teammate name or id');
  const raw = value.trim();
  const agent = findAgent(raw);
  if (agent) return { kind: 'agent', id: agent.id, name: agent.name };
  if (OWNER_ALIASES.has(raw.toLowerCase())) return ownerActor();
  throw new DeskError(400, `Unknown owner ${JSON.stringify(raw)}. Use a teammate name or ${JSON.stringify(DESK_OWNER_NAME)}.`);
}

function matchesActor(actor: DeskActor, needle: string): boolean {
  const n = needle.trim().toLowerCase();
  if (!n) return true;
  if (actor.kind === 'owner') return OWNER_ALIASES.has(n);
  return actor.id.toLowerCase() === n || actor.name.toLowerCase() === n;
}

function route(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch((error: unknown) => {
      if (error instanceof DeskError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      next(error);
    });
  };
}

function param(req: Request, key: string): string {
  const value = (req.params as Record<string, string | string[] | undefined>)[key];
  return String(Array.isArray(value) ? value[0] : value ?? '').trim();
}

function body(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
}

function flag(value: unknown): boolean {
  return value === '1' || value === 'true' || value === true;
}

deskRouter.get('/', route(async (req, res) => {
  const data = await readDesk();
  const cards = req.query.archived === '0' ? data.cards.filter((c) => !c.archived) : data.cards;
  res.json({ rev: data.rev, owner: ownerActor(), columns: COLUMN_META, todos: data.todos, cards });
}));

/** Cheap poll for the workspace badge and desktop alerts. */
deskRouter.get('/summary', route(async (_req, res) => {
  const data = await readDesk();
  const open = data.todos.filter((t) => t.status === 'open');
  const high = open.filter((t) => t.priority === 'high');
  res.json({
    rev: data.rev,
    openTodos: open.length,
    highTodos: high.length,
    // "Waiting on you" successor under the five-stage board: a card with an
    // open Needs-you item linked to it (the card's needs-Matt flag).
    waitingCards: data.cards.filter((c) => !c.archived && open.some((t) => t.cardId === c.id)).length,
    // A client only offers answer buttons when this is present, so one that
    // ships before this server restarts degrades cleanly.
    answerable: true,
    high: [...high]
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, 5)
      .map((t) => ({ id: t.id, title: t.title, createdAt: t.createdAt, from: t.from.name })),
    quiet: isQuietHours(),
  });
}));

// ---- todos ----------------------------------------------------------------------

deskRouter.get('/todos', route(async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : 'open';
  if (!['open', 'done', 'all'].includes(status)) throw new DeskError(400, 'status must be open, done, or all');
  const { todos } = await readDesk();
  res.json({ todos: status === 'all' ? todos : todos.filter((t) => t.status === status) });
}));

deskRouter.post('/todos', route(async (req, res) => {
  const input = body(req);
  const todo = await createTodo(input, resolveAuthor(input.agent));
  notifyTodoTouched();
  res.status(201).json({ todo });
}));

deskRouter.patch('/todos/:id', route(async (req, res) => {
  const input = body(req);
  const todo = await updateTodo(param(req, 'id'), input);
  if (input.priority !== undefined) notifyTodoTouched();
  res.json({ todo });
}));

deskRouter.post('/todos/:id/answer', answerTodoHandler());

deskRouter.post('/todos/:id/complete', route(async (req, res) => {
  res.json({ todo: await setTodoStatus(param(req, 'id'), 'done') });
}));

deskRouter.post('/todos/:id/reopen', route(async (req, res) => {
  res.json({ todo: await setTodoStatus(param(req, 'id'), 'open') });
}));

deskRouter.delete('/todos/:id', route(async (req, res) => {
  await deleteTodo(param(req, 'id'));
  res.status(204).end();
}));

// ---- cards ----------------------------------------------------------------------

deskRouter.get('/cards', route(async (req, res) => {
  const q = req.query;
  const owner = typeof q.owner === 'string' && q.owner.trim().toLowerCase() !== 'all' ? q.owner : '';
  const project = typeof q.project === 'string' ? q.project.trim().toLowerCase() : '';
  let column = null as ReturnType<typeof parseColumn>;
  if (typeof q.column === 'string' && q.column.trim()) {
    column = parseColumn(q.column);
    if (!column) throw new DeskError(400, `column must be one of ${DESK_COLUMNS.join(', ')}`);
  }
  const includeDone = flag(q.includeDone) || column === 'in_production';
  const includeArchived = flag(q.includeArchived);
  const { cards } = await readDesk();
  const out = cards.filter((c: DeskCard) =>
    (includeArchived || !c.archived)
    && (includeDone || c.column !== 'in_production')
    && (!column || c.column === column)
    && (!owner || matchesActor(c.owner, owner))
    && (!project || (c.project ?? '').toLowerCase() === project));
  res.json({ cards: out });
}));

deskRouter.get('/cards/:id', route(async (req, res) => {
  const id = param(req, 'id');
  const { cards, todos } = await readDesk();
  const card = cards.find((c) => c.id === id);
  if (!card) throw new DeskError(404, `No board card with id ${id}.`);
  res.json({ card, todos: todos.filter((t) => t.cardId === id) });
}));

deskRouter.post('/cards', route(async (req, res) => {
  const input = body(req);
  const by = resolveAuthor(input.agent);
  const owner = resolveOwner(input.owner, by)!;
  res.status(201).json({ card: await createCard(input, owner, by, { dedupe: input.dedupe === true }) });
}));

deskRouter.patch('/cards/:id', route(async (req, res) => {
  const input = body(req);
  res.json({ card: await updateCard(param(req, 'id'), input, resolveOwner(input.owner)) });
}));

deskRouter.post('/cards/:id/move', route(async (req, res) => {
  const input = body(req);
  res.json({ card: await moveCard(param(req, 'id'), input.column, input.index) });
}));

export type CommentNotice = { delivered: boolean; to?: string; reason?: string };

/** The human commented on a card: wake its owner through the team bus (the
 *  durable queue team_message uses), so they answer now instead of the next
 *  time they happen to read the board. Cards the owner holds, or whose agent
 *  is gone, go to the Chief of Staff. */
export async function notifyCardOwner(card: DeskCard, comment: DeskComment): Promise<CommentNotice> {
  const agents = listAgents();
  const owner = card.owner.kind === 'agent'
    ? agents.find((a) => a.id === card.owner.id) ?? findAgent(card.owner.name)
    : undefined;
  const recipient = owner ?? agents.find((a) => a.id === 'chief-of-staff') ?? agents[0];
  if (!recipient) return { delivered: false, reason: 'no teammate to tell' };
  const whose = owner ? 'your' : card.owner.kind === 'owner' ? 'their own' : `${card.owner.name}'s`;
  const text = [
    `${DESK_OWNER_NAME} commented on ${whose} Desk card [desk:${card.id}] "${card.title}":`,
    '',
    comment.text,
    '',
    `Read the card with board_card_get (id ${card.id}) if you need the context, then answer on it with board_card_comment. Move or update the card if this changes the plan.`,
  ].join('\n');
  try {
    const result = await deliverTeamMessage({ from: DESK_OWNER_NAME, to: recipient.id, text, wait: false, source: 'desk' });
    return { delivered: result.delivered, to: result.to ?? recipient.name, ...(result.delivered ? {} : { reason: result.reason }) };
  } catch (error) {
    console.warn(`[desk] could not tell ${recipient.name} about a comment on ${card.id}: ${(error as Error).message}`);
    return { delivered: false, to: recipient.name, reason: 'delivery failed' };
  }
}

// ---- answers ----------------------------------------------------------------------

export type TeamMessenger = typeof deliverTeamMessage;

/** Who hears an answer: the agent that asked, else the agent that owns the
 *  linked card, else the Chief of Staff (the asker has left the roster).
 *  Never an arbitrary teammate: with no Chief of Staff it stays undelivered.
 *  undefined when the item was the owner's own and no agent is involved. */
function answerRecipient(todo: DeskTodo, card: DeskCard | undefined): Agent | undefined {
  const cardAgent = card?.owner.kind === 'agent' ? card.owner : undefined;
  if (todo.from.kind !== 'agent' && !cardAgent) return undefined;
  const agents = listAgents();
  const match = (actor: DeskActor | undefined) =>
    actor?.kind === 'agent' ? agents.find((a) => a.id === actor.id) ?? findAgent(actor.name) : undefined;
  return match(todo.from) ?? match(cardAgent) ?? agents.find((a) => a.id === 'chief-of-staff');
}

function answerMessage(todo: DeskTodo, recipient: Agent, card: DeskCard | undefined): string {
  const answer = todo.answer!;
  const askedByRecipient = todo.from.kind === 'agent'
    && (todo.from.id === recipient.id || todo.from.name.trim().toLowerCase() === recipient.name.trim().toLowerCase());
  const whose = askedByRecipient ? 'your' : todo.from.kind === 'agent' ? `${todo.from.name}'s` : 'a';
  const lines = [`${DESK_OWNER_NAME} answered ${whose} Needs-you item [desk:${todo.id}] "${todo.title}".`, ''];
  if (answer.choice) lines.push(`Answer: ${answer.choice}`);
  if (answer.text) lines.push(answer.choice ? `${DESK_OWNER_NAME} added: ${answer.text}` : `Answer: ${answer.text}`);
  lines.push(
    '',
    'The item is already marked answered on the Desk, so there is nothing to complete.',
    `Answer id ${todo.id} (${answer.at}). This message can arrive twice if the server restarted while it was being delivered; if you already acted on it, ignore the repeat.`,
    card
      ? `If this changes the plan, update card [desk:${card.id}] with board_card_comment or board_card_move.`
      : 'If this changes the plan, update the board card for this work.',
  );
  return lines.join('\n');
}

/** Tell the owning agent about a saved answer, at most once: the claim is on
 *  disk before the team bus is called, so a double call, a retry racing the
 *  route, or a crash mid-send never repeats the message. Shared by the
 *  answer route and the notifier's retry loop. */
export async function deliverDeskAnswer(todoId: string, deliver: TeamMessenger = deliverTeamMessage): Promise<CommentNotice & { todo?: DeskTodo }> {
  const todo = await claimAnswerDelivery(todoId);
  if (!todo?.answer) {
    const current = (await readDesk()).todos.find((t) => t.id === todoId);
    if (!current?.answer) return { delivered: false, reason: 'no answer to deliver' };
    if (current.answer.delivery === 'sent') return { delivered: true, todo: current };
    if (current.answer.delivery === 'none') return { delivered: false, todo: current, reason: 'nobody to tell' };
    return { delivered: false, todo: current, reason: 'already being delivered' };
  }
  const card = todo.cardId ? (await readDesk()).cards.find((c) => c.id === todo.cardId) : undefined;
  const recipient = answerRecipient(todo, card);
  let notice: CommentNotice;
  if (!recipient) {
    notice = { delivered: false, reason: 'no teammate to tell' };
  } else {
    try {
      const result = await deliver({ from: DESK_OWNER_NAME, to: recipient.id, text: answerMessage(todo, recipient, card), wait: false, source: 'desk' });
      notice = { delivered: result.delivered, to: result.to ?? recipient.name, ...(result.delivered ? {} : { reason: result.reason }) };
    } catch (error) {
      console.warn(`[desk] could not tell ${recipient.name} about the answer to ${todo.id}: ${(error as Error).message}`);
      notice = { delivered: false, to: recipient.name, reason: 'delivery failed' };
    }
  }
  try {
    return { ...notice, todo: (await setAnswerDelivery(todo.id, notice.delivered ? 'sent' : 'failed', todo.answer.sendingAt)) ?? todo };
  } catch (error) {
    // The claim stays on disk and goes stale, so the notifier delivers this
    // answer again later; the Desk keeps showing it as not delivered.
    console.warn(`[desk] could not record the answer delivery for ${todo.id}: ${(error as Error).message}`);
    return { ...notice, todo };
  }
}

/** POST /todos/:id/answer. A factory so a scratch run can pass a stub
 *  messenger instead of waking a real agent. */
export function answerTodoHandler(deliver: TeamMessenger = deliverTeamMessage) {
  return route(async (req, res) => {
    const { todo, duplicate } = await answerTodo(param(req, 'id'), body(req));
    // Double tap: the first call already saved and delivered.
    if (duplicate) {
      res.json({ todo, duplicate: true });
      return;
    }
    if (todo.answer?.delivery !== 'failed') {
      res.status(201).json({ todo, notified: { delivered: false, reason: 'nobody to tell' } });
      return;
    }
    const { todo: after, ...notified } = await deliverDeskAnswer(todo.id, deliver);
    res.status(201).json({ todo: after ?? todo, notified });
  });
}

deskRouter.post('/cards/:id/comments', route(async (req, res) => {
  const input = body(req);
  // The Desk UI never names an author; the team MCP always does. Only a real
  // owner comment wakes anyone, so agents answering on the card cannot loop.
  const fromOwnerUi = input.agent === undefined || input.agent === null;
  const author = resolveAuthor(input.agent);
  const result = await commentCard(param(req, 'id'), input.text, author);
  const notified = fromOwnerUi && author.kind === 'owner' ? await notifyCardOwner(result.card, result.comment) : undefined;
  res.status(201).json(notified ? { ...result, notified } : result);
}));

deskRouter.delete('/cards/:id/comments/:commentId', route(async (req, res) => {
  res.json({ card: await deleteComment(param(req, 'id'), param(req, 'commentId')) });
}));

deskRouter.post('/cards/:id/archive', route(async (req, res) => {
  const input = body(req);
  res.json({ card: await archiveCard(param(req, 'id'), input.archived !== false) });
}));
