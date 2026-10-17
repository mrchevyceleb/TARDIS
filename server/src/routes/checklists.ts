// Checklist reads and tool-driven mutations (card-a77246). The sidebar loads
// its agent's checklist here, and the sidebar_checklist tool (team-mcp) posts
// every mutation here; each mutation broadcasts a live 'checklist' lane
// event, so the sidebar updates the moment the agent moves the work — no
// polling. The route is local-only same-origin like the desk surface.
import { Router } from 'express';
import { asyncHandler } from './helpers.ts';
import { broadcastChecklist } from '../chat/laneEvents.ts';
import { mutateChecklist, newChecklistId, readChecklist, type Checklist, type ChecklistItem } from '../lib/checklistStore.ts';

export const checklistsRouter = Router();

const NAME = /^[A-Za-z0-9_-]{1,48}$/;
const str = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;

const itemFrom = (raw: unknown): ChecklistItem | null => {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const text = str(r.text, 240);
  if (!text) return null;
  return {
    id: typeof r.id === 'string' && NAME.test(r.id) ? r.id : newChecklistId(),
    text,
    status: str(r.status, 160),
    assignee: str(r.assignee, 40),
    done: r.done === true,
    doneAt: r.done === true ? Date.now() : undefined,
    doneBy: r.done === true ? str(r.by, 40) : undefined,
  };
};

checklistsRouter.get('/:owner', asyncHandler(async (req, res) => {
  const owner = String(req.params.owner ?? '');
  if (!NAME.test(owner)) { res.status(400).json({ error: 'bad owner' }); return; }
  res.json({ checklist: await readChecklist(owner) });
}));

checklistsRouter.post('/:owner', asyncHandler(async (req, res) => {
  const owner = String(req.params.owner ?? '');
  if (!NAME.test(owner)) { res.status(400).json({ error: 'bad owner' }); return; }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const action = typeof body.action === 'string' ? body.action : '';
  const id = typeof body.id === 'string' && NAME.test(body.id) ? body.id : '';
  const by = str(body.by, 40);
  const find = (list: Checklist): ChecklistItem | undefined => list.items.find((it) => it.id === id);
  const patchItem = (list: Checklist, changes: Partial<ChecklistItem>): Checklist => ({
    ...list,
    items: list.items.map((it) => (it.id === id ? { ...it, ...changes } : it)),
  });

  let error: string | null = null;
  const checklist = await mutateChecklist(owner, (list) => {
    switch (action) {
      case 'reset': {
        // /sidebar with a fresh list: replace the whole checklist.
        const items = (Array.isArray(body.items) ? body.items : [])
          .map(itemFrom)
          .filter((it): it is ChecklistItem => it !== null)
          .slice(0, 30);
        return { title: str(body.title, 120) ?? 'Checklist', items };
      }
      case 'add': {
        const item = itemFrom(body);
        if (!item) { error = 'an item needs text'; return list; }
        if (!list) return { title: str(body.title, 120) ?? 'Checklist', items: [item] };
        if (list.items.length >= 30) { error = 'the checklist is at its 30-item cap'; return list; }
        return { ...list, items: [...list.items, item] };
      }
      case 'update': {
        if (!list) { error = 'no checklist yet — create one first'; return list; }
        const item = find(list);
        if (!item) { error = `no item ${id}`; return list; }
        return patchItem(list, {
          ...(str(body.text, 240) !== undefined ? { text: str(body.text, 240) } : {}),
          // A status update may explicitly clear the line.
          ...(typeof body.status === 'string' ? { status: str(body.status, 160) } : {}),
        });
      }
      case 'done': {
        if (!list) { error = 'no checklist yet'; return list; }
        const item = find(list);
        if (!item) { error = `no item ${id}`; return list; }
        const done = body.done === true;
        return patchItem(list, done
          ? { done: true, doneAt: Date.now(), doneBy: by }
          : { done: false, doneAt: undefined, doneBy: undefined });
      }
      case 'assign': {
        if (!list) { error = 'no checklist yet'; return list; }
        const item = find(list);
        if (!item) { error = `no item ${id}`; return list; }
        // An explicit null assignee clears it.
        return patchItem(list, { assignee: body.assignee === null ? undefined : str(body.assignee, 40) });
      }
      case 'remove': {
        if (!list) { error = 'no checklist yet'; return list; }
        if (!find(list)) { error = `no item ${id}`; return list; }
        return { ...list, items: list.items.filter((it) => it.id !== id) };
      }
      case 'clear':
        return null; // deletes the whole checklist
      default:
        error = 'unknown action';
        return list;
    }
  });

  if (error) { res.status(400).json({ error }); return; }
  broadcastChecklist(owner, checklist);
  res.json({ checklist });
}));
