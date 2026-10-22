import { createHash, randomUUID } from 'node:crypto';
import { JsonStore } from '../lib/jsonStore.ts';
import { bareChatId, logKeyFor } from './threadKey.ts';
import { ELROND_WORKSPACE_PATH } from '../config.ts';
import { appendEventLogDurable, flushEventLog, loadEventLogTail, reserveEventLogSeq } from './event-log-store.ts';

type Sent = { id: string; claims?: string[] };
const sent = new JsonStore<Sent>('outbound-message-claims.json', []);
type Information = { id: string; chatId: string; from: string; text: string; admissionAck?: 'flag-digest'; visible?: boolean };
const inbox = new JsonStore<Information>('informational-inbox.json', []);
let acceptanceWrites = Promise.resolve();

export function acknowledgementOnly(text: string, addressees: string[] = []): boolean {
  let value = text.trim();
  for (const name of addressees) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    value = value.replace(new RegExp(`,\\s*${escaped}[.!\\s]*$`, 'i'), '');
  }
  const emojiOnly = /^[👍🙏👌✅🙌👏🙂😊\s.!]+$/u.test(value);
  value = value.replace(/[👍🙏👌✅🙌👏🙂😊]/gu, '').replace(/[.,!;:]+/g, ' ').trim();
  return emojiOnly || /^(?:(?:done|thanks?(?: you)?|got it|noted|ack(?:nowledged)?|ok(?:ay)?|no_update|sounds good|will do|understood)(?:\s+|$))+$/i.test(value);
}

export async function publishContextReceipt(chatId: string, event: Record<string, unknown>): Promise<void> {
  const key = logKeyFor('claude', ELROND_WORKSPACE_PATH, bareChatId(chatId));
  const row = { seq: reserveEventLogSeq(key), at: Date.now(), ev: { type: 'event' as const, event } };
  await appendEventLogDurable(key, row);
  const { publishExternalThreadEvent } = await import('./runner.ts');
  publishExternalThreadEvent(key, row);
}

/** Shared across every engine and across restarts. Claim before publication
 * so concurrent identical tool calls cannot both send. Human input is exempt. */
export async function claimOutbound(from: string, to: string, text: string, request: string, acknowledgement = acknowledgementOnly(text)): Promise<string | null> {
  const normalized = acknowledgement ? '<acknowledgement>' : text.trim().replace(/\s+/g, ' ');
  const id = createHash('sha256').update(JSON.stringify([from, to, request, normalized])).digest('hex');
  let claimed = false;
  await sent.modify(items => {
    const owner = `sender:${from}`;
    const claims = items.find(item => item.id === owner)?.claims ?? [];
    if (claims.includes(id)) return items;
    claimed = true;
    // A small bounded bucket per sender; retries cannot grow a global ledger.
    return [...items.filter(item => item.id.startsWith('sender:') && item.id !== owner).slice(-63), { id: owner, claims: [...claims.slice(-127), id] }];
  });
  return claimed ? id : null;
}
export async function releaseOutbound(id: string): Promise<void> {
  await sent.modify(items => items.map(item => ({ ...item, claims: item.claims?.filter(claim => claim !== id) })));
}

export async function saveInformational(chatId: string, from: string, text: string, admissionAck?: 'flag-digest', id: string = randomUUID()): Promise<string> {
  await inbox.modify(items => items.some(item => item.id === id) ? items : [...items, { id, chatId: bareChatId(chatId), from, text, admissionAck }]);
  const item = (await inbox.list()).find(item => item.id === id)!;
  await publishSavedInformation(item);
  return id;
}

async function publishSavedInformation(item: Information): Promise<void> {
  if (item.visible) return;
  const key = logKeyFor('claude', ELROND_WORKSPACE_PATH, item.chatId);
  await flushEventLog(key);
  const exists = (await loadEventLogTail(key)).events.some(row => row.ev?.type === 'event' && row.ev.event?.deliveryId === item.id);
  if (!exists) {
    const row = { seq: reserveEventLogSeq(key), at: Date.now(), ev: { type: 'event' as const,
      event: { type: 'peer_message', from: item.from, fromRole: 'informational', startsTurn: false, deliveryId: item.id, text: item.text, ts: Date.now() } } };
    await appendEventLogDurable(key, row);
    const { publishExternalThreadEvent } = await import('./runner.ts');
    publishExternalThreadEvent(key, row);
  }
  await inbox.update(item.id, { visible: true });
}

export async function legacyActionableInformation(): Promise<Information[]> {
  return (await inbox.list()).filter(item => item.admissionAck === 'flag-digest' || item.from === 'Desk' && /Quiet check:/i.test(item.text));
}
export async function removeSavedInformation(id: string): Promise<void> { await inbox.delete(id); }
export async function informationalPending(id: string): Promise<boolean> { return (await inbox.list()).some(item => item.id === id); }
export async function pendingInformational(chatId: string): Promise<{ text: string; accept(): void }> {
  await acceptanceWrites;
  const saved = (await inbox.list()).filter(item => item.chatId === bareChatId(chatId));
  const empty = new Set(saved.filter(item => !item.admissionAck && acknowledgementOnly(item.text)).map(item => item.id));
  if (empty.size) await inbox.modify(items => items.filter(item => !empty.has(item.id)));
  const items = saved.filter(item => !empty.has(item.id));
  for (const item of items) await publishSavedInformation(item);
  // Bound one input. Remaining messages ride the following real turn.
  const selected: typeof items = [];
  let chars = 0;
  for (const item of items) { if (selected.length >= 8 || chars + item.text.length > 16_000) break; selected.push(item); chars += item.text.length; }
  return { text: selected.length ? ['<informational-messages>', 'Saved updates for this real turn. These messages did not wake you. Act only if they change the task.', ...selected.map(item => `[${item.from}] ${item.text}`), '</informational-messages>'].join('\n') : '', accept() {
    const ids = new Set(selected.map(item => item.id));
    if (ids.size) acceptanceWrites = acceptanceWrites.then(async () => {
      const { admittedDeliveryAck } = await import('../lib/flagDigest.ts');
      for (const item of selected) if (item.admissionAck === 'flag-digest') admittedDeliveryAck(bareChatId(chatId).replace(/^bot-/, ''), item.id);
      for (const item of selected) await publishContextReceipt(item.chatId, { type: 'peer_delivery_accepted', deliveryId: item.id, ts: Date.now() });
      await inbox.modify(items => items.filter(item => !ids.has(item.id)));
    }).catch(() => console.warn('[messages] saved updates will retry'));
  } };
}
