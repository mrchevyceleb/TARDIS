// Who is online and who is mid-turn, from the one shared live poll. The rail,
// the room's team strip and the room chimes all read the same answer.

import { useMemo } from 'react';
import { useLive } from '../chat/hooks/useLive';
import { hasRecentTurnSignal } from '../chat/utils/livePresence';
import type { LiveSession } from '../chat/data/types';
import type { Agent } from './agents';

export type TeamPresence = { live: ReadonlySet<string>; busy: ReadonlySet<string>; anyBusy: boolean };

function laneAgent(agents: Agent[], s: LiveSession): Agent | undefined {
  const home = s.chatId.replace(/__acct__[a-z0-9-]+$/i, '').replace(/__bg$/, '');
  return agents.find((a) => (s.agentId ? s.agentId === a.id : home === a.home));
}

export function useTeamPresence(agents: Agent[]): TeamPresence {
  const sessions = useLive();
  return useMemo(() => {
    const live = new Set<string>();
    const busy = new Set<string>();
    for (const s of sessions) {
      const agent = laneAgent(agents, s);
      if (!agent) continue;
      live.add(agent.id);
      // Only lanes mid-turn: a stale busy flag without a recent signal is not work.
      if (hasRecentTurnSignal(s)) busy.add(agent.id);
    }
    return { live, busy, anyBusy: sessions.some((s) => s.busy) };
  }, [sessions, agents]);
}

/** The team in the order the person arranged it, pinned teammates first. */
export function teamOrder(agents: Agent[]): Agent[] {
  return [...agents.filter((a) => a.pinned), ...agents.filter((a) => !a.pinned)];
}
