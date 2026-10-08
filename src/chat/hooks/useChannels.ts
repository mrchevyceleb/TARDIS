// Channel data: the group-channel list plus create / patch / delete / post
// mutations. The rail section and the channel view both read from here; every
// mutation refreshes the shared queries so both stay in sync.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiJson } from '../../data/api';

export type Channel = { id: string; name: string; members: string[]; createdAt?: string; updatedAt?: string };
export type ChannelMessage = { id: string; channelId: string; from: string; text: string; createdAt?: string; updatedAt?: string };

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
    mutationFn: (input: { channelId: string; from: string; text: string }) =>
      channelRequest<{ message: ChannelMessage }>(`/${encodeURIComponent(input.channelId)}/messages`, 'POST', { from: input.from, text: input.text }),
    onSuccess: () => { refreshList(); refreshMessages(); },
  });

  return { create, patch, remove, post };
}