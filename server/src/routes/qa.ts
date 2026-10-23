import { Router } from 'express';
import { asyncHandler } from './helpers.ts';
import {
  QA_TESTERS, qaBoard, qaBoardEnabled, qaPinnedList, qaRepoAllowed, qaTesterByLogin, upsertQaItem,
  type QaTesterId,
} from '../lib/qaBoard.ts';
import { applySlackOutcome, syncQaFromGithub } from '../lib/qaSync.ts';

export const qaRouter = Router();

/** Who may read a tester's column. A login configured for that tester sees
 *  only their own column; the operator (no login header, loopback or the
 *  trusted private proxy) sees all three, exactly like every other room.
 *  An unconfigured login is never granted a column. */
function visibleTesters(req: { header(name: string): string | undefined }): QaTesterId[] | null {
  const login = req.header('x-qa-login');
  if (!login) return ['sud', 'edgar', 'martin'];
  const tester = qaTesterByLogin(login);
  return tester ? [tester] : null;
}

function guard(res: { status(code: number): { json(body: unknown): void } }): boolean {
  if (qaBoardEnabled) return true;
  res.status(404).json({ error: 'QA board is not configured on this deployment.' });
  return false;
}

qaRouter.get('/', asyncHandler(async (req, res) => {
  if (!guard(res)) return;
  const visible = visibleTesters(req);
  if (!visible) { res.status(403).json({ error: 'That login is not a QA tester.' }); return; }
  res.setHeader('Cache-Control', 'no-store');
  const board = await qaBoard();
  res.json({
    testers: visible.map((id) => ({
      id,
      name: QA_TESTERS.find((t) => t.id === id)?.name ?? id,
      items: board[id],
    })),
  });
}));

/** A staging merge lands a card. Called by the routing layer the moment Sam
 *  merges; also safe to call twice, the record is keyed by repo + PR. Only
 *  configured QA repos may land; anything else is refused, never stored. */
qaRouter.post('/items', asyncHandler(async (req, res) => {
  if (!guard(res)) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const repo = typeof body.repo === 'string' ? body.repo : '';
  const pr = typeof body.pr === 'number' ? body.pr : Number(body.pr);
  const title = typeof body.title === 'string' ? body.title : '';
  if (!repo || !Number.isInteger(pr) || pr <= 0 || !title) {
    res.status(400).json({ error: 'repo, pr and title are required.' });
    return;
  }
  if (!qaRepoAllowed(repo)) {
    res.status(400).json({ error: 'That repo is not a configured QA repo.' });
    return;
  }
  const item = await upsertQaItem({
    repo,
    pr,
    title,
    app: body.app === 'Operly' ? 'Operly' : 'Studio',
    tester: typeof body.tester === 'string' ? body.tester : undefined,
    needsSud: body.needsSud === true,
    builderIsTester: body.builderIsTester === true,
    builder: typeof body.builder === 'string' ? body.builder : undefined,
    dueAt: typeof body.dueAt === 'string' ? body.dueAt : undefined,
    slackThreadUrl: typeof body.slackThreadUrl === 'string' ? body.slackThreadUrl : undefined,
    slackThreadTs: typeof body.slackThreadTs === 'string' ? body.slackThreadTs : undefined,
    stagingUrl: typeof body.stagingUrl === 'string' ? body.stagingUrl : undefined,
  });
  res.json({ item });
}));

/** A reply outcome in the item's Slack thread moves or clears the card.
 *  Sam relays the tester's word from the thread; the word alone decides. */
qaRouter.post('/outcome', asyncHandler(async (req, res) => {
  if (!guard(res)) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const repo = typeof body.repo === 'string' ? body.repo : '';
  const pr = typeof body.pr === 'number' ? body.pr : Number(body.pr);
  const outcome = typeof body.outcome === 'string' ? body.outcome : '';
  if (!repo || !Number.isInteger(pr) || !outcome) {
    res.status(400).json({ error: 'repo, pr and outcome are required.' });
    return;
  }
  const item = await applySlackOutcome(repo, pr, outcome);
  if (!item) { res.status(404).json({ error: 'No open QA item matches that thread outcome.' }); return; }
  res.json({ item });
}));

/** The self-check: add new staging merges from a healthy GitHub snapshot
 *  and report what disagrees for a person to resolve. Drift is reported,
 *  never auto-deleted; see qaSync.ts. */
qaRouter.post('/sync', asyncHandler(async (_req, res) => {
  if (!guard(res)) return;
  res.json(await syncQaFromGithub());
}));

/** The pinned Slack lists, one per visible tester, rendered from the same
 *  records as the board. This is the exact text the pinned message shows,
 *  so board and Slack cannot disagree; the tool that owns the pin refreshes
 *  it from here after every outcome. */
qaRouter.get('/items', asyncHandler(async (req, res) => {
  if (!guard(res)) return;
  const visible = visibleTesters(req);
  if (!visible) { res.status(403).json({ error: 'That login is not a QA tester.' }); return; }
  res.setHeader('Cache-Control', 'no-store');
  const board = await qaBoard();
  res.json({ pinned: visible.map((id) => ({ tester: id, text: qaPinnedList(id, board[id]) })) });
}));
