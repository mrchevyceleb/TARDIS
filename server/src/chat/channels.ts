// Group channels: named rooms of teammates, Slack-style smallest version.
// A channel is a name plus member teammates; posts land in the channel's
// history for everyone. This file owns only the data (store + queries);
// fan-out delivery and reply routing layer on top of it later.

import { JsonStore } from '../lib/jsonStore.ts';
import { deliverTeamMessage, teamRoster } from './teamBus.ts';

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

/** A deleted channel takes its history with it. */
export async function deleteChannelMessages(channelId: string): Promise<void> {
  await messages.replace((await messages.list()).filter((message) => message.channelId !== channelId));
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

/** Members whose names appear as @mentions in the text. */
export function mentionedMembers(text: string, members: string[]): string[] {
  return members.filter((member) =>
    new RegExp(`@${member.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`, 'i').test(text));
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
  const hop = isAgent ? Math.max(1, receivedHop) + 1 : 1;
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
  const historyBlock = earlier.length
    ? `\nEarlier in this channel:\n${earlier.map((m) => `${m.from}: ${m.text}`).join('\n')}\n`
    : '';
  const bundle =
    `[#${channel.name} group channel \u2014 handoff ${hop}] ${poster} posted:\n\n${text}\n\n${guidance}`
    + historyBlock;
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