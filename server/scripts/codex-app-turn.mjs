#!/usr/bin/env node

/**
 * One Codex turn over the app-server protocol.
 *
 * TARDIS used `codex exec`, whose stdin cannot accept a second prompt. That
 * made every teammate correction wait for the whole turn to finish. App-server
 * exposes `turn/steer`, so this adapter keeps the existing exec-style JSONL
 * event contract while accepting correlated steer requests on stdin.
 *
 * stdin line 1: { type: "start", ... }
 * later lines:  { type: "steer", requestId, text }
 * stdout: Codex exec-shaped events plus rivendell.steer.* acknowledgements.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

let pendingOutputWrites = 0;
let exitRequested = false;
let appExited = false;
let shutdownTimer = null;

function trackedWrite(stream, text) {
  pendingOutputWrites += 1;
  stream.write(text, () => {
    pendingOutputWrites = Math.max(0, pendingOutputWrites - 1);
    maybeExit();
  });
}

const writeEvent = (event) => trackedWrite(process.stdout, `${JSON.stringify(event)}\n`);
const writeError = (message) => {
  const text = String(message).trim();
  if (text) trackedWrite(process.stderr, `${text}\n`);
};

let app = null;
let appBuffer = '';
let nextRequestId = 1;
let activeTurnId = null;
let threadId = null;
let completed = false;
let targetExitCode = 1;
let lastUsage = null;
const pending = new Map();
const pendingSteers = [];
const steerAttempts = new Map();

function rejectPending(error) {
  for (const waiter of pending.values()) {
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.reject(error);
  }
  pending.clear();
  while (pendingSteers.length) {
    const steer = pendingSteers.shift();
    writeEvent({ type: 'rivendell.steer.rejected', request_id: steer.requestId, message: error.message });
  }
}

function request(method, params, timeoutMs = 120_000) {
  if (!app?.stdin.writable) return Promise.reject(new Error('Codex app-server is not writable'));
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    const timer = timeoutMs == null ? null : setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, timeoutMs);
    timer?.unref?.();
    pending.set(id, { resolve, reject, timer });
    app.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
      if (!error) return;
      const waiter = pending.get(id);
      if (!waiter) return;
      pending.delete(id);
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(error);
    });
  });
}

function notify(method, params = {}) {
  if (app?.stdin.writable) app.stdin.write(`${JSON.stringify({ method, params })}\n`);
}

function normalizeItem(item) {
  if (!item || typeof item !== 'object') return item;
  if (item.type === 'commandExecution') {
    return {
      ...item,
      type: 'command_execution',
      aggregated_output: item.aggregatedOutput ?? '',
      exit_code: item.exitCode ?? null,
    };
  }
  if (item.type === 'agentMessage') return { ...item, type: 'agent_message' };
  if (item.type === 'mcpToolCall') return { ...item, type: 'mcp_tool_call' };
  if (item.type === 'fileChange') return { ...item, type: 'file_change' };
  if (item.type === 'userMessage') return { ...item, type: 'user_message' };
  return item;
}

function normalizeUsage(tokenUsage) {
  const usage = tokenUsage?.last;
  if (!usage || typeof usage !== 'object') return null;
  return {
    input_tokens: Number(usage.inputTokens ?? 0),
    cached_input_tokens: Number(usage.cachedInputTokens ?? 0),
    output_tokens: Number(usage.outputTokens ?? 0),
  };
}

function signalApp(signal) {
  // Never signal pid <= 1: process.kill(-1) hits every process this user owns.
  if (!app || app.exitCode !== null || !app.pid || app.pid <= 1) return;
  try { app.kill(signal); } catch {}
  try { process.kill(-app.pid, signal); } catch {}
}

function maybeExit() {
  if (!exitRequested || !appExited || pendingOutputWrites > 0) return;
  input.close();
  process.stdin.pause();
  process.stdin.unref?.();
  process.exitCode = targetExitCode;
}

function finish(code) {
  if (completed) return;
  completed = true;
  exitRequested = true;
  targetExitCode = code;
  activeTurnId = null;
  rejectPending(new Error('Codex turn completed'));
  try { app?.stdin.end(); } catch {}
  signalApp('SIGTERM');
  shutdownTimer = setTimeout(() => signalApp('SIGKILL'), 3_000);
  shutdownTimer.unref?.();
  if (!app) appExited = true;
  maybeExit();
}

function handleNotification(message) {
  const method = message.method;
  const params = message.params ?? {};
  if (method === 'turn/started') {
    activeTurnId = params.turn?.id ?? activeTurnId;
    writeEvent({ type: 'turn.started' });
    return;
  }
  if (method === 'item/started') {
    writeEvent({ type: 'item.started', item: normalizeItem(params.item) });
    return;
  }
  if (method === 'item/completed') {
    writeEvent({ type: 'item.completed', item: normalizeItem(params.item) });
    return;
  }
  if (method === 'thread/tokenUsage/updated') {
    lastUsage = normalizeUsage(params.tokenUsage) ?? lastUsage;
    return;
  }
  if (method === 'error') {
    const detail = params.error?.message ?? params.error ?? 'Codex app-server error';
    writeError(typeof detail === 'string' ? detail : JSON.stringify(detail));
    return;
  }
  if (method === 'turn/completed') {
    const status = params.turn?.status;
    writeEvent({ type: 'turn.completed', ...(lastUsage ? { usage: lastUsage } : {}) });
    finish(status === 'completed' ? 0 : 1);
  }
}

function handleAppLine(raw) {
  if (!raw.trim()) return;
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  if (message.id !== undefined) {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (waiter.timer) clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
    else waiter.resolve(message.result);
    return;
  }
  if (typeof message.method === 'string') handleNotification(message);
}

async function sendSteer(requestId, text) {
  if (!activeTurnId || !threadId) {
    if (!pendingSteers.some((steer) => steer.requestId === requestId)) {
      pendingSteers.push({ requestId, text });
    }
    return;
  }

  let attempt = steerAttempts.get(requestId);
  if (!attempt) {
    // No protocol timeout here. A timeout after app-server accepted the input is
    // indistinguishable from failure and would make the durable team worker
    // retry the same message. Child/turn closure is the unambiguous deadline.
    attempt = request('turn/steer', {
      threadId,
      expectedTurnId: activeTurnId,
      clientUserMessageId: requestId,
      input: [{ type: 'text', text }],
    }, null).then(
      () => ({ ok: true }),
      (error) => ({ ok: false, message: error.message }),
    );
    steerAttempts.set(requestId, attempt);
  }
  const outcome = await attempt;
  writeEvent(outcome.ok
    ? { type: 'rivendell.steer.accepted', request_id: requestId }
    : { type: 'rivendell.steer.rejected', request_id: requestId, message: outcome.message });
}

async function flushPendingSteers() {
  while (activeTurnId && pendingSteers.length) {
    const steer = pendingSteers.shift();
    await sendSteer(steer.requestId, steer.text);
  }
}

async function start(config) {
  app = spawn(config.codexBin, config.appServerArgs, {
    cwd: config.cwd,
    env: process.env,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  app.stdout.setEncoding('utf8');
  app.stdout.on('data', (chunk) => {
    appBuffer += chunk;
    let newline = appBuffer.indexOf('\n');
    while (newline !== -1) {
      handleAppLine(appBuffer.slice(0, newline));
      appBuffer = appBuffer.slice(newline + 1);
      newline = appBuffer.indexOf('\n');
    }
  });
  app.stdout.on('end', () => {
    if (appBuffer.trim()) handleAppLine(appBuffer);
    appBuffer = '';
  });
  app.stderr.setEncoding('utf8');
  app.stderr.on('data', (chunk) => writeError(chunk));
  app.on('error', (error) => {
    writeError(`Codex app-server spawn failed: ${error.message}`);
    rejectPending(error);
    finish(1);
  });
  app.on('close', (code, signal) => {
    appExited = true;
    if (shutdownTimer) clearTimeout(shutdownTimer);
    shutdownTimer = null;
    if (!completed) {
      const error = new Error(`Codex app-server exited before turn completion (${code ?? signal ?? 'unknown'})`);
      writeError(error.message);
      rejectPending(error);
      completed = true;
      targetExitCode = typeof code === 'number' && code !== 0 ? code : 1;
    }
    exitRequested = true;
    maybeExit();
  });

  await request('initialize', {
    clientInfo: { name: 'rivendell', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  });
  notify('initialized');

  let thread;
  if (config.threadId) {
    const resumed = await request('thread/resume', {
      threadId: config.threadId,
      cwd: config.cwd,
      model: config.model,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      excludeTurns: true,
    });
    thread = resumed.thread;
  } else {
    const started = await request('thread/start', {
      cwd: config.cwd,
      model: config.model,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      historyMode: 'legacy',
      ephemeral: false,
      developerInstructions: 'Do not use Codex native collaboration agents for TARDIS companion handoffs. TARDIS supplies its own team_message MCP.',
    });
    thread = started.thread;
  }
  threadId = thread?.id;
  if (!threadId) throw new Error('Codex app-server did not return a thread id');
  writeEvent({ type: 'thread.started', thread_id: threadId });

  const input = [
    ...(config.imagePaths ?? []).map((path) => ({ type: 'localImage', path })),
    { type: 'text', text: config.prompt },
  ];
  const turn = await request('turn/start', {
    threadId,
    input,
    model: config.model,
    effort: config.effort,
    approvalPolicy: 'never',
    sandboxPolicy: { type: 'dangerFullAccess' },
  });
  activeTurnId = turn.turn?.id ?? activeTurnId;
  await flushPendingSteers();
}

const input = createInterface({ input: process.stdin });
let started = false;
input.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (!started && message.type === 'start') {
    started = true;
    void start(message).catch((error) => {
      writeError(error.stack ?? error.message);
      finish(1);
    });
    return;
  }
  if (started && message.type === 'steer' && typeof message.requestId === 'string' && typeof message.text === 'string') {
    void sendSteer(message.requestId, message.text);
  }
});
input.on('close', () => {
  if (completed) return;
  completed = true;
  exitRequested = true;
  targetExitCode = 1;
  activeTurnId = null;
  rejectPending(new Error('TARDIS closed the Codex adapter input'));
  signalApp('SIGTERM');
  shutdownTimer = setTimeout(() => signalApp('SIGKILL'), 3_000);
  shutdownTimer.unref?.();
  if (!app) appExited = true;
  maybeExit();
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (completed) return;
    completed = true;
    exitRequested = true;
    targetExitCode = 1;
    activeTurnId = null;
    rejectPending(new Error(`Codex adapter received ${signal}`));
    signalApp(signal);
    shutdownTimer = setTimeout(() => signalApp('SIGKILL'), 3_000);
    shutdownTimer.unref?.();
    if (!app) appExited = true;
    maybeExit();
  });
}
