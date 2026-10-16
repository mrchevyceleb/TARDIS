// /api/channels — group channels: named rooms of teammates. Store and API
// only in this cut: create, rename, membership, delete, post, history.
// Same tailnet-only trust model as the rest of /api.

import { Router } from 'express';
import { asyncHandler } from './helpers.ts';
import {
  CHANNEL_TEXT_LIMIT,
  channelHistory,
  channelMemberActivity,
  createChannel,
  deliverChannelPost,
  deleteChannel,
  deleteChannelMessages,
  findChannel,
  listChannels,
  postChannelMessage,
  stopChannelMember,
  unknownTeammates,
  updateChannel,
} from '../chat/channels.ts';
import { saveChatAttachments } from './chatAttachments.ts';
import { teamRoster } from '../chat/teamBus.ts';
import { DESK_OWNER_NAME } from '../config.ts';

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

channelsRouter.get('/:id/live', asyncHandler(async (req, res) => {
  const channel = await findChannel(String(req.params.id));
  if (!channel) {
    res.status(404).json({ error: 'no such channel' });
    return;
  }
  // Working state for the channel view: which members have a live busy
  // turn right now (either lane) and whether it is this channel's work.
  // Polled, so no-store keeps it fresh.
  res.setHeader('Cache-Control', 'no-store');
  res.json({ working: await channelMemberActivity(channel.id, channel.members) });
}));

channelsRouter.post('/:id/stop', asyncHandler(async (req, res) => {
  const channel = await findChannel(String(req.params.id));
  if (!channel) {
    res.status(404).json({ error: 'no such channel' });
    return;
  }
  const { member } = req.body ?? {};
  if (typeof member !== 'string' || !member.trim()) {
    res.status(400).json({ error: 'member is required' });
    return;
  }
  const name = member.trim();
  if (!channel.members.includes(name)) {
    res.status(404).json({ error: `${name} is not a member of this channel` });
    return;
  }
  try {
    const { stopped, dropped } = await stopChannelMember(channel.id, name);
    res.json({ stopped, dropped });
  } catch (error) {
    // A gone member (left the roster but still on the channel) is a miss,
    // not a server fault; anything else is a real failure and must not hide
    // behind a 404 (review finding 6).
    if (/no teammate named/.test((error as Error).message)) {
      res.status(404).json({ error: (error as Error).message });
      return;
    }
    console.error('[channels] stop failed:', error);
    res.status(500).json({ error: `could not stop ${name}: ${(error as Error).message}` });
  }
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
  if (typeof text !== 'string') {
    res.status(400).json({ error: 'text is required' });
    return;
  }
  if (text.length > CHANNEL_TEXT_LIMIT) {
    res.status(400).json({ error: `text is limited to ${CHANNEL_TEXT_LIMIT} characters` });
    return;
  }
  const hasRawImages = Array.isArray(req.body?.images) && req.body.images.length > 0;
  if (!text.trim() && !hasRawImages) {
    res.status(400).json({ error: 'text is required' });
    return;
  }
  // The hop rides with agent replies (from the channel_post tool) so the
  // agent-to-agent cap can count hops across the whole fan-out chain.
  const hopInput = req.body?.hop;
  const receivedHop = Number.isFinite(Number(hopInput)) ? Math.max(0, Math.floor(Number(hopInput))) : 0;
  // Images ride the same attachment store as the main chat (Matt, Oct 16:
  // channels work exactly like the main chat): saveChatAttachments applies
  // the identical caps, whitelist, and magic-byte checks, never throws, and
  // drops anything invalid one image at a time.
  const attachmentRefs = await saveChatAttachments(req.body?.images);
  if (hasRawImages && attachmentRefs.length < req.body.images.length) {
    res.status(400).json({ error: 'image attachment could not be saved (unsupported format, over 6 images, or over the 12 MB / 24 MB limit)' });
    return;
  }
  // Person-hood is an explicit flag the owner's UI sends, decided on the
  // flag alone so a customized owner name cannot silently disable steering
  // (the client always sends the default display name); when it holds, the
  // configured owner name is stamped as the poster. A roster name carrying
  // the flag fails closed to agent treatment, so an agent cannot post
  // itself into person class. Best-effort within the same tailnet-only
  // trust model as the rest of /api, not a cryptographic signal (review 3,
  // P1 5 and P2 8): the agent MCP sends its own name and no flag.
  const wantsPerson = req.body?.person === true;
  const posterIsRoster = (await teamRoster()).some((agent) => agent.name === from.trim());
  const person = wantsPerson && !posterIsRoster;
  const poster = person ? DESK_OWNER_NAME : from.trim();
  const message = await postChannelMessage(channel.id, poster, text, attachmentRefs.length ? attachmentRefs : undefined);
  // The post is already durable; a fan-out failure never fails the post.
  const fanOut = await deliverChannelPost(
    channel,
    poster,
    text,
    receivedHop,
    person,
    attachmentRefs.length ? attachmentRefs : undefined,
  ).catch((error) => {
    console.warn('[channels] fan-out failed:', (error as Error).message);
    return { delivered: [] as string[], skipped: channel.members, hop: 0 };
  });
  res.status(201).json({ message, fanOut });
}));