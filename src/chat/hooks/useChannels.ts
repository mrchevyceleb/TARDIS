// Channel data: the group-channel list plus create / patch / delete / post
// mutations. The rail section and the channel view both read from here; every
// mutation refreshes the shared queries so both stay in sync.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiJson } from '../../data/api';

export type Channel = { id: string; name: string; members: string[]; createdAt?: string; updatedAt?: string };
/** Image attachments land as file refs (the same attachment store as the
 *  main chat); the client renders them through /api/chat/attachments/<id>. */
export type ChannelMessage = { id: string; channelId: string; from: string; text: string; createdAt?: string; updatedAt?: string; images?: Array<{ id: string; mediaType: string }> };

async function channelRequest<T>(path: string, method: string, body?: unknown): Promise<T> {
  return apiJson<T>(`/api/channels${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** The server's JSON error body as a plain line for the UI. */
export function channelError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  try {
    const parsed = JSON.parse(raw) as { error?: string };
    if (typeof parsed.error === 'string' && parsed.error) return parsed.error;
  } catch { /* not JSON; use the raw line */ }
  return raw || 'That did not work.';
}

export function useChannels() {
  return useQuery({
    queryKey: ['channels'],
    queryFn: () => channelRequest<{ channels: Channel[] }>('', 'GET'),
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
}

export function useChannelMessages(channelId: string) {
  return useQuery({
    queryKey: ['channel-messages', channelId],
    queryFn: () => channelRequest<{ channel: { id: string; name: string }; messages: ChannelMessage[] }>(
      `/${encodeURIComponent(channelId)}/messages?limit=200`,
      'GET',
    ),
    staleTime: 5_000,
    refetchInterval: 8_000,
  });
}

/** Which members have a live busy turn right now, for the channel view's
 *  working state. react-query's refetchInterval handles the polling; the
 *  refetchOnWindowFocus default covers the throttled-background-tab case
 *  the same way useLive's visibility listener does. */
export type MemberActivity = { member: string; lane: 'main' | 'bg'; lastActivityMs: number; fromChannel: boolean };

export function useChannelLive(channelId: string) {
  return useQuery({
    queryKey: ['channel-live', channelId],
    queryFn: () => channelRequest<{ working: MemberActivity[] }>(`/${encodeURIComponent(channelId)}/live`, 'GET'),
    staleTime: 2_000,
    refetchInterval: 4_000,
  });
}

export function useChannelActions() {
  const queryClient = useQueryClient();
  const refreshList = () => { void queryClient.invalidateQueries({ queryKey: ['channels'] }); };
  const refreshMessages = () => { void queryClient.invalidateQueries({ queryKey: ['channel-messages'] }); };

  const create = useMutation({
    mutationFn: (input: { name: string; members: string[] }) => channelRequest<{ channel: Channel }>('', 'POST', input),
    onSuccess: refreshList,
  });
  const patch = useMutation({
    mutationFn: (input: { id: string; name?: string; addMembers?: string[]; removeMembers?: string[] }) =>
      channelRequest<{ channel: Channel }>(`/${encodeURIComponent(input.id)}`, 'PATCH', {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.addMembers === undefined ? {} : { addMembers: input.addMembers }),
        ...(input.removeMembers === undefined ? {} : { removeMembers: input.removeMembers }),
      }),
    onSuccess: refreshList,
  });
  const remove = useMutation({
    mutationFn: (id: string) => channelRequest<{ deleted: boolean }>(`/${encodeURIComponent(id)}`, 'DELETE'),
    onSuccess: refreshList,
  });
  const post = useMutation({
    mutationFn: (input: { channelId: string; from: string; text: string; person?: boolean; images?: Array<{ mediaType: string; base64: string }> }) =>
      channelRequest<{ message: ChannelMessage }>(`/${encodeURIComponent(input.channelId)}/messages`, 'POST', {
        from: input.from,
        text: input.text,
        person: input.person === true,
        ...(input.images?.length ? { images: input.images } : {}),
      }),
    onSuccess: () => {
      refreshList();
      refreshMessages();
      // Working chips are polled on a short interval; invalidate so a fresh
      // post's wake shows immediately instead of up to one poll later.
      void queryClient.invalidateQueries({ queryKey: ['channel-live'] });
    },
  });

  const stopMember = useMutation({
    mutationFn: (input: { channelId: string; member: string }) =>
      channelRequest<{ stopped: Array<'main' | 'bg'>; dropped: number }>(`/${encodeURIComponent(input.channelId)}/stop`, 'POST', {
        member: input.member,
      }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['channel-live'] }); },
  });

  return { create, patch, remove, post, stopMember };
}