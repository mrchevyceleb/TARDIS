import { Router } from 'express';
import { asyncHandler } from './helpers.ts';
import {
  QA_TESTERS, qaBoard, qaBoardEnabled, qaPinnedList, qaRepoAllowed, upsertQaItem,
  type QaTesterId,
} from '../lib/qaBoard.ts';
import {
  clearQaSession, clearQaSessionCookie, createQaSession, qaIsOperator, qaSessionCookie, qaSessionTester, qaSignInPath, verifyQaSignIn,
} from '../lib/qaAuth.ts';
import { applySlackOutcome, syncQaFromGithub } from '../lib/qaSync.ts';

export const qaRouter = Router();

function configured(res: { status(code: number): { json(body: unknown): void } }): boolean {
  if (qaBoardEnabled()) return true;
  res.status(404).json({ error: 'QA board is not configured on this deployment.' });
  return false;
}

/** Browser sign-in exchange. A signed link identifies a configured tester;
 *  success creates an HttpOnly server session and returns the tester to the
 *  board. This is intentionally separate from the operator view below. */
qaRouter.get('/auth/start', (req, res) => {
  if (!configured(res)) return;
  const data = typeof req.query.d === 'string' ? req.query.d : '';
  const suppliedSignature = typeof req.query.s === 'string' ? req.query.s : '';
  const tester = verifyQaSignIn(data, suppliedSignature);
  if (!tester) { res.status(403).send('This QA sign-in link has expired. Ask for a fresh link.'); return; }
  const nonce = createQaSession(tester);
  res.setHeader('Set-Cookie', qaSessionCookie(nonce));
  res.redirect(303, '/qa');
});

type QaReq = { header(name: string): string | undefined; socket?: { remoteAddress?: string } };

/** Operator view: a direct loopback connection with no proxy identity
 *  (plain local Chrome), or the tailnet login in RIVENDELL_QA_OPERATOR
 *  when a proxy such as Tailscale Serve forwards the request. Every other
 *  proxied caller is a tester and must use the signed link. */
function operatorOk(req: QaReq): boolean {
  return qaIsOperator(
    { tailscaleUser: req.header('tailscale-user-login'), xForwardedFor: req.header('x-forwarded-for') },
    req.socket?.remoteAddress,
    process.env.RIVENDELL_QA_OPERATOR,
  );
}

/** Who may read a tester's column: a signed-in tester sees only their own;
 *  the operator sees all three. Anyone else is granted no column. */
function visibleTesters(req: QaReq): QaTesterId[] | null {
  const tester = qaSessionTester(req.header('cookie'));
  if (tester) return [tester];
  return operatorOk(req) ? ['sud', 'edgar', 'martin'] : null;
}

/** Operator-only link issuance: for each configured tester, a fresh
 *  ten-minute single-use sign-in path to copy and hand over. Requires the
 *  same operator access as the all-columns view. */
qaRouter.get('/auth/links', (req, res) => {
  if (!configured(res)) return;
  if (!operatorOk(req)) { res.status(403).json({ error: 'Only the operator can issue sign-in links.' }); return; }
  res.setHeader('Cache-Control', 'no-store');
  const links = QA_TESTERS
    .map((t) => ({ id: t.id, name: t.name, path: qaSignInPath(t.id) }))
    .filter((l): l is { id: QaTesterId; name: string; path: string } => Boolean(l.path));
  res.json({ links });
});

qaRouter.get('/', asyncHandler(async (req, res) => {
  if (!configured(res)) return;
  const visible = visibleTesters(req);
  if (!visible) { res.status(401).json({ error: 'Open your QA sign-in link first.' }); return; }
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
  if (!configured(res)) return;
  if (!operatorOk(req)) { res.status(403).json({ error: 'Only the operator or the routing layer can land a QA item.' }); return; }
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
  if (!configured(res)) return;
  if (!operatorOk(req)) { res.status(403).json({ error: 'Only the operator or the thread relay can move a QA item.' }); return; }
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
 *  never auto-deleted; see qaSync.ts. The background scheduler normally
 *  runs this; the endpoint remains an operator diagnostic. */
qaRouter.post('/sync', asyncHandler(async (req, res) => {
  if (!configured(res)) return;
  if (!operatorOk(req)) { res.status(403).json({ error: 'Only the operator can request a sync.' }); return; }
  res.json(await syncQaFromGithub());
}));

/** The pinned Slack lists, one per visible tester, rendered from the same
 *  records as the board. This is the exact text the pinned message shows,
 *  so board and Slack cannot disagree; the tool that owns the pin refreshes
 *  it from here after every outcome. */
qaRouter.get('/items', asyncHandler(async (req, res) => {
  if (!configured(res)) return;
  const visible = visibleTesters(req);
  if (!visible) { res.status(401).json({ error: 'Open your QA sign-in link first.' }); return; }
  res.setHeader('Cache-Control', 'no-store');
  const board = await qaBoard();
  res.json({ pinned: visible.map((id) => ({ tester: id, text: qaPinnedList(id, board[id]) })) });
}));

qaRouter.post('/auth/sign-out', (req, res) => {
  clearQaSession(req.header('cookie'));
  res.setHeader('Set-Cookie', clearQaSessionCookie());
  res.status(204).end();
});
