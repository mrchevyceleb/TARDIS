import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from './config.ts';
import { agentForChatId } from './agents.ts';
import { listCommitments } from '../lib/commitmentStore.ts';
import { readDesk } from '../lib/deskStore.ts';
import { prioritiesBlockFor } from '../lib/prioritiesStore.ts';

/** Status belongs at the end of new input, never above the cached prefix.
 * Persist fingerprints so a process restart does not repeat the same status. */
export async function sessionStateDelta(chatId: string): Promise<string> {
  const agent = agentForChatId(chatId);
  if (!agent) return '';
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
  changed('priorities', priorities, `Priorities changed: ${priorities.replace(/\s+/g, ' ').slice(0, 220) || 'none'}. Use the priorities tool for details.`);
  try {
    const commitments = listCommitments(agent.id);
    changed('commitments', JSON.stringify(commitments), `Open commitments changed: ${commitments.length}. Read commitments before making or resuming a promise.`);
  } catch { /* uncertainty is not an empty store */ }
  try {
    const desk = await readDesk();
    const cards = desk.cards.filter(card => card.owner.kind === 'agent' && card.owner.id === agent.id && card.column !== 'in_production');
    changed('cards', JSON.stringify(cards.map(card => [card.id, card.title, card.column])), `Owned cards changed: ${cards.length}. ${cards.filter(card => card.column === 'in_progress').slice(0, 2).map(card => `${card.id}: ${card.title.slice(0, 95)}`).join('; ')} Read the Desk for current state.`);
  } catch { /* leave the previous fingerprint intact */ }
  if (lines.length) {
    mkdirSync(directory, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
    renameSync(tmp, file);
  }
  return lines.join('\n');
}
