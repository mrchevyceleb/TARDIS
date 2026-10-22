import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { glob, open } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonStore } from '../lib/jsonStore.ts';
import { accountEnv, accountEnvForAccount, accountForAgent, accountFromChatId } from '../lib/accountResolver.ts';
import { agentForChatId, brainForAgent, cliForAgentEngine } from './agents.ts';
import { bareChatId, isAgentThread } from './threadKey.ts';
import { resolveCodexBin } from './codex-models.ts';
import { codexHomeFor } from './codex-threads.ts';
import type { CliKind } from './runner.ts';

type Handover = { id: string; chatId: string; sourceId: string; target: string; note?: string; failed?: boolean; savedConversation?: boolean; accepted?: boolean; selectionRevision?: number };
const store = new JsonStore<Handover>('native-engine-handovers.json', []);
const HANDOVER_MARKER = 'This is the single handover-only request authorized for this model switch.';
const HANDOVER_PAUSED = 'The previous model did not finish its handover. Your history is safe. This switch is paused for recovery, so another attempt cannot charge you again.';
export const nativeEngine = (cli: string): string => ['codex', 'codex-personal'].includes(cli) ? 'codex'
  : ['claude', 'assistant', 'zai', 'xai', 'fireworks', 'openrouter', 'openrouter2'].includes(cli) ? 'claude-code' : cli;

export function isSelectedEngineChanged(error: unknown): boolean {
  return (error as { code?: string })?.code === 'MODEL_SELECTION_CHANGED';
}

/** A retained socket/worker must never submit work to a deselected engine. */
export function assertSelectedEngine(chatId: string, cli: string): void {
  const agent = agentForChatId(chatId);
  if (agent && cliForAgentEngine(brainForAgent(agent).engine) !== cli) {
    throw Object.assign(new Error('Your model changed. I’ll use the selected model for this message.'), { code: 'MODEL_SELECTION_CHANGED' });
  }
}

/** The attempted marker lands BEFORE the billed request. An ambiguous failure
 * retains history and work, rather than automatically buying another export. */
export async function saveEngineHandover(opts: { chatId: string; sourceId: string; sourceRevision: number; target: CliKind }, makeNote: () => Promise<string>, recoverNote?: () => Promise<string | undefined>, savedConversation?: () => Promise<string>): Promise<void> {
  const chatId = bareChatId(opts.chatId);
  const target = nativeEngine(opts.target);
  const selectionRevision = agentForChatId(chatId)?.brainRevision ?? 0;
  const id = createHash('sha256').update(`${chatId}|${opts.sourceId}|${opts.sourceRevision}|${target}|${selectionRevision}`).digest('hex');
  let record: Handover | undefined;
  let claimed = false;
  await store.modify(items => {
    record = items.find(item => item.id === id || (item.chatId === chatId && item.sourceId === opts.sourceId && !item.accepted));
    if (record) {
      record = { ...record, target, ...(record.note ? { failed: false } : {}) };
      return items.map(item => item.id === record!.id ? record! : item);
    }
    claimed = true;
    record = { id, chatId, sourceId: opts.sourceId, target, selectionRevision };
    return [...items.filter(item => item.chatId !== chatId || item.accepted), record!];
  });
  const recover = async (recordId: string): Promise<boolean> => {
    const native = await recoverNote?.().catch(() => undefined);
    let conversation: string | undefined;
    try { conversation = native ? undefined : await savedConversation?.(); }
    catch (error) {
      if ((error as { handoverBlocked?: boolean }).handoverBlocked) throw error;
      return false;
    }
    const note = (native || conversation)?.trim();
    if (!note || note.length > 64_000) return false;
    await store.update(recordId, { note, failed: false, savedConversation: !native });
    return true;
  };
  if (!claimed) {
    if (!record?.note) {
      if (!await recover(record!.id)) throw new Error(record?.failed ? HANDOVER_PAUSED : 'The handover is still pending. Your history is safe; another paid attempt will not start.');
    }
    return;
  }
  let noteProduced = false;
  try {
    const note = (await makeNote()).trim();
    noteProduced = true;
    if (!note || note.length > 64_000) throw new Error('Invalid handover note');
    await store.update(id, { note });
  } catch (cause) {
    if ((cause as { handoverBlocked?: boolean }).handoverBlocked) {
      if (!noteProduced && !(cause as { billed?: boolean }).billed) await store.delete(id);
      throw cause;
    }
    if (noteProduced || (cause as { billed?: boolean }).billed === true) {
      if (await recover(id)) return;
      await store.update(id, { failed: true });
      throw new Error(HANDOVER_PAUSED, { cause });
    }
    else if (await recover(id)) return;
    else await store.delete(id);
    throw new Error('The handover note could not be saved. Your history and queued messages are safe; the old model will not run more work.', { cause });
  }
}

/** A lost CLI receipt must not buy a second export. Recover only an answer
 * written after our exact handover prompt in this original native thread. */
export async function recoverCodexHandover(opts: { chatId: string; cwd: string; sessionId: string; nativeProfile?: string }): Promise<string | undefined> {
  if (!/^[a-f0-9-]{36}$/i.test(opts.sessionId)) return;
  const agent = agentForChatId(opts.chatId);
  const account = accountFromChatId(opts.chatId) ?? accountForAgent(agent?.name);
  const env = account ? accountEnvForAccount(account, opts.cwd) : accountEnv(opts.cwd);
  const profile = opts.nativeProfile || codexHomeFor(env);
  for await (const file of glob(`sessions/*/*/*/rollout-*-${opts.sessionId}.jsonl`, { cwd: profile })) {
    const handle = await open(join(profile, file), 'r');
    let tail: string;
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - 4 * 1024 * 1024);
      const buffer = Buffer.alloc(size - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      tail = buffer.toString('utf8', 0, bytesRead);
      if (start) tail = tail.slice(tail.indexOf('\n') + 1);
    } finally { await handle.close(); }
    let exporting = false;
    let note: string | undefined;
    for (const line of tail.split('\n')) {
      if (!line.trim()) continue;
      let event: any;
      try { event = JSON.parse(line); } catch { continue; }
      const payload = event.payload;
      if (event.type === 'response_item' && payload?.role === 'user') {
        exporting = JSON.stringify(payload.content).includes(HANDOVER_MARKER);
        note = undefined;
      }
      if (exporting && event.type === 'response_item' && payload?.role === 'assistant' && payload.type === 'message') {
        const text = (payload.content ?? []).filter((item: any) => item.type === 'output_text').map((item: any) => item.text).join('\n').trim();
        if (text) note = text;
      }
      if (exporting && note && event.type === 'event_msg' && payload?.type === 'task_complete') return note;
    }
  }
}

export async function pendingEngineHandover(chatId: string): Promise<{ text: string; accept(): void }> {
  if (!isAgentThread(chatId)) return { text: '', accept() {} };
  const agent = agentForChatId(chatId);
  const target = agent ? nativeEngine(cliForAgentEngine(brainForAgent(agent).engine)) : '';
  const record = (await store.list()).find(item => item.chatId === bareChatId(chatId) && item.target === target && !item.accepted && item.note);
  return { text: record ? `<native-engine-handover>\n${record.savedConversation ? 'The previous model could not finish its note. Continue from the saved conversation below without another paid handover. The full original history is retained.' : 'Continue the same conversation from this handover.'} Preserve its decisions and check current state before acting.\n${record.note}\n</native-engine-handover>` : '', accept() {
    if (record) void store.update(record.id, { accepted: true }).catch(() => console.warn('[handover] acknowledgement will retry'));
  } };
}

/** Exactly one read-only, bounded request on the original Codex thread. No
 * user config, MCP servers, shell tools, hooks, or task execution are loaded. */
export async function exportCodexHandover(opts: { chatId: string; cwd: string; sessionId: string; model?: string; nativeProfile?: string }): Promise<string> {
  const agent = agentForChatId(opts.chatId);
  const account = accountFromChatId(opts.chatId) ?? accountForAgent(agent?.name);
  const env = account ? accountEnvForAccount(account, opts.cwd) : accountEnv(opts.cwd);
  if (opts.nativeProfile) env.CODEX_HOME = opts.nativeProfile;
  const args = ['exec', 'resume', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--json',
    '--disable', 'multi_agent', '--disable', 'shell_tool', '--disable', 'apply_patch_freeform',
    '-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"', '-c', 'sandbox_mode="read-only"',
    '-c', 'approval_policy="never"', '-c', 'web_search="disabled"', '-c', 'mcp_servers={}',
    '-c', 'model_reasoning_effort="low"', '-c', 'model_max_output_tokens=1600',
    ...(opts.model ? ['-m', opts.model] : []), opts.sessionId, '-'];
  return new Promise((resolve, reject) => {
    const child = spawn(resolveCodexBin(), args, { cwd: opts.cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = ''; let note = ''; let completed = false; let settled = false; let billed = false;
    const stop = () => { if (child.pid && child.pid > 1) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } };
    const done = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(Object.assign(error, { billed })) : resolve(note); };
    const timer = setTimeout(() => { stop(); done(new Error('Codex handover timed out')); }, 90_000);
    timer.unref();
    child.stderr.resume(); // Provider errors may contain private text; never log them.
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 256_000) { stop(); done(new Error('Codex handover output exceeded its limit')); return; }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const event = JSON.parse(line);
          if (event.type === 'thread.started' && event.thread_id !== opts.sessionId) { stop(); done(new Error('Codex did not resume the saved thread')); }
          if (event.type === 'item.completed' && event.item?.type === 'agent_message') note = String(event.item.text ?? '');
          if (event.type === 'turn.started') billed = true;
          if (event.type === 'turn.completed') completed = true;
          if (['item.started', 'item.completed'].includes(event.type) && ['command_execution', 'mcp_tool_call', 'file_change', 'web_search'].includes(event.item?.type)) { stop(); done(new Error('Codex attempted work during its handover')); }
        } catch { /* Ignore non-event diagnostic lines. */ }
      }
    });
    child.stdin.on('error', error => done(error));
    child.once('error', error => done(error));
    child.once('close', code => done(code === 0 && completed && note.trim() ? undefined : new Error('Codex did not complete its handover')));
    child.stdin.end(`Write ONLY a plain handover note for the next engine, at most 350 words. Include the current task and why, decisions and constraints, files/branches/cards touched, actual completed results, and the next unfinished action. Do not continue work, call any tool, send messages, read files, or make changes. Do not include credentials or secrets. ${HANDOVER_MARKER}`);
  });
}
