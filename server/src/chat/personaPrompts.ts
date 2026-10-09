// Persona scope documents — each agent's "who I am / what I do" markdown.
// Records (which agent owns which file) live in agents.ts; this module only
// reads/writes the files with an mtime hot-reload cache.

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from './config.ts';
import { agentForChatId } from './agents.ts';
import { DESK_OWNER_NAME, DESK_ROOM_ENABLED } from '../config.ts';

export const PERSONAS_DIR = join(STATE_DIR, 'personas');

const cache = new Map<string, { mtime: number; text: string }>();

const TEAM_STATUS_GUIDANCE = [
  '<rivendell-team-status>',
  'Treat teammate activity as live state, never as an inference from what you intended, mentioned, or previously asked them to do.',
  'When coordinating delegated work, check team_status at natural checkpoints: after assigning, before changing course, and before your final status summary. Before telling the user that a teammate is working, idle, queued, blocked, still handling something, or has work in flight, call team_status in the current turn. Use team_recent too when you need to identify the actual work or its latest result.',
  '“WORKING NOW” means a live turn exists. “IDLE” means no turn is running. A message you meant to send, a handoff that was accepted, or a possible follow-up is not proof that work is underway.',
  'Use precise states: active now, queued, assigned but idle, merely proposed, or completed. If you want a teammate to start, actually send the handoff; do not report it as active until current evidence says it is.',
  '</rivendell-team-status>',
].join('\n');

/** Long work runs as a background job, never in a blocking foreground call.
 *  Tools live in the rivendell-team MCP (job_start, watch_job); the result
 *  lands in the agent's own thread as a turn. */
const WATCH_JOB_GUIDANCE = [
  '<rivendell-background-jobs>',
  'Anything that will take longer than about 30 seconds (builds, full test runs, renders, big installs, sleeps and waits, deploy and CI watchers, long scripts) is a background job, never a foreground call. Start it with job_start (a short name plus the shell command). It runs detached in its own scope, survives TARDIS restarts, shows in the chat UI as a running job with a Stop button, and when it ends TARDIS delivers a job result (exit code and the last output lines) into your own thread as a new turn. job_list shows state, job_log reads output, job_stop stops one.',
  'After starting a job, keep working on something else or end your turn. Never sit in a foreground wait, a sleep, or an until-loop: while you are stuck in one, the person messaging you cannot reach you. A job result is an automation message, not a person; it is never reported as finished unless the command exited on its own.',
  'Use watch_job only for a pid or file you already have (for example a process you started yourself). For a command, use job_start.',
  '</rivendell-background-jobs>',
].join('\n');

/** Keeps the Desk (the owner's one view of what needs them and what every
 *  agent is doing) true. Tools live in the rivendell-team MCP. */
const DESK_GUIDANCE = [
  '<rivendell-desk>',
  `The Desk is ${DESK_OWNER_NAME}'s single view of what needs their attention and what every agent is working on. Keep your part of it accurate so nothing gets forgotten.`,
  `- Columns (Matt, Oct 9 2026): Not started = parked, not begun, with the reason and what restarts it (work blocked outside the team, or parked by ${DESK_OWNER_NAME}; parking is never how you clear a stale card). In progress = only what you have hands on today. In QA (Sud) = with Sud QA. Merged to staging = merged to staging, waiting on the ship. Live in production = shipped and verified. Waiting on a teammate: hand them the card. Idle with Not started work: start the top card. A card that needs ${DESK_OWNER_NAME} personally is flagged by its open Needs-you item in any column, not by a column. Keep your cards true in real time without being asked: move the card the moment the work moves (start, hand off, park, finish) and before you reply or go idle.`,
  '- Real task (anything beyond a quick answer): call board_cards first and reuse a matching card instead of creating a duplicate; otherwise board_card_create (you are the owner, column in_progress). Work with no card is a miss: card it first. Add a one or two line board_card_comment at real milestones. The Desk checks every two hours and messages you about stale cards; fix each card rather than explaining at length.',
  '- Blocked on something outside this turn: hand the card to whoever has the ball (board_card_update owner) when a teammate holds it, or board_card_move it to not_started, with a one-line comment saying why and what restarts it, when the block is outside the team. Never just drop it.',
  `- Need ${DESK_OWNER_NAME} personally (a decision, a login or 2FA code, an approval, a payment, anything only they can do): desk_todo_add with the cardId. The card shows its needs-${DESK_OWNER_NAME} flag in any column while the item is open; the column stays where the real stage is. For a pick-one question pass choices (up to 4 short options; otherwise it is Yes / No) so ${DESK_OWNER_NAME} can answer with one tap. The answer arrives as a message from ${DESK_OWNER_NAME} with the item already closed; act on it and move the card on. If it gets resolved some other way, desk_todo_complete it and move the card on.`,
  '- Skip the board for one-line answers, chit-chat, and routine runs that found nothing. Keep titles short and comments brief.',
  '- A message containing [desk:card-…] or [desk:todo-…] points at the Desk: read it first (board_card_get or desk_todos with that id) before answering, and post a short board_card_comment if your answer changes the card.',
  '</rivendell-desk>',
].join('\n');

function readScopeFile(file: string): string {
  const path = join(PERSONAS_DIR, file);
  try {
    const mtime = statSync(path).mtimeMs;
    const hit = cache.get(path);
    if (hit && hit.mtime === mtime) return hit.text;
    const text = readFileSync(path, 'utf8').trim();
    cache.set(path, { mtime, text });
    return text;
  } catch {
    return '';
  }
}

/** The agent's scope for a home-thread chatId ('' when no agent owns it). */
export function personaPromptFor(chatId: string): string {
  const agent = agentForChatId(chatId);
  if (!agent) return '';
  const scope = readScopeFile(`${agent.id}.md`);
  return [scope, TEAM_STATUS_GUIDANCE, WATCH_JOB_GUIDANCE, DESK_ROOM_ENABLED ? DESK_GUIDANCE : null].filter(Boolean).join('\n\n');
}

/** Scope text for an agent record's home (REST use). */
export function personaScopeFor(home: string): string {
  const agent = agentForChatId(home);
  if (!agent) return '';
  return readScopeFile(`${agent.id}.md`);
}

/** Write an agent's scope file (create/update path). */
export function writeScopeFile(file: string, body: string): void {
  mkdirSync(PERSONAS_DIR, { recursive: true });
  writeFileSync(join(PERSONAS_DIR, file), body);
}
