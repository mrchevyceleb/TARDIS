// Opt-in integration proof using the installed Claude CLI, an isolated profile,
// and a loopback upstream that returns HTTP 503. No credentials or live service.
// From the repo root: node --import tsx server/scripts/probe-peer-delivery.mjs
// Add --fail-first-write to prove an input that never reached stdin is retried.
// --runner <path> can exercise a saved pre-fix runner against the same probe.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const root = mkdtempSync(join(tmpdir(), 'tardis-peer-delivery-'));
const profile = join(root, 'profile');
mkdirSync(profile);
mkdirSync(join(root, 'state'));
writeFileSync(join(profile, '.claude.json'), JSON.stringify({
  oauthAccount: { emailAddress: 'probe@example.test', organizationUuid: 'probe' },
}));
const accountMap = join(root, 'accounts.json');
writeFileSync(accountMap, JSON.stringify({
  accounts: { probe: { claude_config_dir: profile, codex_home: join(root, 'codex') } },
  default_account: 'probe', rules: [],
}));
process.env.RIVENDELL_STATE_DIR = join(root, 'state');
process.env.ELROND_WORKSPACE_PATH = root;
process.env.RIVENDELL_SIDE_COPY = '1';
process.env.RIVENDELL_ACCOUNT_MAP = accountMap;
delete process.env.RIVENDELL_AGENT_ACCOUNTS;
delete process.env.RIVENDELL_DEFAULT_CLI_ACCOUNT;

const sentinel = 'DELIVERY_PROBE_SENTINEL';
const occurrences = [];
const server = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  if (req.url.includes('count_tokens')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"input_tokens":50}');
    return;
  }
  if (req.url.includes('/messages')) {
    occurrences.push(JSON.stringify(JSON.parse(body).messages).split(sentinel).length - 1);
  }
  res.writeHead(503, { 'content-type': 'application/json', 'x-should-retry': 'false' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Delivery fault injection' } }));
});
let session;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const runnerArg = process.argv.indexOf('--runner');
  const runner = runnerArg < 0 ? 'server/src/chat/runner.ts' : process.argv[runnerArg + 1];
  const { ClaudeSession } = await import(pathToFileURL(resolve(repo, runner)).href);
  const { ensureNativeCompactProxy } = await import(pathToFileURL(join(repo, 'server/src/chat/nativeCompactProxy.ts')).href);
  await ensureNativeCompactProxy();
  session = new ClaudeSession('claude', root, `delivery-probe-${randomUUID()}`, null, 'claude-haiku-4-5', 'low', false, null, {
    PATH: process.env.PATH, HOME: process.env.HOME,
    CLAUDE_CONFIG_DIR: profile, CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-local-probe',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  });
  const child = session.child;
  const events = [];
  session.subscribe(event => events.push(event), undefined, false);
  await session.ready;
  const failFirstWrite = process.argv.includes('--fail-first-write');
  if (failFirstWrite) {
    const write = child.stdin.write;
    child.stdin.write = (_payload, callback) => {
      child.stdin.write = write;
      callback(new Error('Injected failure before writing any bytes'));
      return false;
    };
  }
  const deliveryId = randomUUID();
  let submissions = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    const since = events.length;
    let stop = () => {};
    let timer;
    const ended = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Native turn did not finish')), 30_000);
      stop = session.subscribe(event => {
        if (event.ev.type === 'turnEnd') resolve();
        if (event.ev.type === 'closed') reject(new Error('Native worker closed'));
      }, session.latestSeq(), false);
    });
    try {
      submissions++;
      await session.send(sentinel, undefined, { peerFrom: 'Sender', peerText: sentinel, peerDeliveryId: deliveryId });
      await ended;
    } finally {
      clearTimeout(timer);
      stop();
    }
    if (events.slice(since).some(event => event.ev.event?.type === 'peer_delivery_accepted')) break;
    assert(events.slice(since).some(event => event.ev.event?.type === 'peer_delivery_rejected'));
  }
  const accepted = events.filter(event => event.ev.event?.type === 'peer_delivery_accepted').length;
  const rejected = events.filter(event => event.ev.event?.type === 'peer_delivery_rejected').length;
  const echoes = events.filter(event => event.ev.event?.type === 'peer_message').length;
  console.log(JSON.stringify({ submissions, accepted, rejected, echoes, occurrences }));
  assert.equal(submissions, failFirstWrite ? 2 : 1);
  assert.equal(accepted, 1);
  assert.equal(rejected, failFirstWrite ? 1 : 0);
  assert.equal(echoes, 1);
  assert.deepEqual(occurrences, [1], 'the native conversation must carry the instruction once');
} finally {
  const child = session?.child;
  const exited = child && child.exitCode === null && child.signalCode === null
    ? new Promise(resolve => child.once('close', resolve)) : Promise.resolve();
  session?.shutdown('delivery probe complete');
  await exited;
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
