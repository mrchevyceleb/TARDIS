// The team MCP's lane token (Nov 12 2026). Every rivendell-team MCP carries a
// token minted for the roster id it was spawned for, so a route that acts on
// a caller's teammate id (only Max lifts quiet hours) can tell Max's own MCP
// from a call that merely names him. Kept per installation, like the headless
// and computer tokens, so an engine that outlives a restart keeps its MCP: it stops a mistaken call or a lane borrowing
// another's identity; it is not a sandbox between lanes that run as the same
// OS user.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { stableSecret } from '../lib/continuity.ts';

export const TEAM_TOKEN_HEADER = 'x-rivendell-team-token';

const secret = stableSecret('team-lane-token');

export function teamLaneToken(agentId: string): string {
  return createHmac('sha256', secret).update(`team:${agentId}`).digest('hex');
}

export function validTeamLaneToken(value: string | undefined, agentId: string): boolean {
  const got = Buffer.from(value ?? '');
  const want = Buffer.from(teamLaneToken(agentId));
  return got.length === want.length && timingSafeEqual(got, want);
}
