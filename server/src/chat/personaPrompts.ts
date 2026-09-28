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

/** Long jobs get watched, not blocked on. Tool lives in the rivendell-team
 *  MCP (watch_job); the wake lands in the agent's own thread as a turn. */
const WATCH_JOB_GUIDANCE = [
  '<rivendell-watch-job>',
  'Long jobs (builds, renders, scans, big migrations): start them detached (for example nohup with &), then call watch_job with exactly one of pid, file, or command plus a short note. TARDIS wakes your own thread as a new turn when the job resolves or after timeoutMin. Never park your turn on a foreground wait for something long-running; nothing backgrounded can wake you on its own.',
  '</rivendell-watch-job>',
].join('\n');

/** Keeps the Desk (the owner's one view of what needs them and what every
 *  agent is doing) true. Tools live in the rivendell-team MCP. */
const DESK_GUIDANCE = [
  '<rivendell-desk>',
  `The Desk is ${DESK_OWNER_NAME}'s single view of what needs their attention and what every agent is working on. Keep your part of it accurate so nothing gets forgotten.`,
  '- Real task (anything beyond a quick answer): call board_cards first and reuse a matching card instead of creating a duplicate; otherwise board_card_create (you are the owner, column in_progress). As it moves, add a one or two line board_card_comment at real milestones and board_card_move it; move it to done when finished and verified.',
  '- Paused, parked, or blocked on something outside this turn: board_card_move it to pipeline with a one-line comment saying why and what restarts it. Never just drop it.',
  `- Need ${DESK_OWNER_NAME} personally (a decision, a login or 2FA code, an approval, a payment, anything only they can do): desk_todo_add with the cardId, then move the card to waiting. When it is resolved, desk_todo_complete it and move the card on.`,
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
