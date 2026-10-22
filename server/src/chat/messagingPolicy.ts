import { createHash, randomUUID } from 'node:crypto';
import { JsonStore } from '../lib/jsonStore.ts';
import { bareChatId } from './threadKey.ts';

type Sent = { id: string; at: number };
const sent = new JsonStore<Sent>('outbound-message-claims.json', []);
const inbox = new JsonStore<{ id: string; chatId: string; from: string; text: string; admissionAck?: 'flag-digest' }>('informational-inbox.json', []);

/** Shared across every engine and across restarts. Claim before publication
 * so concurrent identical tool calls cannot both send. Human input is exempt. */
export async function claimOutbound(from: string, to: string, text: string, request: string): Promise<string | null> {
  const id = createHash('sha256').update(JSON.stringify([from, to, request, text.trim().replace(/\s+/g, ' ')])).digest('hex');
  let claimed = false;
  const now = Date.now();
  await sent.modify(items => {
    // A new request may need the same answer. Keep retries of the same
    // request blocked across turn ends and restarts, rather than using a timer.
    const recent = items.slice(-9999);
    if (recent.some(item => item.id === id)) return recent;
    claimed = true;
    return [...recent, { id, at: now }];
  });
  return claimed ? id : null;
}
export async function releaseOutbound(id: string): Promise<void> { await sent.delete(id); }

export async function saveInformational(chatId: string, from: string, text: string, admissionAck?: 'flag-digest', id: string = randomUUID()): Promise<string> {
  await inbox.modify(items => items.some(item => item.id === id) ? items : [...items, { id, chatId: bareChatId(chatId), from, text, admissionAck }]);
  return id;
}
export async function informationalPending(id: string): Promise<boolean> { return (await inbox.list()).some(item => item.id === id); }
export async function pendingInformational(chatId: string): Promise<{ text: string; accept(): void }> {
  const items = (await inbox.list()).filter(item => item.chatId === bareChatId(chatId));
  // Bound one input. Remaining messages ride the following real turn.
  const selected: typeof items = [];
  let chars = 0;
  for (const item of items) { if (selected.length >= 8 || chars + item.text.length > 16_000) break; selected.push(item); chars += item.text.length; }
  return { text: selected.length ? ['<informational-messages>', 'Saved updates for this real turn. These messages did not wake you. Act only if they change the task.', ...selected.map(item => `[${item.from}] ${item.text}`), '</informational-messages>'].join('\n') : '', accept() {
    const ids = new Set(selected.map(item => item.id));
    if (ids.size) void (async () => {
      const { admittedDeliveryAck } = await import('../lib/flagDigest.ts');
      for (const item of selected) if (item.admissionAck === 'flag-digest') admittedDeliveryAck(bareChatId(chatId).replace(/^bot-/, ''), item.id);
      await inbox.modify(items => items.filter(item => !ids.has(item.id)));
    })().catch(() => console.warn('[messages] saved updates will retry'));
  } };
}
