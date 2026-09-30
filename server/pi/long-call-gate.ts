/** TARDIS Pi extension: long foreground call gate.
 *
 *  A teammate inside one long foreground shell call cannot be reached, so an
 *  obviously long `bash` call (sleeps, polling loops, builds, renders, deploy and
 *  CI watchers) is blocked up front with an error that says how to run it with
 *  job_start, and any call that held the agent for 60s or longer gets a nudge.
 *
 *  This is a thin adapter: the rules, the 60s timer and the long-calls.jsonl log
 *  all live in server/scripts/long-call-gate.mjs (the same script the Claude and
 *  Codex gates run), so the block list stays in one place.
 *
 *  Installed into ~/.pi/agent/extensions by the gate's install script. TARDIS
 *  loads it by name on its Pi spawns; the file is also seen by a bare `pi`, so it
 *  is INERT unless TARDIS marked the spawn (RIVENDELL_LONG_CALL_GATE_AGENT +
 *  RIVENDELL_LONG_CALL_GATE_SCRIPT). Fails open: any error, timeout or missing
 *  script allows the call.
 *
 *  Env: RIVENDELL_LONG_CALL_GATE=off disables. */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const GATE_TIMEOUT_MS = 4000;
const NODE = /(?:^|[\\/])node(?:\.exe)?$/.test(process.execPath) ? process.execPath : 'node';

type GateOutput = { deny?: string; context?: string };

/** Run the gate script once for a synthesized hook payload. Resolves null (allow)
 *  on any failure. */
function runGate(script: string, mode: 'pre' | 'post', payload: Record<string, unknown>): Promise<GateOutput | null> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: GateOutput | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    try {
      const child = spawn(NODE, [script, mode, '--engine=pi'], { env: process.env, stdio: ['pipe', 'pipe', 'ignore'] });
      timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        finish(null);
      }, GATE_TIMEOUT_MS);
      let out = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { if (out.length < 100_000) out += chunk; });
      child.on('error', () => finish(null));
      child.on('close', () => {
        try {
          const hook = JSON.parse(out.trim() || 'null')?.hookSpecificOutput;
          finish({
            deny: hook?.permissionDecision === 'deny' && typeof hook.permissionDecisionReason === 'string' ? hook.permissionDecisionReason : undefined,
            context: typeof hook?.additionalContext === 'string' ? hook.additionalContext : undefined,
          });
        } catch {
          finish(null);
        }
      });
      child.stdin.on('error', () => { /* the script may exit before reading */ });
      child.stdin.end(JSON.stringify(payload));
    } catch {
      finish(null);
    }
  });
}

export default function (pi: ExtensionAPI) {
  const script = process.env.RIVENDELL_LONG_CALL_GATE_SCRIPT;
  if (!process.env.RIVENDELL_LONG_CALL_GATE_AGENT || !script || process.env.RIVENDELL_LONG_CALL_GATE === 'off') return;
  if (!existsSync(script)) return;

  pi.on('tool_call', async (event) => {
    try {
      if (event.toolName !== 'bash') return;
      const command = (event.input as { command?: unknown } | undefined)?.command;
      if (typeof command !== 'string' || !command) return;
      const out = await runGate(script, 'pre', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command },
        tool_use_id: event.toolCallId,
      });
      if (out?.deny) return { block: true, reason: out.deny };
    } catch {
      /* fail open */
    }
  });

  pi.on('tool_result', async (event) => {
    try {
      if (event.toolName !== 'bash') return;
      const command = (event.input as { command?: unknown } | undefined)?.command;
      const out = await runGate(script, 'post', {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: typeof command === 'string' ? command : '' },
        tool_use_id: event.toolCallId,
      });
      if (out?.context) return { content: [...event.content, { type: 'text' as const, text: `\n\n${out.context}` }] };
    } catch {
      /* fail open */
    }
  });
}
