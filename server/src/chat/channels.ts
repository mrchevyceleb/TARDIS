// Group channels: named rooms of teammates, Slack-style smallest version.
// A channel is a name plus member teammates; posts land in the channel's
// history for everyone. This file owns only the data (store + queries);
// fan-out delivery and reply routing layer on top of it later.

import { JsonStore } from '../lib/jsonStore.ts';
import { MAX_TEXT, deliverTeamMessage, teamRoster } from './teamBus.ts';

export type Channel = { id: string; name: string; members: string[]; createdAt?: string; updatedAt?: string };
export type ChannelMessage = { id: string; channelId: string; from: string; text: string; createdAt?: string; updatedAt?: string };

/** One channel post is bounded, like every other write surface here. */
export const CHANNEL_TEXT_LIMIT = 20_000;

const channels = new JsonStore<Channel>('channels.json', []);
const messages = new JsonStore<ChannelMessage>('channel-messages.json', []);

/** Names in the list that are not teammates (empty when all are known). */
export async function unknownTeammates(names: string[]): Promise<string[]> {
  const roster = await teamRoster();
  const known = new Set(roster.map((agent) => agent.name));
  return names.filter((name) => !known.has(name));
}

export async function listChannels(): Promise<Channel[]> {
  return channels.list();
}

export async function findChannel(id: string): Promise<Channel | null> {
  return (await channels.list()).find((channel) => channel.id === id) ?? null;
}

export async function createChannel(name: string, members: string[]): Promise<Channel> {
  return channels.create({ name, members });
}

export async function updateChannel(id: string, patch: Partial<Channel>): Promise<Channel | null> {
  return channels.update(id, patch);
}

export async function deleteChannel(id: string): Promise<boolean> {
  return channels.delete(id);
}

/** A deleted channel takes its history with it. One atomic read-modify-write
 * so a post landing mid-purge cannot be erased by a stale list. */
export async function deleteChannelMessages(channelId: string): Promise<void> {
  await messages.modify((items) => items.filter((message) => message.channelId !== channelId));
}

export async function postChannelMessage(channelId: string, from: string, text: string): Promise<ChannelMessage> {
  return messages.create({ channelId, from, text });
}

/** Most recent history, oldest first, capped. */
export async function channelHistory(channelId: string, limit: number): Promise<ChannelMessage[]> {
  const rows = (await messages.list()).filter((message) => message.channelId === channelId);
  rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return rows.slice(-limit);
}

// ---------------------------------------------------------------------------
// Fan-out delivery. A post always lands in history for everyone; delivery
// decides who is actually woken.

/** Matt's own post is hop 1; up to 3 agent-to-agent hops may follow it. */
export const CHANNEL_HOP_CAP = 4;

/** Members whose names appear as @mentions in the text. Longer names match
 * first, so @Sam Wise never also wakes a member named Sam. */
export function mentionedMembers(text: string, members: string[]): string[] {
  if (!members.length) return [];
  const sorted = [...members].sort((a, b) => b.length - a.length);
  const pattern = `@(?:${sorted.map((member) => member.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\w])`;
  const re = new RegExp(pattern, 'gi');
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const raw = match[0].slice(1);
    const member = sorted.find((m) => m.length === raw.length && m.toLowerCase() === raw.toLowerCase());
    if (member) seen.add(member);
  }
  return sorted.filter((member) => seen.has(member));
}

export type ChannelFanOut = { delivered: string[]; skipped: string[]; hop: number; capped?: boolean };

/** Deliver one channel post to whoever should hear it: the post with recent
 *  history and the reply rules. The poster's own post (a human posting) wakes
 *  every member; an agent's reply wakes only the members it @mentions, one hop
 *  deeper, and never past the cap. A capped reply still lands in history but
 *  wakes no one. Fan-out failures are collected, never thrown at the caller. */
export async function deliverChannelPost(channel: Channel, poster: string, text: string, receivedHop: number): Promise<ChannelFanOut> {
  const roster = await teamRoster();
  const isAgent = roster.some((agent) => agent.name === poster);
  // Matt's own post is hop 1. An agent reply must carry the hop number from
  // its ping; a missing or invalid hop fails closed (history only, wakes no
  // one) so the fan-out cap can never be reset by omitting it.
  const hop = isAgent
    ? (Number.isFinite(receivedHop) && receivedHop >= 1
      ? Math.min(Math.floor(receivedHop), CHANNEL_HOP_CAP) + 1
      : CHANNEL_HOP_CAP + 1)
    : 1;
  const mentioned = mentionedMembers(text, channel.members);
  const targets = !isAgent
    ? channel.members
    : hop > CHANNEL_HOP_CAP ? [] : mentioned;
  const earlier = (await channelHistory(channel.id, 9)).slice(0, -1);
  const guidance =
    `Reply in the channel with the channel_post tool (channel: "${channel.id}", from: "${isAgent ? poster : 'your own name'}"),`
    + ' including the hop number from this ping. Include @Name to address one member; only they need to answer.'
    + ' Without an @, answer only if the message is for you or you have something real to add;'
    + ' if nothing is needed from you, stay silent (do not reply at all, never send NO_UPDATE).'
    + ' Channel talk stays in the channel; never move it into a one-on-one thread.';
  const header = `[#${channel.name} group channel \u2014 handoff ${hop}] ${poster} posted:\n\n`;
  // The delivered bundle must fit MAX_TEXT with the reply rules intact, so
  // the post text is clamped (with a visible note) and the history block is
  // clamped per message and dropped first when there is no room.
  const truncationNote = '\n(post text truncated for delivery; the full text is in the channel history)\n';
  const roomForText = MAX_TEXT - header.length - guidance.length - 2;
  const textPart = text.length > roomForText
    ? `${text.slice(0, Math.max(0, roomForText - truncationNote.length))}${truncationNote}`
    : text;
  let historyBlock = '';
  if (earlier.length) {
    let used = header.length + textPart.length + guidance.length + 2;
    const kept: string[] = [];
    for (const m of earlier) {
      const line = `${m.from}: ${m.text.length > 400 ? `${m.text.slice(0, 400)}\u2026` : m.text}`;
      if (used + line.length + 2 > MAX_TEXT) break;
      kept.push(line);
      used += line.length + 1;
    }
    historyBlock = kept.length ? `\nEarlier in this channel:\n${kept.join('\n')}\n` : '';
  }
  const bundle = `${header}${textPart}\n\n${guidance}` + historyBlock;
  const delivered: string[] = [];
  const skipped: string[] = [];
  for (const member of targets) {
    try {
      const result = await deliverTeamMessage({
        from: poster,
        to: member,
        text: bundle,
        source: 'channel',
        channel: { id: channel.id, name: `#${channel.name}` },
        hop,
        priority: !isAgent && mentioned.includes(member) ? true : undefined,
        wait: false,
      });
      if (result.delivered) delivered.push(member);
      else skipped.push(member);
    } catch {
      skipped.push(member);
    }
  }
  return { delivered, skipped, hop, ...(isAgent && hop > CHANNEL_HOP_CAP ? { capped: true } : {}) };
}