import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// This file exercises account rollover, so isolate every profile lookup before
// importing runner/accountResolver. Unit tests must never inspect a developer's
// login or verify a real token against Anthropic.
const testRoot = mkdtempSync(join(tmpdir(), 'tardis-runner-background-'));
const testHome = join(testRoot, 'home');
const accountMap = join(testRoot, 'accounts.json');
mkdirSync(testHome, { recursive: true });
const testClaudeProfile = join(testHome, '.claude-test');
mkdirSync(testClaudeProfile, { recursive: true });
writeFileSync(join(testClaudeProfile, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'test@example.com', organizationUuid: 'org-test' } }));
writeFileSync(join(testClaudeProfile, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'synthetic-test-pass' } }));
writeFileSync(accountMap, JSON.stringify({
  accounts: { test: { claude_config_dir: '.claude-test', codex_home: '.codex-test' } },
  default_account: 'test', rules: [],
}));
const savedEnv = {
  home: process.env.HOME, map: process.env.RIVENDELL_ACCOUNT_MAP, state: process.env.RIVENDELL_STATE_DIR,
  defaultAccount: process.env.RIVENDELL_DEFAULT_CLI_ACCOUNT, agentAccounts: process.env.RIVENDELL_AGENT_ACCOUNTS,
  pools: process.env.RIVENDELL_CLAUDE_ACCOUNT_POOLS,
};
process.env.HOME = testHome;
process.env.RIVENDELL_ACCOUNT_MAP = accountMap;
process.env.RIVENDELL_STATE_DIR = join(testRoot, 'state');
delete process.env.RIVENDELL_DEFAULT_CLI_ACCOUNT;
delete process.env.RIVENDELL_AGENT_ACCOUNTS;
delete process.env.RIVENDELL_CLAUDE_ACCOUNT_POOLS;
mkdirSync(process.env.RIVENDELL_STATE_DIR, { recursive: true });

const { ClaudeSession } = await import('./runner.ts');
const { preferredSubscriptionEnv, subscriptionRoutingKey, subscriptionRoutingKeysMatch } = await import('../lib/cliProfiles.ts');

test.after(() => {
  if (savedEnv.home === undefined) delete process.env.HOME; else process.env.HOME = savedEnv.home;
  if (savedEnv.map === undefined) delete process.env.RIVENDELL_ACCOUNT_MAP; else process.env.RIVENDELL_ACCOUNT_MAP = savedEnv.map;
  if (savedEnv.state === undefined) delete process.env.RIVENDELL_STATE_DIR; else process.env.RIVENDELL_STATE_DIR = savedEnv.state;
  if (savedEnv.defaultAccount === undefined) delete process.env.RIVENDELL_DEFAULT_CLI_ACCOUNT; else process.env.RIVENDELL_DEFAULT_CLI_ACCOUNT = savedEnv.defaultAccount;
  if (savedEnv.agentAccounts === undefined) delete process.env.RIVENDELL_AGENT_ACCOUNTS; else process.env.RIVENDELL_AGENT_ACCOUNTS = savedEnv.agentAccounts;
  if (savedEnv.pools === undefined) delete process.env.RIVENDELL_CLAUDE_ACCOUNT_POOLS; else process.env.RIVENDELL_CLAUDE_ACCOUNT_POOLS = savedEnv.pools;
  rmSync(testRoot, { recursive: true, force: true });
});

test('pooled account redirects do not look like picker changes', () => {
  const { session } = harness();
  const cwd = process.cwd();
  const chatId = 'pool-routing-regression';
  const preferredKey = subscriptionRoutingKey('claude', preferredSubscriptionEnv('claude', cwd, chatId));
  assert.equal(preferredKey.endsWith(':not-signed-in') || preferredKey.endsWith(':signed-out'), false,
    'the synthetic mapped login resolves to a definite healthy identity');
  Object.assign(session, {
    cli: 'claude', cwd, chatId,
    preferredAccountRoutingKey: preferredKey,
    providerRoutingKey: 'claude-an-automatic-pool-redirect:different-account',
  });
  assert.doesNotThrow(() => session.assertSubscriptionAccount());

  const profileKey = preferredKey.slice(0, preferredKey.lastIndexOf(':'));
  assert.equal(subscriptionRoutingKeysMatch(`${profileKey}:not-signed-in`, `${profileKey}:healthy-account`), true,
    'a transient identity read must keep the healthy worker');
  session.preferredAccountRoutingKey = `${profileKey}:not-signed-in`;
  assert.doesNotThrow(() => session.assertSubscriptionAccount(),
    'the real session boundary tolerates only the transient unknown identity');
  assert.equal(subscriptionRoutingKeysMatch(`${profileKey}:signed-out`, `${profileKey}:healthy-account`), false,
    'a confirmed sign-out must retire the old worker');

  session.preferredAccountRoutingKey = 'claude-the-previous-explicit-choice:old-account';
  assert.throws(() => session.assertSubscriptionAccount(), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'MODEL_SELECTION_CHANGED');
    return true;
  });
});

test('account rollover keeps the lane, native resume ID and pending teammate receipts', async () => {
  const { session, events } = harness();
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    stdin: { end: () => setImmediate(() => { child.exitCode = 0; child.emit('close'); }) },
  });
  const prompt = { text: 'Finish the task', images: [{ mediaType: 'image/png', base64: 'test' }], opts: { peerFrom: 'Tester', peerDeliveryId: 'delivery-1', peerFromRole: 'teammate' } };
  const origin = { peers: [{ name: 'Tester', role: 'teammate', text: prompt.text }], human: false, automation: false };
  Object.assign(session, {
    cli: 'claude', cwd: process.cwd(), chatId: 'bot-test', logKey: 'test-account-rollover', child,
    currentSessionId: 'saved-native-id', nativeStopGeneration: 0,
    turnStartedAt: Date.now(), accountRerunPrompt: prompt, turnOrigin: origin,
    endBackgroundWork: () => {},
    pendingPeerInputs: new Map([
      ['delivery-1', { nativeInputId: 'delivery-1', steering: false, text: prompt.text }],
      ['delivery-2', { nativeInputId: 'delivery-2', steering: true, text: 'Keep the queued guidance', images: prompt.images, from: 'Other tester' }],
    ]),
    pendingAccountInputs: [{ text: 'Keep the human guidance too' }],
  });
  let resumed: string | undefined;
  session.startWorker = (id: string) => { resumed = id; };
  session.send = async (text: string, images: unknown, opts: Record<string, unknown>) => {
    assert.match(text, /Continue the pending request/);
    assert.match(text, /Finish the task/, 'a re-keyed initial delivery is included in the continuation');
    assert.match(text, /Keep the queued guidance/);
    assert.match(text, /Keep the human guidance too/);
    assert.deepEqual(images, prompt.images);
    assert.equal(opts.peerDeliveryId, 'delivery-1');
    assert.equal(opts.accountRerun, true);
    assert.equal(opts.accountRerunOrigin, origin);
    assert.equal(session.pendingPeerInputs.has('delivery-1'), true);
    assert.equal(session.pendingPeerInputs.has('delivery-2'), true);
  };
  const rerun = session.retryOnAccount({ message: 'full', usageLimit: true });
  assert.equal(session.isBusy(), true);
  await rerun;
  assert.equal(resumed, 'saved-native-id');
  assert.equal(session.accountSwitching, false);
  assert.deepEqual(events, [], 'no failure, rejected receipt, closed event or false turn boundary');
});

test('steering waits through account rollover; explicit Stop cancels its restart', async () => {
  const { session, events } = harness();
  Object.assign(session, { accountSwitching: true, nativeStopGeneration: 0, shutdown: () => { session.disposed = true; } });
  assert.equal(await session.interrupt('message-boundary'), true);
  assert.equal(session.disposed, false);
  assert.equal(session.nativeStopGeneration, 0);
  assert.equal(await session.interrupt('interruptSession'), false);
  assert.equal(session.disposed, true);
  assert.equal(session.nativeStopGeneration, 1);
  assert.equal(events.at(-1)?.type, 'turnEnd');
});

test('usage-limit results enter asynchronous recovery before emitting a failure or rejecting a handoff', () => {
  const { session, events } = harness();
  Object.assign(session, {
    cli: 'claude', chatId: 'bot-limit-test', providerAccount: '/tmp/test-profile',
    compactFailure: null, syntheticApiErrorReason: null, turnStartedAt: Date.now(),
    accountRerunPrompt: { text: 'Pending request', opts: {} },
    pendingPeerInputs: new Map([['waiting-delivery', { nativeInputId: 'waiting-delivery', steering: false, text: 'Pending request' }]]),
  });
  let recovering = false;
  session.recoverAccountLimit = (error: { usageLimit: boolean }) => { recovering = error.usageLimit; };
  session.handleEvent({ type: 'result', is_error: true, result: "You've hit your session limit · resets 5pm (UTC)" });
  assert.equal(recovering, true);
  assert.equal(session.pendingPeerInputs.has('waiting-delivery'), true);
  assert.deepEqual(events, []);
});

test('a late usage-limit result cannot replay a completed turn', () => {
  const { session } = harness();
  Object.assign(session, {
    cli: 'claude', chatId: 'bot-late-limit-test', providerAccount: '/tmp/test-profile',
    compactFailure: null, syntheticApiErrorReason: null, turnStartedAt: null,
    accountRerunPrompt: { text: 'Already completed', opts: {} },
  });
  let recovering = false;
  session.recoverAccountLimit = () => { recovering = true; };
  session.handleEvent({ type: 'result', is_error: true, result: "You've hit your session limit · resets 5pm (UTC)" });
  assert.equal(recovering, false);
  assert.equal(session.accountRerunPrompt, null);
});

test('account retry handles a worker that closed before quota refresh finished', async () => {
  const { session, events } = harness();
  Object.assign(session, {
    workerClosed: true, cli: 'claude', cwd: process.cwd(), chatId: 'bot-already-closed', logKey: 'test-already-closed', nativeStopGeneration: 0,
    child: { exitCode: 0 }, currentSessionId: null, startedResumeId: null,
    accountRerunPrompt: { text: 'Pending request', opts: {} },
    endBackgroundWork: () => {}, startWorker: () => {}, send: async () => {},
  });
  await session.retryOnAccount({ message: 'full', usageLimit: true });
  assert.deepEqual(events, []);
});

test('staying on the current account drains post-limit worker output in order', () => {
  const { session } = harness();
  const seen: string[] = [];
  Object.assign(session, {
    accountSwitching: true,
    accountSwitchStdout: ['{"type":"later-stdout"}\n'],
    accountSwitchStderr: ['later-stderr'],
    deferredAccountExit: null,
    handleEvent: (event: { type: string }, handled: boolean) => { seen.push(handled ? `result:${handled}` : `stdout:${event.type}`); },
    onStderr: (chunk: string) => { seen.push(`stderr:${chunk}`); },
    finishDeferredAccountExit: () => { seen.push('exit'); },
  });
  session.keepCurrentAccountAfterLimit({ type: 'result' });
  assert.deepEqual(seen, ['result:true', 'stdout:later-stdout', 'stderr:later-stderr', 'exit']);
});

test('stdout lines after a usage result in the same chunk enter the rollover buffer', () => {
  const { session } = harness();
  const seen: string[] = [];
  Object.assign(session, {
    accountSwitching: false,
    accountSwitchStdout: [],
    stdoutBuf: '',
    handleEvent: (event: { n: number }) => {
      seen.push(String(event.n));
      if (event.n === 1) session.accountSwitching = true;
    },
  });
  session.onStdout('{"n":1}\n{"n":2}\n');
  assert.deepEqual(seen, ['1']);
  assert.deepEqual(session.accountSwitchStdout, ['{"n":2}\n']);
  assert.equal(session.stdoutBuf, '');
});

// Exercise the real event handler without spawning a CLI or writing a transcript.
function harness() {
  const events: Array<{ type: string }> = [];
  const session = Object.assign(Object.create(ClaudeSession.prototype), {
    cli: 'xai', disposed: false, turnStartedAt: null,
    activeToolIds: new Set(), streamTextBlocks: new Map(), pendingPeerInputs: new Map(), pendingAccountInputs: [], statusAcks: [], compactFailure: null, accountSwitchStdout: [], accountSwitchStderr: [], stdoutBuf: '',
    emit: (event: { type: string }) => events.push(event),
    trackStreamText: () => {}, persistAppliedSelection: () => {},
    maybeCompact: async () => {},
  });
  return { session, events };
}

test('a native input receipt survives an HTTP 503 without delivering the handoff again', () => {
  const { session, events } = harness();
  const deliveryId = '00000000-0000-4000-8000-000000000001';
  let submissions = 0;
  // The native CLI saves and acknowledges the input BEFORE the API fails.
  // Reproduce the durable outbox retrying precisely when the runner rejects it.
  for (let attempt = 0; attempt < 5; attempt++) {
    const start = events.length;
    submissions++;
    session.pendingPeerInputs.set(deliveryId, { nativeInputId: deliveryId, text: 'Check the release once', steering: false });
    session.turnStartedAt = Date.now();
    session.handleEvent({ type: 'user', isReplay: true, uuid: deliveryId, parent_tool_use_id: null,
      message: { role: 'user', content: 'Check the release once' } });
    session.handleEvent({ type: 'result', is_error: true, api_error_status: 503 });
    if (!events.slice(start).some((e: any) => e.event?.type === 'peer_delivery_rejected')) break;
  }
  assert.equal(submissions, 1, 'a failed generation must not resubmit a saved native input');
  assert.equal(events.filter((e: any) => e.event?.type === 'peer_delivery_accepted').length, 1);
  assert.equal(events.some((e: any) => e.event?.type === 'peer_delivery_rejected'), false);
  assert.equal(events.some((e: any) => e.event?.type === '_terminal_error'), true, 'execution failure stays visible');
});

test('an unrelated failed query cannot reject an input still awaiting its receipt', () => {
  const { session, events } = harness();
  const deliveryId = '00000000-0000-4000-8000-000000000002';
  const input = { nativeInputId: deliveryId, steering: false, text: 'Deliver after recovery' };
  session.pendingPeerInputs.set(deliveryId, input);
  session.handleEvent({ type: 'result', is_error: true, api_error_status: 503 });
  assert.equal(session.pendingPeerInputs.has(deliveryId), true, 'query failure says nothing about pending input admission');
  assert.equal(events.filter((e: any) => e.event?.type === 'peer_delivery_rejected').length, 0);
  session.handleEvent({ type: 'user', isReplay: true, uuid: deliveryId });
  assert.equal(events.filter((e: any) => e.event?.type === 'peer_delivery_accepted').length, 1);
  assert.equal(session.pendingPeerInputs.size, 0);
});

test('only the matching root input receipt accepts a pending handoff', () => {
  const { session, events } = harness();
  session.turnStartedAt = 1;
  for (const deliveryId of ['first', 'second']) {
    session.pendingPeerInputs.set(deliveryId, { nativeInputId: deliveryId, steering: true, text: deliveryId });
  }
  session.handleEvent({ type: 'assistant', message: { content: [] } });
  session.handleEvent({ type: 'user', uuid: 'first' });
  session.handleEvent({ type: 'user', isReplay: true, uuid: 'first', parent_tool_use_id: 'child' });
  session.handleEvent({ type: 'user', isReplay: true, uuid: 'unrelated' });
  assert.equal(session.pendingPeerInputs.size, 2, 'another response, tool result or child cannot acknowledge this input');
  session.handleEvent({ type: 'user', isReplay: true, uuid: 'first' });
  session.handleEvent({ type: 'user', isReplay: true, uuid: 'first' });
  assert.deepEqual(events.filter((e: any) => e.event?.type === 'peer_delivery_accepted').map((e: any) => e.event.deliveryId), ['first']);
  assert.deepEqual([...session.pendingPeerInputs.keys()], ['second']);
});

test('native monitor query becomes busy, tracks the tool window, and ends normally', () => {
  const { session, events } = harness();
  session.handleEvent({ type: 'system', subtype: 'task_started', task_id: 'monitor' });
  session.handleEvent({ type: 'system', subtype: 'task_notification', task_id: 'monitor' });
  assert.equal(session.isBusy(), false);
  session.handleEvent({ type: 'system', subtype: 'status', status: 'requesting' });
  assert.equal(session.isBusy(), true);
  assert.equal(session.turnPromptSubmitted, true);
  assert.equal(session.activeToolIds.size, 0);
  session.handleEvent({ type: 'stream_event', event: { type: 'message_start' } });
  session.handleEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1' }] } });
  assert.equal(session.activeToolIds.size, 1);
  assert.equal(session.canAcceptNativeHumanSteer(), false); // never native: see canAcceptNativeHumanSteer
  assert.equal(events.filter(e => e.type === 'turnStart').length, 1);
  session.handleEvent({ type: 'result', subtype: 'success' });
  assert.equal(session.isBusy(), false);
  assert.equal(events.at(-1)?.type, 'turnEnd');
  session.handleEvent({ type: 'system', subtype: 'status', status: 'requesting' });
  assert.equal(session.isBusy(), true);
  assert.equal(events.filter(e => e.type === 'turnStart').length, 2);
});

test('stream tool_use opens the tool window without a completed assistant message', () => {
  const { session } = harness();
  session.handleEvent({ type: 'stream_event', event: { type: 'message_start' } });
  assert.equal(session.isBusy(), true);
  assert.equal(session.activeToolIds.size, 0);
  session.handleEvent({
    type: 'stream_event',
    event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tool-stream-1' } },
  });
  assert.equal(session.activeToolIds.size, 1);
  assert.equal(session.canAcceptNativeHumanSteer(), false); // never native: see canAcceptNativeHumanSteer
  session.handleEvent({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tool-stream-1' }] },
  });
  assert.equal(session.activeToolIds.size, 0);
});

test('content starts native turns on older CLIs without resetting an admitted human turn', () => {
  for (const event of [
    { type: 'stream_event', event: { type: 'message_start' } },
    { type: 'assistant', message: { content: [] } },
  ]) {
    const { session, events } = harness();
    session.handleEvent(event);
    assert.equal(session.isBusy(), true);
    assert.equal(events[0]?.type, 'turnStart');
    session.turnStartedAt = 42;
    session.automationTurn = true;
    session.handleEvent(event);
    assert.equal(session.turnStartedAt, 42);
    assert.equal(session.automationTurn, true);
    assert.equal(events.filter(e => e.type === 'turnStart').length, 1);
  }
});

// A provider's own recovery prompt must never look like a completed tool.
// Teammate delivery also cannot take a human's turn before its visible reply.
function boundaryHarness(human = false) {
  const { session, events } = harness();
  Object.assign(session, {
    child: { exitCode: null }, turnStartedAt: Date.now(),
    boundaryInterruptWanted: true, boundaryWaiters: 1,
    boundaryHumanWaiters: human ? 1 : 0, lastBoundaryInterruptAt: 0,
    automationTurn: false, pausedForMessage: false,
    nudgeForReply: () => {},
  });
  let interrupts = 0;
  session.interrupt = async () => { interrupts++; return true; };
  return { session, events, interrupted: () => interrupts };
}
const nextBoundary = () => new Promise<void>((resolve) => setImmediate(resolve));

test('native recovery nudges and unrelated tool results cannot trigger queued interruption', async () => {
  const { session, interrupted } = boundaryHarness();
  session.handleEvent({ type: 'user', message: { content: [{ type: 'text', text: 'No visible output, continue the same task.' }] } });
  session.handleEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'unknown' }] } });
  await nextBoundary();
  assert.equal(interrupted(), 0);
  assert.equal(session.boundaryInterruptWanted, true);
});

test('queued teammate waits until the admitted human has a visible answer', async () => {
  const { session, interrupted } = boundaryHarness();
  session.watchReply().arm();
  session.activeToolIds.add('before-answer');
  session.handleEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'before-answer' }] } });
  await nextBoundary();
  assert.equal(interrupted(), 0);
  session.handleEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'Your answer stays here.' }] } });
  session.activeToolIds.add('after-answer');
  session.handleEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'after-answer' }] } });
  await nextBoundary();
  assert.equal(interrupted(), 1);
});

test('a newer human still steers safely at the actual completed-tool boundary', async () => {
  const { session, interrupted } = boundaryHarness(true);
  session.watchReply().arm();
  session.activeToolIds.add('first'); session.activeToolIds.add('second');
  session.handleEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'first' }] } });
  await nextBoundary();
  assert.equal(interrupted(), 0);
  session.handleEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'second' }] } });
  await nextBoundary();
  assert.equal(interrupted(), 1);
});

test('a queued teammate cannot suppress the still-owed human reply nudge', async () => {
  const { session, interrupted } = boundaryHarness();
  delete session.nudgeForReply;
  const watch = session.watchReply(); watch.arm();
  for (let n = 0; n < 5; n++) watch.noteTool('tool-'+n);
  let nudges = 0; session.deliverReplyNudge = async () => { nudges++; };
  session.nudgeForReply();
  await nextBoundary();
  assert.equal(interrupted(), 1);
  assert.equal(nudges, 1);
});


test('account switching consumes fragmented native receipts before replacing the worker', () => {
  const { session, events } = harness();
  let echoes = 0;
  session.accountSwitching = true;
  session.pendingPeerInputs.set('delivery', { nativeInputId: 'attempt', steering: true, text: 'Once', echo: () => echoes++ });
  session.onStdout('{"type":"user","isReplay":true,"uuid":"att');
  session.onStdout('empt"}\n{"type":"result","is_error":true}\n');
  assert.equal(session.pendingPeerInputs.size, 0);
  assert.equal(echoes, 1);
  assert.equal(events.filter((e: any) => e.event?.type === 'peer_delivery_accepted').length, 1);
  assert.deepEqual(session.accountSwitchStdout, ['{"type":"result","is_error":true}\n']);
});

test('staying on an account preserves complete queued events and the trailing partial stdout line', () => {
  const { session } = harness();
  session.accountSwitching = true;
  session.onStdout('{"type":"marker","n":1}\n{"type":"mark');
  const seen: number[] = [];
  session.handleEvent = (event: { n?: number }) => { if (event.n) seen.push(event.n); };
  session.finishDeferredAccountExit = () => {};
  session.keepCurrentAccountAfterLimit({ type: 'result' });
  session.onStdout('er","n":2}\n');
  assert.deepEqual(seen, [1, 2], 'replaying complete frames must not consume or prefix the trailing fragment');
  assert.equal(session.stdoutBuf, '');
});

test('a late receipt for a failed attempt cannot accept the retry of the same delivery', () => {
  const { session, events } = harness();
  session.pendingPeerInputs.set('delivery', { nativeInputId: 'attempt-1', text: 'Once' });
  session.settleNativePeerInput('attempt-1', false);
  session.pendingPeerInputs.set('delivery', { nativeInputId: 'attempt-2', text: 'Once' });
  session.handleEvent({ type: 'user', isReplay: true, uuid: 'attempt-1' });
  assert.equal(session.pendingPeerInputs.has('delivery'), true);
  assert.equal(events.filter((e: any) => e.event?.type === 'peer_delivery_accepted').length, 0);
  session.handleEvent({ type: 'user', isReplay: true, uuid: 'attempt-2' });
  assert.equal(session.pendingPeerInputs.size, 0);
  assert.equal(events.filter((e: any) => e.event?.type === 'peer_delivery_accepted').length, 1);
});
