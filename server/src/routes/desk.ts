// /api/desk: the owner's "Needs you" list and the board of agent work.
// Backs the Desk room and the desk_* / board_* tools in the team MCP.
// Callers identify an agent author with `agent` (name or id); no `agent`
// means the owner is acting from the UI.

import { Router, type NextFunction, type Request, type Response } from 'express';
import { listAgents } from '../chat/agents.ts';
import { DESK_OWNER_NAME } from '../config.ts';
import {
  DESK_COLUMNS,
  DeskError,
  archiveCard,
  commentCard,
  createCard,
  createTodo,
  deleteComment,
  deleteTodo,
  moveCard,
  parseColumn,
  readDesk,
  setTodoStatus,
  updateCard,
  updateTodo,
  type DeskActor,
  type DeskCard,
} from '../lib/deskStore.ts';

export const deskRouter = Router();

const COLUMN_META = DESK_COLUMNS.map((key) => ({
  key,
  title: {
    pipeline: 'Pipeline',
    up_next: 'Up next',
    in_progress: 'In progress',
    waiting: `Waiting on ${DESK_OWNER_NAME}`,
    done: 'Done',
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

/** Cheap poll for the workspace badge. */
deskRouter.get('/summary', route(async (_req, res) => {
  const data = await readDesk();
  const open = data.todos.filter((t) => t.status === 'open');
  res.json({
    rev: data.rev,
    openTodos: open.length,
    highTodos: open.filter((t) => t.priority === 'high').length,
    waitingCards: data.cards.filter((c) => !c.archived && c.column === 'waiting').length,
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
  res.status(201).json({ todo });
}));

deskRouter.patch('/todos/:id', route(async (req, res) => {
  res.json({ todo: await updateTodo(param(req, 'id'), body(req)) });
}));

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
  const includeDone = flag(q.includeDone) || column === 'done';
  const includeArchived = flag(q.includeArchived);
  const { cards } = await readDesk();
  const out = cards.filter((c: DeskCard) =>
    (includeArchived || !c.archived)
    && (includeDone || c.column !== 'done')
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
  res.status(201).json({ card: await createCard(input, owner, by) });
}));

deskRouter.patch('/cards/:id', route(async (req, res) => {
  const input = body(req);
  res.json({ card: await updateCard(param(req, 'id'), input, resolveOwner(input.owner)) });
}));

deskRouter.post('/cards/:id/move', route(async (req, res) => {
  const input = body(req);
  res.json({ card: await moveCard(param(req, 'id'), input.column, input.index) });
}));

deskRouter.post('/cards/:id/comments', route(async (req, res) => {
  const input = body(req);
  const result = await commentCard(param(req, 'id'), input.text, resolveAuthor(input.agent));
  res.status(201).json(result);
}));

deskRouter.delete('/cards/:id/comments/:commentId', route(async (req, res) => {
  res.json({ card: await deleteComment(param(req, 'id'), param(req, 'commentId')) });
}));

deskRouter.post('/cards/:id/archive', route(async (req, res) => {
  const input = body(req);
  res.json({ card: await archiveCard(param(req, 'id'), input.archived !== false) });
}));
