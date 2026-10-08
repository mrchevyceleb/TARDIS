// Group channels: named rooms of teammates, Slack-style smallest version.
// A channel is a name plus member teammates; posts land in the channel's
// history for everyone. This file owns only the data (store + queries);
// fan-out delivery and reply routing layer on top of it later.

import { JsonStore } from '../lib/jsonStore.ts';
import { teamRoster } from './teamBus.ts';

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