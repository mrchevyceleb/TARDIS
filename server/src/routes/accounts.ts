import { Router, type Request } from 'express';
import { ELROND_WORKSPACE_PATH } from '../config.ts';
import { listAgents, cliForAgentEngine } from '../chat/agents.ts';
import { peekThreadSession } from '../chat/runner.ts';
import { preferredSubscriptionEnv, chooseCliProfile, cliProfiles } from '../lib/cliProfiles.ts';
import { startCliLogin, getCliLogin, submitCliLoginCode, cancelCliLogin } from '../lib/cliLogin.ts';
import { accountForProfile, cliProfileForEnv, listCliAccounts, type AccountEngine } from '../lib/cliAccounts.ts';
import { asyncHandler } from './helpers.ts';

export const accountsRouter = Router();

// One metadata read serves the whole rail; profile identity checks coalesce.
accountsRouter.get('/agents', asyncHandler(async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const accounts = await listCliAccounts();
  const assignments = listAgents().flatMap(agent => {
    const engine = cliForAgentEngine(agent.engine);
    if (engine !== 'claude' && engine !== 'codex') return [];
    let selected;
    try {
      const env = preferredSubscriptionEnv(engine, ELROND_WORKSPACE_PATH, agent.home, agent.name);
      selected = accountForProfile(accounts, engine, cliProfileForEnv(engine, env));
    } catch { /* The row offers the same account recovery as the picker. */ }
    const live = peekThreadSession({ cli: engine, repoPath: ELROND_WORKSPACE_PATH, chatId: agent.home });
    const busy = live?.isBusy() ?? false;
    const activeEmail = busy && live && 'subscriptionAccountEmail' in live ? live.subscriptionAccountEmail() : null;
    return [{ agentId: agent.id, engine, email: busy ? activeEmail : selected?.email ?? null,
      selectedEmail: selected?.email ?? null, busy,
      status: busy && activeEmail ? 'connected' : selected?.status ?? 'unavailable' }];
  });
  res.json({ assignments });
}));

accountsRouter.get('/', asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : undefined;
  const agent = agentId ? listAgents().find((entry) => entry.id === agentId) : undefined;
  if (agentId && !agent) { res.status(404).json({ error: 'This teammate could not be found.' }); return; }
  const engine = req.query.engine === 'claude' || req.query.engine === 'codex'
    ? req.query.engine as AccountEngine : undefined;
  if (!engine) { res.status(400).json({ error: 'Choose Claude or Codex to see its accounts.' }); return; }
  const cwd = typeof req.query.repo === 'string' ? req.query.repo : ELROND_WORKSPACE_PATH;
  const chatId = agent?.home || (typeof req.query.chatId === 'string' ? req.query.chatId : 'main');
  try {
    const accounts = await listCliAccounts(req.query.refresh === '1');
    let selected;
    let selectionNotice: string | null = null;
    try {
      const env = preferredSubscriptionEnv(engine, cwd, chatId, agent?.name);
      selected = accountForProfile(accounts, engine, cliProfileForEnv(engine, env));
    } catch { selectionNotice = 'Your saved account is unavailable. Choose another signed-in account.'; }
    const live = peekThreadSession({ cli: engine, repoPath: cwd, chatId });
    const activeEngine = live?.cli === 'assistant' ? 'claude' : live?.cli === 'codex-personal' ? 'codex' : live?.cli;
    const profile = live && 'subscriptionProfile' in live ? live.subscriptionProfile() : null;
    const active = profile && (activeEngine === 'claude' || activeEngine === 'codex')
      ? accountForProfile(accounts, activeEngine, profile) : undefined;
    res.json({
      accounts: accounts.filter(account => account.engine === engine), engine, selectionNotice, selectedId: selected?.id ?? null,
      activeId: live?.isBusy() ? active?.id ?? null : null,
      activeEmail: live?.isBusy() && 'subscriptionAccountEmail' in live ? live.subscriptionAccountEmail() : null,
      activeEngine: live?.isBusy() ? activeEngine ?? null : null,
      busy: live?.isBusy() ?? false,
    });
  } catch {
    res.status(503).json({ error: 'I could not check the configured accounts. Try refreshing in a moment.' });
  }
}));

// The app is private-network only. Mutations still refuse cross-site browser
// requests so another page cannot change an agent's paid account or start OAuth.
accountsRouter.use((req, res, next) => {
  if (req.method === 'GET') { next(); return; }
  const origin = req.get('origin');
  if (req.get('sec-fetch-site') === 'cross-site' || origin && (() => { try { return new URL(origin).host !== req.get('host'); } catch { return true; } })()) {
    res.status(403).json({ error: 'Open accounts from TARDIS to make this change.' }); return;
  }
  next();
});

function target(req: Request): { engine: AccountEngine; chatId: string; cwd: string } {
  const { engine, agentId } = req.body || {};
  if (engine !== 'claude' && engine !== 'codex') throw new Error('Choose Claude or Codex.');
  const agent = typeof agentId === 'string' ? listAgents().find(entry => entry.id === agentId) : undefined;
  if (!agent) throw new Error('Choose the teammate whose account you want to switch.');
  return { engine, chatId: agent.home || `bot-${agent.id}`, cwd: ELROND_WORKSPACE_PATH };
}

accountsRouter.post('/select', asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const { engine, chatId, cwd } = target(req);
    const accounts = await listCliAccounts(true);
    const account = accounts.find(entry => entry.engine === engine && entry.id === req.body?.accountId);
    if (!account || account.status !== 'connected') { res.status(409).json({ error: 'That account needs a fresh sign-in. Refresh sign-ins and try again.' }); return; }
    const profile = cliProfiles().find(entry => account.profileIds.includes(entry.id) && entry.engine === engine);
    if (!profile) throw new Error('The account could not be found.');
    await chooseCliProfile(engine, cwd, chatId, profile.id);
    // No runner starts here. The next admitted message applies the choice.
    res.json({ ok: true, accountId: account.id });
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'The account could not be switched.' }); }
}));

accountsRouter.post('/logins', asyncHandler(async (req, res) => {
  const engine = req.body?.engine;
  if (engine !== 'claude' && engine !== 'codex') { res.status(400).json({ error: 'Choose Claude or Codex.' }); return; }
  res.setHeader('Cache-Control', 'no-store');
  res.json(await startCliLogin(engine));
}));
accountsRouter.get('/logins/:id', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const login = getCliLogin(req.params.id as string);
  if (!login) { res.status(404).json({ error: 'This sign-in has ended. Start a fresh one.' }); return; }
  res.json(login);
});
accountsRouter.post('/logins/:id/code', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try { submitCliLoginCode(req.params.id as string, req.body?.code); res.json({ ok: true }); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'The sign-in code could not be checked.' }); }
});
accountsRouter.delete('/logins/:id', (req, res) => {
  cancelCliLogin(req.params.id as string); res.json({ ok: true });
});
