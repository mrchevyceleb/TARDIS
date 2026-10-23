/**
 * Mid-turn crash tombstones.
 *
 * When a CLI child dies while a turn is in flight it never emits a `result`
 * event, so nothing assistant-shaped ever reaches the event log. The working
 * window (see threadWindow.ts `extractVisibleTurns`) is derived from that log,
 * which means the next turn sees the user's request with NOTHING after it. The
 * model then truthfully reports "I didn't do anything" while the finished work
 * is sitting on disk.
 *
 * That happened for real on 2026-08-31: a WebKit iPhone test ran 8 minutes,
 * wrote screenshots and a report, then took an OOM SIGKILL (exit 137). The next
 * turn had no idea any of it existed and said so.
 *
 * The fix is to write a durable, assistant-shaped marker on abnormal exit. It
 * renders in the thread like any other reply (so the human sees the failure
 * instead of silence) and it lands in the model window (so the next turn knows
 * to go recover the work rather than re-run it).
 */

/** Claude Code slugifies the cwd into its project dir name by swapping `/`. */
export function engineProjectSlug(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

function humanizeMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return 'an unknown amount of time';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

/** SIGKILL / 137 is commonly the Linux OOM killer (including unified
 *  memory). 139 / SIGSEGV is a hard crash. Both mean "not your fault, and the
 *  work may well have finished." */
function likelyOom(code: number | null, signal: string | null): boolean {
  return code === 137 || signal === 'SIGKILL';
}

export interface TombstoneOpts {
  cli: string;
  cwd: string;
  sessionId?: string | null;
  code: number | null;
  signal: string | null;
  /** ms the turn had been running when the child died. Omit if not tracked. */
  ranMs?: number;
  /** Actual Claude transcript path when account routing uses a custom project. */
  nativeTranscriptPath?: string | null;
}

export function crashTombstoneText(opts: TombstoneOpts): string {
  const { cli, cwd, sessionId, code, signal, ranMs, nativeTranscriptPath } = opts;
  const how = [
    code !== null ? `code=${code}` : null,
    signal ? `signal=${signal}` : null,
  ].filter(Boolean).join(' ') || 'reason unknown';

  const lines: string[] = [];
  const ranPhrase = ranMs === undefined ? '' : ` after running ${humanizeMs(ranMs)}`;
  lines.push(
    `[TARDIS] This turn was KILLED before it could reply. The ${cli} process died${ranPhrase} (${how}).`,
  );
  if (likelyOom(code, signal)) {
    lines.push(
      `That is a SIGKILL, which on this box is almost always the OOM killer, not an agent choosing to stop. Run \`free -g\` before retrying anything browser- or build-heavy.`,
    );
  }
  lines.push(
    `Work from this turn may have COMPLETED and written files even though no answer came back. Do NOT tell the user nothing was done until you have checked:`,
  );
  const slug = engineProjectSlug(cwd);
  const transcript = nativeTranscriptPath ?? `~/.claude/projects/${slug}/${sessionId ? `${sessionId}.jsonl` : '<session-id>.jsonl'}`;
  lines.push(
    `  1. the engine log \`${transcript}\` for the tool calls that ran`,
  );
  lines.push(
    `  2. \`scratch/<today>/\` and any project \`tmp/\` dirs for surviving artifacts (screenshots, reports, generated files)`,
  );
  lines.push(`Recover the result from those artifacts instead of re-running the whole thing.`);
  return lines.join('\n');
}

/** Assistant-shaped wrapper so the marker flows through the normal render and
 *  window-extraction paths (threadWindow.ts reads `message.content[].text`). */
export function crashTombstoneEvent(text: string) {
  return {
    type: 'event' as const,
    event: {
      type: 'assistant',
      _rivendellTombstone: true,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    },
  };
}

/** Service-restart marker, written into every BUSY lane's durable log on
 *  shutdown. Assistant-shaped so the resumed agent READS it in seed windows
 *  (it coaches a recovery check, which is exactly what a stalled agent needs
 *  after its tool call died with the process) and `_serviceRestart`-tagged so
 *  the UI renders it as a divider, not a bubble. */
export function restartMarkerEvent(signal: string) {
  const text = [
    `[TARDIS] The service restarted mid-turn (${signal} — a deploy or bounce). This turn was KILLED with the process.`,
    `Your in-flight tool call's output — including any error it printed — is LOST. Do NOT stall silently and do NOT guess:` ,
    `  1. re-check the work directly (re-run the interrupted command, or inspect its logs/artifacts), then`,
    `  2. tell the user the turn was restarted and what you recovered.`,
  ].join('\n');
  return {
    type: 'event' as const,
    event: {
      type: 'assistant',
      _serviceRestart: true,
      reason: signal,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    },
  };
}
