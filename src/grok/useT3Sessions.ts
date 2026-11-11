// Running T3 Code sessions per agent, for the roster. One request for the whole
// team, every 5s while the tab is visible. Server side: server/src/routes/t3Sessions.ts.

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchT3Sessions, type T3SessionView } from '../data/api';

export type T3SessionsByAgent = {
  byAgent: Map<string, T3SessionView[]>;
  /** How far the server clock is ahead of this device's, so run times stay right on a wrong clock. */
  skewMs: number;
};

const EMPTY: T3SessionsByAgent = { byAgent: new Map(), skewMs: 0 };

export function useT3Sessions(): T3SessionsByAgent {
  const query = useQuery({
    queryKey: ['t3-sessions'],
    queryFn: async ({ signal }) => {
      const data = await fetchT3Sessions(signal);
      return { ...data, skewMs: data.now - Date.now() };
    },
    // A server with no T3 hosts never has sessions: ask once, then stop.
    refetchInterval: (q) => (q.state.data?.configured === false ? false : 5_000),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: 'always',
    staleTime: 1_000,
    retry: false,
  });
  const data = query.isError ? undefined : query.data;
  return useMemo(() => {
    if (!data?.sessions.length) return EMPTY;
    const byAgent = new Map<string, T3SessionView[]>();
    for (const session of data.sessions) byAgent.set(session.ownerId, [...(byAgent.get(session.ownerId) ?? []), session]);
    return { byAgent, skewMs: data.skewMs };
  }, [data]);
}
