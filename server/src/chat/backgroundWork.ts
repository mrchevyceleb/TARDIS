/**
 * Background work inside a Claude Code process.
 *
 * `run_in_background` shells and background subagents run INSIDE the CLI
 * child. When one finishes, Claude Code wakes the agent with a
 * task_notification, but only while that same process is alive. Every kill
 * (Stop's fallback, a restart, a model switch, the idle reaper) used to end
 * that work without a word: the agent never woke and nobody saw why.
 *
 * Automatic kills now wait for background work to drain. Deliberate ones post
 * a `_background_work` note that names the work in plain words, and the
 * agent's next turn is told not to wait for it.
 */

export const BACKGROUND_WORK_EVENT = '_background_work';

/** What ended (or kept) the work. Drives the one-line wording. */
export type BackgroundWorkCause = 'stop' | 'restart' | 'fresh' | 'closed' | 'idle' | 'other' | 'model' | 'engine';

/** A model/effort change waits this long for background work, then applies
 *  on the next message after it (naming what it ended). */
export const BACKGROUND_MODEL_HOLD_MINUTES = 15;

const MAX_LABEL = 80;

/** The plain description Claude gave the task, clipped to one short line. */
export function backgroundTaskLabel(task: { description?: unknown; task_type?: unknown } | null | undefined): string {
  const raw = typeof task?.description === 'string' ? task.description.split('\n')[0].trim() : '';
  if (raw) return raw.length > MAX_LABEL ? `${raw.slice(0, MAX_LABEL - 1).trimEnd()}…` : raw;
  if (task?.task_type === 'local_bash') return 'a background command';
  if (task?.task_type === 'local_agent') return 'a background subagent';
  return 'a background task';
}

export function backgroundWorkText(state: 'ended' | 'kept', cause: BackgroundWorkCause, tasks: string[]): string {
  const list = tasks.join(', ');
  if (state === 'kept') {
    return `Kept this session running for background work: ${list}. The model change applies once it finishes, or on your next message after ${BACKGROUND_MODEL_HOLD_MINUTES} minutes.`;
  }
  switch (cause) {
    case 'stop': return `Stopping also ended: ${list}`;
    case 'restart': return `The restart ended background work: ${list}`;
    case 'fresh': return `Starting fresh ended background work: ${list}`;
    case 'closed': return `Closing this session ended background work: ${list}`;
    case 'idle': return `Idle cleanup ended background work: ${list}`;
    case 'model': return `Switching the model ended background work: ${list}`;
    case 'engine': return `Switching engines ended background work: ${list}`;
    default: return `This session had to restart, which ended background work: ${list}`;
  }
}

export function backgroundWorkEvent(state: 'ended' | 'kept', cause: BackgroundWorkCause, tasks: string[]) {
  return {
    type: BACKGROUND_WORK_EVENT,
    state,
    cause,
    tasks,
    text: backgroundWorkText(state, cause, tasks),
    ts: Date.now(),
  };
}

/** Background work that ended since the last message this lane received.
 *  Prepended to the next turn so the agent re-checks instead of waiting on a
 *  notification that can no longer arrive. `events` is the lane's event tail. */
export function backgroundEndedGuidance(events: ReadonlyArray<{ ev: any }>): string {
  const notes: string[][] = [];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i]?.ev;
    const inner = ev?.type === 'event' ? ev.event : null;
    const type = inner?.type;
    if (type === '_user_echo' || type === 'peer_message') break;
    if (type !== BACKGROUND_WORK_EVENT || inner.state !== 'ended' || !Array.isArray(inner.tasks)) continue;
    notes.unshift(inner.tasks.filter((task: unknown): task is string => typeof task === 'string' && task.length > 0));
  }
  const ended = [...new Set(notes.flat())];
  if (ended.length === 0) return '';
  return [
    '<rivendell-background-ended>',
    `Background work you started has ended and will never report back: ${ended.join('; ')}.`,
    'Do not wait for it. If its result still matters, check its output or run it again.',
    '</rivendell-background-ended>',
  ].join('\n');
}
