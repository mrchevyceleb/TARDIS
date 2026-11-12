// /api/quiet-hours — who works through the overnight quiet window: the
// standing exceptions, plus time-boxed passes (Matt, Nov 12 2026;
// lib/quietPasses.ts). Matt lifts quiet hours for a teammate from the app;
// Max does it on Matt's say through the team MCP's quiet_hours tool. No
// other teammate may.

import { Router, type Request, type Response } from 'express';
import { asyncHandler } from './helpers.ts';
import { DESK_OWNER_NAME } from '../config.ts';
import { listAgents, type Agent } from '../chat/agents.ts';
import { TEAM_TOKEN_HEADER, validTeamLaneToken } from '../chat/teamToken.ts';
import { hasStandingQuietExemption, inQuietHours, isMaxLane, quietWindowEnds } from '../lib/quietHours.ts';
import { trustedRequestOrigin } from '../lib/origin.ts';
import { activeQuietPass, endQuietPass, grantQuietPass, listQuietPasses, QuietPassError, type QuietPass } from '../lib/quietPasses.ts';

export const quietHoursRouter = Router();

/** A teammate's quiet hours as /api/agents shows them: always worked
 *  through (a standing exception), or lifted until `until`. Absent means
 *  the window holds their overnight work. */
export type AgentQuietHours = { standing?: true; until?: string; reason?: string; grantedBy?: string };

export function agentQuietHours(agentId: string): AgentQuietHours | undefined {
  if (hasStandingQuietExemption(agentId)) return { standing: true };
  const pass = activeQuietPass(agentId);
  return pass ? { until: pass.until, reason: pass.reason, grantedBy: pass.grantedBy } : undefined;
}

function teammate(ref: unknown, roster: Agent[] = listAgents()): Agent | undefined {
  if (typeof ref !== 'string' || !ref.trim()) return undefined;
  const needle = ref.trim().toLowerCase();
  return roster.find((a) => a.id === needle) ?? roster.find((a) => a.name.trim().toLowerCase() === needle);
}

/** An instant with an explicit zone. A bare wall-clock time would silently
 *  mean the server's zone, so it is refused rather than guessed. */
const INSTANT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;

function instant(value: unknown): number | undefined {
  if (typeof value !== 'string' || !INSTANT.test(value.trim())) return undefined;
  const ms = Date.parse(value.trim().replace(' ', 'T'));
  return Number.isFinite(ms) ? ms : undefined;
}

/** Who is lifting: Max's own team MCP (the caller id it sends plus the lane
 *  token TARDIS minted for that id, chat/teamToken.ts), or Matt in the app
 *  through the house owner guard that Integrations, Content and Dictation
 *  use: a same-origin browser request from a trusted Origin, which also shuts
 *  out DNS rebinding. It refuses a teammate's ordinary calls and every web
 *  page. Like those desks, it is not a guard against a process that forges
 *  browser headers under the owner's own OS account: TARDIS has no app login,
 *  and loopback is the security boundary. */
function lifter(req: Request, res: Response): string | undefined {
  const agentRef: unknown = req.body?.agent;
  if (agentRef !== undefined) {
    const callerId = typeof agentRef === 'string' ? agentRef.trim() : '';
    if (isMaxLane(callerId) && validTeamLaneToken(req.get(TEAM_TOKEN_HEADER), callerId)) {
      return listAgents().find((a) => a.id === callerId)?.name ?? 'Max';
    }
    res.status(403).json({ error: `Only ${DESK_OWNER_NAME}, or Max on ${DESK_OWNER_NAME}'s say, lifts quiet hours. Ask Max. Nothing was changed.` });
    return undefined;
  }
  if (req.headers['sec-fetch-site'] === 'same-origin' && req.headers.origin && trustedRequestOrigin(req.headers)) return DESK_OWNER_NAME;
  res.status(400).json({ error: 'Pass agent: your teammate id, so TARDIS knows who is lifting quiet hours.' });
  return undefined;
}

function target(req: Request, res: Response): Agent | undefined {
  const raw = Array.isArray(req.params.agent) ? req.params.agent[0] : req.params.agent;
  const agent = teammate(raw);
  if (!agent) res.status(404).json({ error: `No teammate named ${JSON.stringify(raw)}.` });
  return agent;
}

function passView(pass: QuietPass, name: string) {
  return { agentId: pass.id, name, until: pass.until, reason: pass.reason, grantedBy: pass.grantedBy, grantedAt: pass.createdAt };
}

quietHoursRouter.get('/', (_req, res) => {
  const roster = listAgents();
  const now = Date.now();
  res.json({
    quietNow: inQuietHours(now),
    // When each of the next 7 quiet windows ends, the one in force first:
    // the app's Tonight / 3 nights / A week lift lengths.
    nightEnds: quietWindowEnds(now, 7).map((ms) => new Date(ms).toISOString()),
    standing: roster.filter((a) => hasStandingQuietExemption(a.id)).map((a) => ({ agentId: a.id, name: a.name })),
    passes: listQuietPasses().map((pass) => passView(pass, roster.find((a) => a.id === pass.id)?.name ?? pass.id)),
  });
});

/** Lift quiet hours for a teammate until `until`, replacing any lift they have. */
quietHoursRouter.put('/passes/:agent', asyncHandler(async (req, res) => {
  const by = lifter(req, res);
  if (!by) return;
  const agent = target(req, res);
  if (!agent) return;
  if (hasStandingQuietExemption(agent.id)) {
    res.status(400).json({ error: `${agent.name} already works through quiet hours every night.` });
    return;
  }
  const until = instant(req.body?.until);
  if (until === undefined) {
    res.status(400).json({ error: 'until must be a date and time with its UTC offset, like 2026-11-15T21:00:00-05:00 for 9pm Eastern.' });
    return;
  }
  const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
  try {
    const pass = await grantQuietPass({ agentId: agent.id, until, reason, grantedBy: by });
    console.log(`[quiet-hours] ${by} lifted quiet hours for ${agent.name} until ${pass.until}${pass.reason ? ` (${pass.reason})` : ''}`);
    res.json({ pass: passView(pass, agent.name) });
  } catch (error) {
    if (!(error instanceof QuietPassError)) throw error;
    res.status(400).json({ error: error.message });
  }
}));

/** End a teammate's lift now; quiet hours hold them again from this moment. */
quietHoursRouter.delete('/passes/:agent', asyncHandler(async (req, res) => {
  const by = lifter(req, res);
  if (!by) return;
  const agent = target(req, res);
  if (!agent) return;
  const ended = await endQuietPass(agent.id);
  if (ended) console.log(`[quiet-hours] ${by} ended the quiet-hours lift for ${agent.name}`);
  res.json({ ended });
}));
