import { assertClaudeSubscription } from '../chat/subscription-auth.ts';
import { spawn } from 'node:child_process';
import type { RivendellJob } from '../data/mock.ts';
import { WORKER_RUNNER } from '../config.ts';
import { emitScribe } from './scribe.ts';
import { dispatchDryRun, type DispatcherResult } from './dispatchers.ts';
import { accountEnv } from '../lib/accountResolver.ts';
import { engineDefault } from '../lib/engineConfig.ts';

// Model + reasoning effort the headless worker spawns claude with. Opus 4.7+ uses
// adaptive thinking and ignores MAX_THINKING_TOKENS; the live lever is the
// `--effort` flag (low|medium|high|xhigh|max). "max" is the top tier.
const { model: CLAUDE_MODEL, effort: CLAUDE_EFFORT } = engineDefault('claude', 'claude-opus-5-5', 'xhigh');

export async function runJob(job: RivendellJob): Promise<DispatcherResult> {
  if (WORKER_RUNNER !== 'claude') {
    await emitScribe({ job_id: job.id, level: 'thinking', text: `dry-run dispatcher handling ${job.skill}` });
    return dispatchDryRun(job);
  }

  const prompt = [
    `You are the TARDIS headless worker handling skill "${job.skill}".`,
    'Do not send messages, push commits, or open PRs unless explicitly told. Draft or summarize when approval is needed.',
    job.repo ? `Repository: ${job.repo}` : '',
    job.prompt ?? '',
  ].filter(Boolean).join('\n\n');

  await emitScribe({ job_id: job.id, level: 'system', text: `spawning claude worker for ${job.skill}` });

  const env = accountEnv(job.repo || process.cwd());
  assertClaudeSubscription(env, job.repo || process.cwd());
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', '--output-format', 'stream-json', '--dangerously-skip-permissions', '--model', CLAUDE_MODEL, '--effort', CLAUDE_EFFORT, prompt], {
      cwd: job.repo || process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      void emitScribe({ job_id: job.id, level: 'tool', text: chunk.trim().slice(0, 500) || 'claude emitted output' });
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      void emitScribe({ job_id: job.id, level: 'error', text: chunk.trim().slice(0, 500) });
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`claude worker exited with code ${code}`));
        return;
      }
      resolve({
        status: 'needs_review',
        needs_review_reason: 'Claude worker completed; review the result before any external action.',
        result: { output },
      });
    });
  });
}
