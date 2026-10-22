import { pendingInformational, publishContextReceipt } from './messagingPolicy.ts';
import { pendingEngineHandover } from './engineHandover.ts';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from './config.ts';
import { agentForChatId, brainForAgent, cliForAgentEngine } from './agents.ts';
import { listCommitments } from '../lib/commitmentStore.ts';
import { readDesk } from '../lib/deskStore.ts';
import { prioritiesBlockFor } from '../lib/prioritiesStore.ts';

const generations = new Map<string, number>();
let acceptanceWrites = Promise.resolve();

export function resetSessionStateDelta(chatId: string): void {
  const agent = agentForChatId(chatId);
  if (agent) {
    generations.set(agent.id, (generations.get(agent.id) ?? 0) + 1);
    rmSync(join(STATE_DIR, 'native-session-context', `${agent.id}.json`), { force: true });
  }
}

/** Status belongs at the end of new input, never above the cached prefix.
 * Persist fingerprints so a process restart does not repeat the same status. */
export async function prepareSessionStateDelta(chatId: string): Promise<{ text: string; accept(): void }> {
  await acceptanceWrites;
  const agent = agentForChatId(chatId);
  if (!agent) return { text: '', accept() {} };
  const generation = generations.get(agent.id) ?? 0;
  const directory = join(STATE_DIR, 'native-session-context');
  const file = join(directory, `${agent.id}.json`);
  let before: Record<string, string> = {};
  try { before = JSON.parse(readFileSync(file, 'utf8')); } catch { /* first delivery */ }
  const next = { ...before };
  const lines: string[] = [];
  const changed = (name: string, value: string, line: string) => {
    const hash = createHash('sha256').update(value).digest('hex');
    if (before[name] !== hash) { next[name] = hash; lines.push(line); }
  };
  const priorities = prioritiesBlockFor(agent.id);
  changed('priorities', priorities, 'Priorities changed. Use the priorities tool for current state.');
  try {
    const commitments = listCommitments(agent.id);
    changed('commitments', JSON.stringify(commitments), `Open commitments changed: ${commitments.length}. Read commitments before making or resuming a promise.`);
  } catch { /* uncertainty is not an empty store */ }
  try {
    const desk = await readDesk();
    const cards = desk.cards.filter(card => card.owner.kind === 'agent' && card.owner.id === agent.id && card.column !== 'in_production');
    changed('cards', JSON.stringify(cards.map(card => [card.id, card.title, card.column])), `Owned cards changed: ${cards.length}; ${cards.filter(card => card.column === 'in_progress').length} in progress. Read the Desk for current state.`);
  } catch { /* leave the previous fingerprint intact */ }
  const handover = await pendingEngineHandover(chatId);
  const informational = await pendingInformational(chatId);
  const brain = brainForAgent(agent);
  const receipt = JSON.stringify([brain.engine, brain.model, brain.effort]);
  next.modelReceipt = receipt;
  next.modelReceiptEngine = cliForAgentEngine(brain.engine);
  return { text: [handover.text, informational.text, ...lines].filter(Boolean).join('\n'), accept() {
    handover.accept();
    informational.accept();
    // Native admission proves this is the model actually taking the turn.
    acceptanceWrites = acceptanceWrites.then(async () => {
      if ((generations.get(agent.id) ?? 0) !== generation) return;
      let current: Record<string, string> = {};
      try { current = JSON.parse(readFileSync(file, 'utf8')); } catch { /* first receipt */ }
      if (current.modelReceipt !== receipt) await publishContextReceipt(chatId, { type: '_engine_switch',
        from: handover.from || current.modelReceiptEngine || '', to: next.modelReceiptEngine, model: brain.model, ts: Date.now() });
      if ((generations.get(agent.id) ?? 0) !== generation) return;
      mkdirSync(directory, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
      renameSync(tmp, file);
    }).catch(() => console.warn('[native-session] status acknowledgement could not be saved; changes will be delivered again'));
  } };
}
