import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { apiJson } from '../../data/api';
import type { LiveSession } from '../data/types';

// Share one snapshot with the Desk: both surfaces must agree about who is
// in a turn, including background and account lanes. Never retain a working
// lamp after a failed poll. TanStack refreshes on focus and visibility.
export function useLive(): LiveSession[] {
  const query = useQuery({
    queryKey: ['live-sessions'],
    queryFn: () => apiJson<{ sessions: LiveSession[] }>('/api/live?activity=1', { signal: AbortSignal.timeout(8_000) }),
    refetchInterval: 4_000,
    refetchOnWindowFocus: 'always',
    retry: 1,
  });
  // Recompute age-based presence even when an unchanged payload is shared.
  return useMemo(() => query.isError ? [] : [...(query.data?.sessions ?? [])], [query.data, query.isError, query.dataUpdatedAt]);
}
