// /api/channels — group channels: named rooms of teammates. Store and API
// only in this cut: create, rename, membership, delete, post, history.
// Same tailnet-only trust model as the rest of /api.

import { Router } from 'express';
import { asyncHandler } from './helpers.ts';
import {
  CHANNEL_TEXT_LIMIT,
  channelHistory,
  createChannel,
  deliverChannelPost,
  deleteChannel,
  deleteChannelMessages,
  findChannel,
  listChannels,
  postChannelMessage,
  unknownTeammates,
  updateChannel,
} from '../chat/channels.ts';

export const channelsRouter = Router();

function invalidName(name: unknown): boolean {
  return typeof name !== 'string' || !name.trim() || name.trim().length > 80;
}

channelsRouter.get('/', asyncHandler(async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ channels: await listChannels() });
}));

channelsRouter.post('/', asyncHandler(async (req, res) => {
  const { name, members } = req.body ?? {};
  if (invalidName(name)) {
    res.status(400).json({ error: 'a channel needs a name (1-80 characters)' });
    return;
  }
  if (!Array.isArray(members) || members.some((m) => typeof m !== 'string')) {
    res.status(400).json({ error: 'members must be a list of teammate names' });
    return;
  }
  const unknown = await unknownTeammates(members);
  if (unknown.length) {
    res.status(400).json({ error: `not teammates: ${unknown.join(', ')}` });
    return;
  }
  const trimmed = name.trim();
  const conflict = (await listChannels()).some((channel) => channel.name.toLowerCase() === trimmed.toLowerCase());
  if (conflict) {
    res.status(409).json({ error: `a channel named ${trimmed} already exists` });
    return;
  }
  const unique = [...new Set(members.map((m) => m.trim()).filter(Boolean))];
  res.status(201).json({ channel: await createChannel(trimmed, unique) });
}));

channelsRouter.patch('/:id', asyncHandler(async (req, res) => {
  const channel = await findChannel(String(req.params.id));
  if (!channel) {
    res.status(404).json({ error: 'no such channel' });
    return;
  }
  const { name, addMembers, removeMembers } = req.body ?? {};
  const patch: { name?: string; members?: string[] } = {};
  if (name !== undefined) {
    if (invalidName(name)) {
      res.status(400).json({ error: 'a channel name is 1-80 characters' });
      return;
    }
    const trimmed = name.trim();
    const conflict = (await listChannels()).some((c) => c.id !== channel.id && c.name.toLowerCase() === trimmed.toLowerCase());
    if (conflict) {
      res.status(409).json({ error: `a channel named ${trimmed} already exists` });
      return;
    }
    patch.name = trimmed;
  }
  let members = channel.members;
  if (addMembers !== undefined) {
    if (!Array.isArray(addMembers) || addMembers.some((m) => typeof m !== 'string')) {
      res.status(400).json({ error: 'addMembers must be a list of teammate names' });
      return;
    }
    const unknown = await unknownTeammates(addMembers);
    if (unknown.length) {
      res.status(400).json({ error: `not teammates: ${unknown.join(', ')}` });
      return;
    }
    members = [...new Set([...members, ...addMembers.map((m) => m.trim()).filter(Boolean)])];
  }
  if (removeMembers !== undefined) {
    if (!Array.isArray(removeMembers) || removeMembers.some((m) => typeof m !== 'string')) {
      res.status(400).json({ error: 'removeMembers must be a list of teammate names' });
      return;
    }
    const gone = new Set(removeMembers.map((m) => m.trim()));
    members = members.filter((m) => !gone.has(m));
  }
  patch.members = members;
  const updated = await updateChannel(channel.id, patch);
  if (!updated) {
    res.status(404).json({ error: 'no such channel' });
    return;
  }
  res.json({ channel: updated });
}));

channelsRouter.delete('/:id', asyncHandler(async (req, res) => {
  const id = String(req.params.id);
  const channel = await findChannel(id);
  if (!channel) {
    res.status(404).json({ error: 'no such channel' });
    return;
  }
  // The channel goes first: a failure here leaves everything untouched,
  // while a failed history purge after a successful delete only leaves
  // unreachable rows (never a visible channel with its history erased).
  await deleteChannel(id);
  try {
    await deleteChannelMessages(id);
  } catch (error) {
    console.warn('[channels] history purge failed for deleted channel:', (error as Error).message);
  }
  res.json({ deleted: true });
}));

channelsRouter.get('/:id/messages', asyncHandler(async (req, res) => {
  const channel = await findChannel(String(req.params.id));
  if (!channel) {
    res.status(404).json({ error: 'no such channel' });
    return;
  }
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  res.setHeader('Cache-Control', 'no-store');
  res.json({ channel: { id: channel.id, name: channel.name }, messages: await channelHistory(channel.id, limit) });
}));

channelsRouter.post('/:id/messages', asyncHandler(async (req, res) => {
  const channel = await findChannel(String(req.params.id));
  if (!channel) {
    res.status(404).json({ error: 'no such channel' });
    return;
  }
  const { from, text } = req.body ?? {};
  if (typeof from !== 'string' || !from.trim()) {
    res.status(400).json({ error: 'from is required' });
    return;
  }
  if (typeof text !== 'string' || !text.trim()) {
    res.status(400).json({ error: 'text is required' });
    return;
  }
  if (text.length > CHANNEL_TEXT_LIMIT) {
    res.status(400).json({ error: `text is limited to ${CHANNEL_TEXT_LIMIT} characters` });
    return;
  }
  // The hop rides with agent replies (from the channel_post tool) so the
  // agent-to-agent cap can count hops across the whole fan-out chain.
  const hopInput = req.body?.hop;
  const receivedHop = Number.isFinite(Number(hopInput)) ? Math.max(0, Math.floor(Number(hopInput))) : 0;
  const message = await postChannelMessage(channel.id, from.trim(), text);
  // The post is already durable; a fan-out failure never fails the post.
  const fanOut = await deliverChannelPost(channel, from.trim(), text, receivedHop).catch((error) => {
    console.warn('[channels] fan-out failed:', (error as Error).message);
    return { delivered: [] as string[], skipped: channel.members, hop: 0 };
  });
  res.status(201).json({ message, fanOut });
}));