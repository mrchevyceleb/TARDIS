// /api/priorities — Matt's Priorities boards, one ordered list per enabled
// agent. Matt edits from the Desk; agents edit their own board through the
// team MCP, which passes its roster id as `by`.

import { Router } from 'express';
import { asyncHandler } from './helpers.ts';
import { listAgents } from '../chat/agents.ts';
import {
  PRIORITY_AGENTS, addPriority, clearDonePriorities, hasPriorityBoard, listAllPriorityBoards,
  listPriorities, movePriority, removePriority, updatePriority,
} from '../lib/prioritiesStore.ts';

export const prioritiesRouter = Router();

/** Boards resolve BY ID ONLY, like commitment mutations: a display name is
 *  not owner-proof. */
function boardId(agent: unknown): string | undefined {
  const needle = typeof agent === 'string' ? agent.trim() : '';
  return needle && hasPriorityBoard(needle) ? needle : undefined;
}

/** `by` is 'matt' unless an existing roster id wrote it. */
function author(by: unknown): string {
  const id = typeof by === 'string' ? by.trim() : '';
  return id && listAgents().some((a) => a.id === id) ? id : 'matt';
}

prioritiesRouter.get('/', asyncHandler(async (req, res) => {
  if (req.query.agent !== undefined) {
    const id = boardId(req.query.agent);
    if (!id) { res.status(404).json({ error: 'no priorities board for that agent' }); return; }
    res.json({ agentId: id, items: listPriorities(id) });
    return;
  }
  const names = new Map(listAgents().map((a) => [a.id, a.name]));
  const boards = listAllPriorityBoards();
  res.json({
    boards: PRIORITY_AGENTS.map((id) => ({ agentId: id, name: names.get(id) ?? id, items: boards[id] ?? [] })),
  });
}));

prioritiesRouter.post('/:action', asyncHandler(async (req, res) => {
  const { agent, id, text, done, direction, by } = req.body ?? {};
  const board = boardId(agent);
  if (!board) { res.status(404).json({ error: 'no priorities board for that agent (pass the agent id)' }); return; }
  const who = author(by);
  const action = String(req.params.action);
  const result = action === 'add' ? addPriority(board, text, who)
    : action === 'update' ? updatePriority(board, id, { text, done }, who)
      : action === 'remove' ? removePriority(board, id)
        : action === 'move' ? (direction === 'up' || direction === 'down'
          ? movePriority(board, id, direction) : { error: 'direction must be up or down', status: 400 })
          : action === 'clear-done' ? clearDonePriorities(board)
            : { error: 'unknown action', status: 404 };
  if (result.error) { res.status(result.status ?? 400).json({ error: result.error }); return; }
  res.json({ ok: true, ...(result.item ? { item: result.item } : {}), items: listPriorities(board) });
}));
