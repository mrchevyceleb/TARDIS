import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { STATE_DIR } from './config.ts';
import { bareChatId, isAgentThread } from './threadKey.ts';
import { agentForChatId } from './agents.ts';
import { sessionPolicy, NATIVE_COMPACT_TOKENS } from './sessionPolicy.ts';
import { queueFlagDigest } from '../lib/flagDigest.ts';
import { inQuietHours } from '../lib/quietHours.ts';
import { codexCompactEvidence, compactEvidencePending, invalidateRestoredFileEvidence, nativeCompactEvidence, recordedRestartNear } from './sessionMetricEvidence.ts';

export type NativeCall = {
  at?: number; requestStartedAt?: number; lane: string; engine: string; model: string; sessionId?: string;
  input: number; cached: number; output: number; prefix?: string;
  auxiliary?: boolean; harnessChars?: number; harnessPhase?: 'startup' | 'turn'; provider?: string; resumed?: boolean;
};
type WorkingContext = { files: number; fileCharacters: number; summaryCharacters: number };
type Metric = NativeCall & { workingContext?: WorkingContext; at: number; event: string; cachedShare?: number; before?: number; after?: number; trigger?: string; reason?: string; coreInput?: number; requestSha256?: string };
const directory = join(STATE_DIR, 'native-session-metrics');
const alerted = new Set<string>();
const sessions = new Map<string, string>();
const nextCall = new Set<string>();
const cacheHistory = new Map<string, { input: number; misses: number }>();
const pendingFile = join(directory, 'pending-compacts.json');
function pendingCompacts(): Array<[string, number]> {
  try {
    const values = JSON.parse(readFileSync(pendingFile, 'utf8'));
    // A legacy entry without a boundary time cannot prove ordering.
    return Array.isArray(values) ? values
      .filter(value => Array.isArray(value) && typeof value[0] === 'string' && Number.isFinite(value[1]) && value[1] > 0) : [];
  } catch { return []; }
}
const afterCompact = new Map<string, number>(pendingCompacts());
const proofBoundaries = new Map(afterCompact);
const transportBoundaries = new Map<string, number>();
/** The transport sees completion before forwarding it to the native engine.
 * The engine notification confirms installation, but cannot date it reliably. */
export function recordNativeCompactBoundary(lane: string, engine: string, sessionId: string | null, at: number): void {
  if (!sessionId || !Number.isFinite(at)) return;
  transportBoundaries.set(`${bareChatId(lane)}|${engine}|${sessionId}`, at);
}
function savePendingCompacts(): void {
  try { mkdirSync(directory, { recursive: true }); const tmp = `${pendingFile}.tmp`; writeFileSync(tmp, JSON.stringify([...afterCompact]), { mode: 0o600 }); renameSync(tmp, pendingFile); }
  catch { console.warn('[native-session] pending compact measurement could not be saved'); }
}
const day = (at = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
function append(record: Metric): void {
  try {
    mkdirSync(directory, { recursive: true });
    appendFileSync(join(directory, `${day(record.at)}.jsonl`), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch { console.warn('[native-session] metric could not be saved'); }
}
function alert(lane: string, reason: string, category = reason): void {
  const key = `${day()}|${lane}|${category}`;
  if (alerted.has(key)) return;
  alerted.add(key);
  queueFlagDigest('chief-of-staff', `native-session:${lane}:${category}`, `Session health ${bareChatId(lane).replace(/^bot-/, '')}: ${reason}. Read the native session report before a restart.`, undefined, true);
}
/** Read only a bounded native-log tail. Content and paths never enter metrics. */
function nativeWorkingContext(lane: string, sessionId?: string): WorkingContext | undefined {
  let fd: number | undefined;
  try {
    const location = JSON.parse(readFileSync(join(STATE_DIR, 'native-claude-locations.json'), 'utf8'))[bareChatId(lane)];
    if (!location || location.id !== sessionId) return;
    fd = openSync(join(location.profile, 'projects', location.project, `${sessionId}.jsonl`), 'r');
    const size = fstatSync(fd).size, start = Math.max(0, size - 2 * 1024 * 1024);
    const buffer = Buffer.alloc(size - start); readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n'); if (start) lines.shift();
    const rows = lines.flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const boundary = rows.findLastIndex(row => row.type === 'system' && row.subtype === 'compact_boundary');
    if (boundary < 0) return;
    const context = { files: 0, fileCharacters: 0, summaryCharacters: 0 };
    for (const row of rows.slice(boundary + 1)) {
      if (row.type === 'user' && !row.isCompactSummary && !row.isMeta) break;
      if (row.isCompactSummary) context.summaryCharacters += JSON.stringify(row.message?.content ?? '').length;
      if (row.type === 'attachment' && row.attachment?.type === 'file') {
        context.files++; context.fileCharacters += JSON.stringify(row.attachment.content ?? '').length;
      }
      if (row.type === 'assistant') break;
    }
    return context;
  } catch { return; } finally { if (fd !== undefined) closeSync(fd); }
}
export function recordNativeCall(call: NativeCall): void {
  if (!call.lane || !Number.isFinite(call.input) || call.input <= 0) return;
  const cached = Math.min(call.input, Math.max(0, call.cached));
  const cachedShare = cached / call.input;
  const sessionKey = `${bareChatId(call.lane)}|${call.engine}|${call.sessionId || ''}`;
  if (call.auxiliary) {
    append({ ...call, at: call.at ?? Date.now(), cached, event: 'auxiliary', cachedShare });
    return;
  }
  const proofAt = proofBoundaries.get(sessionKey);
  if (proofAt && call.sessionId) {
    // Native history is flushed asynchronously after the provider response.
    // Save verified root evidence while it is fresh, not only when a report opens.
    setTimeout(() => {
      if (call.engine === 'claude-code') nativeCompactEvidence(bareChatId(call.lane), call.sessionId, proofAt);
      else if (call.engine === 'codex') codexCompactEvidence(bareChatId(call.lane), call.sessionId, proofAt);
    }, 750).unref();
  }
  const first = !call.resumed && !nextCall.has(sessionKey);
  const warm = nextCall.has(sessionKey);
  nextCall.add(sessionKey);
  append({ ...call, at: call.at ?? Date.now(), cached, event: first ? 'start' : 'call', cachedShare });
  const ceiling = sessionPolicy(call.lane).startTokenCeiling ?? 33_000;
  const boundary = afterCompact.get(sessionKey);
  const justCompacted = boundary !== undefined && boundary > 0 && Number.isFinite(call.requestStartedAt)
    && call.requestStartedAt! >= boundary;
  if (justCompacted) afterCompact.delete(sessionKey);
  if (justCompacted) {
    savePendingCompacts();
    append({ ...call, at: call.at ?? Date.now(), cached, event: 'after-compact', cachedShare,
      ...(call.engine === 'claude-code' ? { workingContext: nativeWorkingContext(call.lane, call.sessionId) } : {}) });
    // This total includes native re-attached working files. The fixed-start
    // ceiling is checked on the actual start, not on restored working context.
  }
  // Ordinary conversations need measurements too; agent start/cache alerts
  // remain limited to the team lanes they were configured for.
  if (!isAgentThread(call.lane)) return;
  if (first && call.input > ceiling) alert(call.lane, `start ${call.input} exceeds ${ceiling} tokens`, 'start-ceiling');
  const previous = cacheHistory.get(sessionKey);
  // Cacheable history is the previous call's input, not newly added work.
  // Require repeated misses so a cold prefix or a native compact cannot page Max.
  const missed = warm && !justCompacted && previous && call.input >= previous.input && cached < previous.input * 0.8;
  const misses = missed ? previous.misses + 1 : 0;
  cacheHistory.set(sessionKey, { input: call.input, misses });
  if (misses >= 2) alert(call.lane, `the last two calls reused less than 80% of their existing context from cache`, 'cache-share');
}
export function recordNativeSession(lane: string, engine: string, sessionId: string, expected?: string | null): void {
  const key = `${bareChatId(lane)}|${engine}`;
  const previous = expected || sessions.get(key);
  if (previous && previous !== sessionId) {
    append({ at: Date.now(), event: 'replacement', lane, engine, model: '', sessionId, input: 0, cached: 0, output: 0, reason: 'Native ID changed without a manual fresh thread' });
    alert(lane, 'the saved native session was replaced unexpectedly');
  }
  sessions.set(key, sessionId);
}
export function recordNativeCompact(lane: string, engine: string, sessionId: string | null, metadata: any): void {
  const before = Number(metadata?.pre_tokens ?? metadata?.before ?? 0);
  const after = Number(metadata?.post_tokens ?? metadata?.after ?? 0);
  const key = `${bareChatId(lane)}|${engine}|${sessionId || ''}`;
  const observed = transportBoundaries.get(key);
  transportBoundaries.delete(key);
  const now = Date.now();
  const at = observed !== undefined && observed <= now && now - observed < 120_000 ? observed : now;
  invalidateRestoredFileEvidence(lane, sessionId);
  append({ at, event: 'compact', lane, engine, model: '', sessionId: sessionId ?? undefined, input: 0, cached: 0, output: 0, before, after, trigger: String(metadata?.trigger ?? 'native') });
  afterCompact.set(key, at);
  proofBoundaries.set(key, at);
  savePendingCompacts();
  // Native metadata can exclude the fixed prompt. Measure the next real call.
}
/** Record acceptance instrumentation from a byte-verified native request.
 * This recorder never makes a provider request or changes the live session. */
export function recordNativeComponentMeasurement(lane: string, engine: string, sessionId: string, measurement: { fixedSame?: boolean; summaryKept?: boolean; measuredInputUpperBound?: number; requestSha256?: string }): void {
  if (!isAgentThread(lane) || !measurement.fixedSame || !measurement.summaryKept || !measurement.requestSha256 || !Number.isFinite(measurement.measuredInputUpperBound) || Number(measurement.measuredInputUpperBound) <= 0) return;
  append({ at: Date.now(), event: 'component-measurement', lane, engine, sessionId, model: '', input: 0, cached: 0, output: 0, coreInput: measurement.measuredInputUpperBound, requestSha256: measurement.requestSha256 });
  const ceiling = sessionPolicy(lane).startTokenCeiling ?? 33_000;
  if (Number(measurement.measuredInputUpperBound) > ceiling) alert(lane, `the measured upper bound ${measurement.measuredInputUpperBound} does not prove the ${ceiling}-token instructions and summary ceiling`, 'compact-ceiling');
}
export function recordNativeNotice(lane: string, engine: string, reason: string): void {
  append({ at: Date.now(), event: 'notice', lane, engine, model: '', input: 0, cached: 0, output: 0, reason });
}
export function recordNativeInterruption(lane: string, engine: string, reason: string): void {
  append({ at: Date.now(), event: 'interruption', lane, engine, model: '', input: 0, cached: 0, output: 0, reason });
}
export function recordNativeFailure(lane: string, engine: string, reason: string): void {
  append({ at: Date.now(), event: 'failure', lane, engine, model: '', input: 0, cached: 0, output: 0, reason });
  alert(lane, reason);
}
export function fixedPrefix(request: any): string {
  // Hash only. Request text, credentials and tool arguments never enter metrics.
  return createHash('sha256').update(JSON.stringify({
    system: request.system, tools: request.tools,
    thinking: request.thinking, reasoning: request.reasoning,
    reasoning_effort: request.reasoning_effort, effort: request.effort,
    output_config: request.output_config,
  })).digest('hex');
}
export function nativeSessionReport(date = day()): { date: string; rows: any[] } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid report date');
  const file = join(directory, `${date}.jsonl`);
  const records: Metric[] = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }) : [];
  records.sort((a, b) => a.at - b.at);
  const lanes = new Map<string, any>();
  const compactsBySession = new Map<string, any>();
  const lastInputs = new Map<string, number>();
  const cacheChecks = new Map<string, { input: number; misses: number }>();
  const compactResets = new Set<string>();
  const sessionStats = new Map<string, any>();
  for (const event of records) {
    if (event.event === 'notice') {
      const row = lanes.get(bareChatId(event.lane));
      if (row && event.reason === 'Native compaction template recovered.') {
        const resolved = row.failures.filter((reason: string) => reason.startsWith('The engine compacted without a recognized bounded summary request'));
        row.recovered.push(...resolved); row.failures = row.failures.filter((reason: string) => !resolved.includes(reason));
        row.failureDetails = row.failureDetails.filter((failure: any) => !resolved.includes(failure.reason));
      }
      continue;
    }
    if (/Cross-engine switch involving Codex is held/.test(event.reason || '')) continue;
    const key = bareChatId(event.lane);
    const row = lanes.get(key) ?? { lane: bareChatId(event.lane).replace(/^bot-/, ''), engine: event.engine, calls: 0, input: 0, cached: 0, firstAt: event.at, lastAt: event.at, latestStartAt: 0, peakInput: 0, cacheChecks: 0, cacheMissCalls: 0, cacheRecoveryChecks: 0, maxCacheMissStreak: 0, latestCacheMissStreak: 0, firstStartupHarnessChars: null, auxiliaryCalls: 0, auxiliaryInput: 0, auxiliaryCached: 0, starts: [], compacts: [], afterCompacts: [], postCompactChecks: [], workingContexts: [], interruptions: [], pendingRestartChecks: [], failures: [], failureDetails: [], recovered: [], models: new Set<string>(), providers: new Set<string>(), replacements: 0, minHarnessChars: null, maxHarnessChars: null, startupHarnessChars: null, unclassifiedHarnessChars: null, prefixes: new Set<string>() };
    row.lastAt = Math.max(row.lastAt, event.at);
    if (event.auxiliary || event.event === 'auxiliary') {
      row.auxiliaryCalls++; row.auxiliaryInput += event.input; row.auxiliaryCached += event.cached;
      lanes.set(key, row);
      continue;
    }
    if (event.model) row.models.add(event.model);
    if (event.provider) row.providers.add(event.provider);
    if (event.input > 0) { row.engine = event.engine; row.latestModel = event.model; row.latestProvider = event.provider; row.latestSessionKey = `${key}|${event.engine}|${event.sessionId || ''}`; }
    if (event.event === 'compact' || (event.input > 0 && event.event !== 'after-compact')) {
      const resolved = row.failures.filter((reason: string) => /Native (?:resume|compact)|old provider/i.test(reason));
      row.recovered.push(...resolved);
      row.failures = row.failures.filter((reason: string) => !resolved.includes(reason));
      row.failureDetails = row.failureDetails.filter((failure: any) => !resolved.includes(failure.reason));
    }
    if (event.event === 'replacement') row.replacements++;
    const sessionKey = `${key}|${event.engine}|${event.sessionId || ''}`;
    if (event.event === 'component-measurement') {
      const compact = compactsBySession.get(sessionKey);
      if (compact && event.coreInput && event.requestSha256) { compact.coreInput = event.coreInput; compact.coreMeasuredAt = event.at; compact.requestSha256 = event.requestSha256; }
    }
    if (event.event === 'compact') {
      // A native notification alone does not distinguish automatic from manual.
      const trigger = event.trigger?.toLowerCase() ?? '';
      const kind = /manual|user/.test(trigger) ? 'manual' : /^(auto|automatic)(?:[-_ ]|$)/.test(trigger) ? 'automatic' : 'native';
      const compact = { at: event.at, sessionId: event.sessionId, sessionKey, engine: event.engine, before: event.before || lastInputs.get(sessionKey), after: event.after, trigger: event.trigger, kind };
      row.compacts.push(compact); compactsBySession.set(sessionKey, compact); compactResets.add(sessionKey); row.cacheRecoveryChecks = 0;
      const stats = sessionStats.get(sessionKey); if (stats) stats.recovery = 0;
    }
    if (event.input > 0 && !event.auxiliary && event.event !== 'after-compact') {
      const compact = compactsBySession.get(sessionKey);
      if (compact && event.requestStartedAt !== undefined && event.requestStartedAt >= compact.at
          && (compact.requestStartedAt === undefined || event.requestStartedAt < compact.requestStartedAt)) {
        compact.measuredAfter = event.input; compact.measuredAt = event.at;
        compact.requestStartedAt = event.requestStartedAt; compact.measurementSource = 'request-start';
      }
    }
    if (event.input > 0) lastInputs.set(sessionKey, event.input);
    if (event.event === 'start') { row.starts.push(event.input); row.latestStartAt = event.at; row.cacheRecoveryChecks = 0; }
    const restart = event.event === 'failure' && event.engine === 'codex'
      && ['Codex returned a failed turn. Its saved thread was retained; the turn error has the details.',
        'Codex ended without an answer. Its saved thread and queued messages were retained.'].includes(event.reason || '')
      ? recordedRestartNear(event.lane, event.at) : false;
    if (event.event === 'interruption' || restart === true) row.interruptions.push({ at: event.at, reason: 'Interrupted by a TARDIS restart' });
    else if (restart === undefined) row.pendingRestartChecks.push({ at: event.at, reason: event.reason });
    else if (event.event === 'failure') { row.failures.push(event.reason); row.failureDetails.push({ at: event.at, reason: event.reason }); }
    if (event.event === 'after-compact') {
      const compact = compactsBySession.get(sessionKey);
      if (compact && event.input > 0 && event.requestStartedAt !== undefined && event.requestStartedAt >= compact.at
        && (compact.requestStartedAt === undefined || event.requestStartedAt <= compact.requestStartedAt)) { compact.measuredAfter = event.input; compact.measuredAt = event.at; compact.requestStartedAt = event.requestStartedAt; compact.measurementSource = 'request-start'; compact.workingContext = event.workingContext; }
      if (event.input > 0) { compactResets.delete(sessionKey); cacheChecks.set(sessionKey, { input: event.input, misses: 0 }); const stats = sessionStats.get(sessionKey); if (stats) stats.recovery = 0; }
      row.afterCompacts.push(event.input); row.postCompactChecks.push({ at: event.at, sessionId: event.sessionId, input: event.input, workingContext: event.workingContext }); if (event.workingContext) row.workingContexts.push(event.workingContext); }
    if (event.input > 0 && !['after-compact', 'compact'].includes(event.event)) {
      row.calls++; row.input += event.input; row.cached += event.cached;
      row.peakInput = Math.max(row.peakInput, event.input);
      const previous = cacheChecks.get(sessionKey);
      const justCompacted = compactResets.delete(sessionKey);
      const eligible = previous && !justCompacted && event.input >= previous.input;
      const missed = eligible && event.cached < previous.input * 0.8;
      const misses = missed ? previous.misses + 1 : 0;
      if (eligible) row.cacheChecks++;
      if (missed) { row.cacheMissCalls++; row.cacheRecoveryChecks = 0; }
      else if (eligible) row.cacheRecoveryChecks++;
      row.maxCacheMissStreak = Math.max(row.maxCacheMissStreak, misses);
      row.latestCacheMissStreak = misses;
      const stats = sessionStats.get(sessionKey) ?? { calls: 0, input: 0, cached: 0, checks: 0, misses: 0, recovery: 0, longest: 0, streak: 0 };
      stats.calls++; stats.input += event.input; stats.cached += event.cached;
      if (eligible) stats.checks++;
      if (missed) { stats.misses++; stats.recovery = 0; } else if (eligible) stats.recovery++;
      stats.longest = Math.max(stats.longest, misses); stats.streak = misses;
      sessionStats.set(sessionKey, stats);
      cacheChecks.set(sessionKey, { input: event.input, misses });
    }
    if (event.harnessChars !== undefined && event.event !== 'after-compact') {
      const field = event.harnessPhase === 'startup' ? 'startupHarnessChars'
        : event.harnessPhase === 'turn' ? 'maxHarnessChars' : 'unclassifiedHarnessChars';
      if (event.harnessPhase === 'startup') {
        row.firstStartupHarnessChars ??= event.harnessChars;
        row.startupHarnessChars = event.harnessChars;
      } else row[field] = Math.max(row[field] ?? 0, event.harnessChars);
      if (event.harnessPhase === 'turn') row.minHarnessChars = Math.min(row.minHarnessChars ?? event.harnessChars, event.harnessChars);
    }
    if (event.prefix) row.prefixes.add(event.prefix);
    lanes.set(key, row);
  }
  for (const row of lanes.values()) {
    for (const compact of row.compacts) {
      const proof = compact.engine === 'codex'
        ? codexCompactEvidence(`bot-${row.lane}`, compact.sessionId, compact.at)
        : compact.engine === 'claude-code' ? nativeCompactEvidence(`bot-${row.lane}`, compact.sessionId, compact.at) : undefined;
      if (proof) {
        compact.measuredAfter = proof.input; compact.measuredAt = proof.at; compact.measurementSource = proof.source;
      } else if (compact.engine === 'claude-code') {
        // Native child requests can share the parent's provider session id.
        // Until root transcript ancestry verifies it, a transport-only call
        // is not proof of the parent's first post-compaction request.
        delete compact.measuredAfter; delete compact.measuredAt;
      }
      compact.measurementPending = !proof && (compactEvidencePending(`bot-${row.lane}`, compact.sessionId, compact.engine === 'codex', compact.at) || Date.now() - compact.at < 120_000);
    }
    // Unverified legacy completion labels must never appear as a second answer.
    row.afterCompacts = row.compacts.filter((c: any) => c.measuredAfter !== undefined).map((c: any) => c.measuredAfter);
    row.postCompactChecks = [];
  }
  return { date, rows: [...lanes.values()].map(({ prefixes, models, providers, ...row }) => {
    const current = sessionStats.get(row.latestSessionKey);
    return { ...row, models: [...models], providers: [...providers], historicalCalls: row.calls, historicalCachedShare: row.input ? row.cached / row.input : null,
      ...(current ? { calls: current.calls, cacheChecks: current.checks, cacheMissCalls: current.misses, cacheRecoveryChecks: current.recovery, maxCacheMissStreak: current.longest, latestCacheMissStreak: current.streak } : {}),
      cachedShare: current?.input ? current.cached / current.input : null, fixedPrefixes: prefixes.size };
  }) };
}
export function nativeSessionReportHtml(date = day()): string {
  const report = nativeSessionReport(date);
  const escape = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  const number = (n: number) => n.toLocaleString('en-US');
  const agentName = (name: string) => name === 'chief-of-staff' ? 'Max' : name.split('-').map(word => word[0]?.toUpperCase() + word.slice(1)).join(' ');
  const engineName = (engine: string) => engine === 'claude-code' ? 'Claude Code' : engine === 'codex' ? 'Codex' : engine;
  const connectionName = (provider: string) => (({ claude: 'Claude subscription', zai: 'Z.ai', xai: 'xAI', fireworks: 'Fireworks', openrouter: 'OpenRouter', openrouter2: 'OpenRouter Personal', codex: 'ChatGPT subscription' } as Record<string, string>)[provider] ?? provider);
  const modelName = (model: string) => {
    const id = model.replace(/^accounts\/fireworks\/models\//, '').replace(/^[^/]+\//, '').replace(/\[1m\]$/, '');
    const known: Record<string, string> = {
      'claude-sonnet-5-5': 'Claude Sonnet 5.5', 'claude-opus-5-5': 'Claude Opus 5.5',
      'gemini-4-argon': 'Gemini 4 Argon', 'grok-4.7': 'Grok 4.7',
      'gpt-6.1-sol': 'GPT 6.1 Sol', 'glm-5p3-flash': 'GLM 5.3 Flash',
      'glm-5.3-flash': 'GLM 5.3 Flash', 'qwen3.8-flash': 'Qwen 3.8 Flash',
      'deepseek-v4.1-flash-1017': 'DeepSeek 4.1 Flash',
    };
    return known[id] ?? id;
  };
  const time = (at: number) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(at);
  const needsCheck = (row: any) => row.failures.length > 0 || row.replacements > 0 || (row.maxCacheMissStreak >= 2 && row.cacheRecoveryChecks < 2) || row.starts.at(-1) > (sessionPolicy(`bot-${row.lane}`).startTokenCeiling ?? 33_000) || (row.compacts.at(-1)?.sessionKey === row.latestSessionKey && row.compacts.at(-1)?.measuredAfter > (sessionPolicy(`bot-${row.lane}`).startTokenCeiling ?? 33_000));
  const attentionCount = report.rows.filter(needsCheck).length;
  const firstAt = Math.min(...report.rows.map(row => row.firstAt));
  const lastAt = Math.max(...report.rows.map(row => row.lastAt));
  const cards = report.rows.sort((a, b) => Number(needsCheck(b)) - Number(needsCheck(a)) || b.latestCacheMissStreak - a.latestCacheMissStreak).map(row => {
    const cached = row.cachedShare === null ? 'Not measured' : `${(row.cachedShare * 100).toFixed(1)}%`;
    const ceiling = sessionPolicy(`bot-${row.lane}`).startTokenCeiling ?? 33_000;
    const oversized = row.starts.filter((n: number) => n > ceiling);
    const latestCompact = row.compacts.at(-1);
    const latestAfter = latestCompact ? latestCompact.measuredAfter : row.afterCompacts.at(-1);
    const latestCore = latestCompact?.coreInput;
    const currentCompacted = latestCompact?.sessionKey === row.latestSessionKey;
    const currentStartTooLarge = row.starts.at(-1) > ceiling;
    const cacheWarning = row.maxCacheMissStreak >= 2 && row.cacheRecoveryChecks < 2;
    const cacheStatus = cacheWarning ? `Cache needs a look · ${row.latestCacheMissStreak >= 2 ? `${number(row.latestCacheMissStreak)} misses in a row` : 'repeat misses recorded; recovery not proven'}`
      : row.cacheChecks >= 2 && row.cacheMissCalls === 0 ? `History reused on all ${number(row.cacheChecks)} comparable calls`
      : row.maxCacheMissStreak >= 2 ? `Earlier cache misses recovered · ${number(row.cacheRecoveryChecks)} successful checks since`
      : row.cacheChecks >= 2 ? `${number(row.cacheChecks - row.cacheMissCalls)} of ${number(row.cacheChecks)} checks reused history; no repeated misses`
      : 'History reuse needs more evidence';
    const headroom = currentStartTooLarge ? `Latest start exceeds ${number(ceiling)}`
      : !currentCompacted ? row.starts.length ? `Start fits ${number(ceiling)} · current session has not compacted yet` : 'Current session has not compacted yet'
      : latestAfter > ceiling ? `After compaction needs a look · ${number(latestAfter)} / ${number(ceiling)} tokens`
      : latestAfter > 0 ? `After compaction · full input fits ${number(ceiling)}`
      : row.compacts.length ? 'Engine compaction recorded · next input not measured'
      : row.starts.length ? `Starts fit ${number(ceiling)} · no compaction due yet` : 'Start not measured yet';
    const contexts = (context?: WorkingContext) => context
      ? ` Saved summary: ${number(context.summaryCharacters)} characters; working files: ${number(context.files)}, ${number(context.fileCharacters)} characters. Characters are not token counts.` : '';
    const detailRows = row.compacts.map((x: any) => `<li><strong>${x.kind === 'automatic' ? 'Automatic' : x.kind === 'manual' ? 'Manual' : 'Native engine compaction'}</strong> · ${time(x.at)}<br>${x.before > 0 ? `${number(x.before)} before` : 'Before size not recorded'} → ${x.measuredAfter > 0 ? `${number(x.measuredAfter)} first real request after` : (x.measurementPending ? 'Reading saved total; refresh shortly' : 'No verified total in the saved history')}${x.measuredAt ? ` · ${time(x.measuredAt)} ET` : ''}${x.measurementSource === 'native-transcript' ? ' · verified from the saved native history' : ''}${x.after > 0 ? ` (${number(x.after)} engine-reported after size)` : ''}.${contexts(x.workingContext)}</li>`).join('');
    const details = detailRows ? `<div class="compact-history"><ul>${detailRows}</ul></div>` : '';
    const unpaired = row.postCompactChecks.filter((x: any) => !row.compacts.some((c: any) => c.sessionId === x.sessionId && c.measuredAt === x.at)).map((x: any) => `<li>${time(x.at)} · ${number(x.input)} measured total after compaction.${contexts(x.workingContext)}</li>`).join('');
    const bound = latestCore > 0
      ? `<p>Vendor-measured instructions + native summary: at most ${number(latestCore)} tokens. The full request, including working files, is the target; ${latestAfter > 0 ? `the full next request measured ${number(latestAfter)} tokens.` : 'the full next request has not been recorded.'}</p>`
      : latestAfter > ceiling ? `<p>The full next request measured ${number(latestAfter)} tokens including restored working files. The target is ${number(ceiling)} tokens for the whole next request, including current work.</p>`
      : latestAfter > 0 ? `<p>The full next request fits ${number(ceiling)} tokens, including instructions, summary and current work.</p>` : '';
    const restartHistory = (row.interruptions.length ? `<p>${number(row.interruptions.length)} ${row.interruptions.length === 1 ? 'turn was' : 'turns were'} interrupted by a TARDIS restart. These are not failed model turns.</p>` : '')
      + (row.pendingRestartChecks.length ? '<p>Checking saved restart history; refresh shortly.</p>' : '');
    const errorReason = (failure: { at: number; reason: string }) => `${time(failure.at)} ET · ${/turn error has the details|Turn error has details in the chat|^Codex ended without an answer\./i.test(failure.reason) ? 'The engine returned a failed turn. Open this lane’s chat at that time for the provider message.' : failure.reason}`;
    const visibleWarning = row.failureDetails.length ? `<p class="verdict attention">${escape(errorReason(row.failureDetails.at(-1)))}</p>` : row.replacements ? `<p class="verdict attention">${number(row.replacements)} unexpected saved-session ${row.replacements === 1 ? 'change' : 'changes'} recorded</p>` : '';
    const health = restartHistory + (row.failures.length ? `<p class="attention">Session errors need a look</p><div class="compact-history"><ul>${row.failureDetails.map((failure: { at: number; reason: string }) => `<li>${escape(errorReason(failure))}</li>`).join('')}</ul></div>`
      : row.pendingRestartChecks.length ? '' : row.recovered.length ? `<p>${number(row.recovered.length)} earlier session ${row.recovered.length === 1 ? 'issue recovered' : 'issues recovered'}. No unresolved errors recorded.</p>` : '<p>No unresolved session errors recorded.</p>');
    const startCheck = row.starts.length ? `Latest start: ${number(row.starts.at(-1))} tokens${row.starts[0] !== row.starts.at(-1) ? ` (first measured: ${number(row.starts[0])})` : ''}. ${oversized.length ? `${number(oversized.length)} ${oversized.length === 1 ? 'start exceeded' : 'starts exceeded'} ${number(ceiling)}.` : `All measured starts fit ${number(ceiling)}.`}` : 'No fresh start measured in this window.';
    const overhead = `${row.startupHarnessChars !== null ? `Latest startup text: ${number(row.startupHarnessChars)} characters${row.firstStartupHarnessChars !== row.startupHarnessChars ? ` (first measured: ${number(row.firstStartupHarnessChars)})` : ''}. ` : ''}${row.maxHarnessChars !== null ? `Added per turn: ${row.minHarnessChars === row.maxHarnessChars ? number(row.minHarnessChars) : `${number(row.minHarnessChars)}–${number(row.maxHarnessChars)}`} characters. Changed status adds one notice.` : 'Added text per turn has not been measured separately.'}${row.unclassifiedHarnessChars !== null ? ' Earlier combined measurements are excluded from the per-turn comparison.' : ''}`;
    const automatic = row.compacts.filter((c: any) => c.kind === 'automatic').length;
    const manual = row.compacts.filter((c: any) => c.kind === 'manual').length;
    const native = row.compacts.length - automatic - manual;
    const peak = Math.max(row.peakInput, ...row.compacts.map((c: any) => c.before || 0));
    const latestProvider = row.latestModel?.startsWith('accounts/fireworks/') ? 'fireworks' : row.latestProvider;
    const claudeSubscription = row.engine === 'claude-code' && (!latestProvider || latestProvider === 'claude' || latestProvider === 'assistant') && /^claude-/.test(row.latestModel || '');
    const fullClaudeWindow = /^claude-(sonnet|opus)-5-5(?:\[1m\])?$/.test(row.latestModel || '');
    const compactTarget = NATIVE_COMPACT_TOKENS;
    const autoStatus = row.engine === 'agy' || agentForChatId(`bot-${row.lane}`)?.engine === 'agy'
      ? 'Gemini through Antigravity chooses its own compaction point; a 180,000-token limit is not configured. The measurements here belong to the recorded engine.'
      : row.compacts.length ? `${automatic ? `${automatic} automatic. ` : ''}${manual ? `${manual} manual. ` : ''}${native ? `${native} native engine compactions; trigger type was not reported. ` : ''}`
      : row.calls === 0 ? 'No conversation call measured yet.'
      : row.engine === 'claude-code' && !claudeSubscription ? `No native compaction recorded yet; target ${number(compactTarget)} tokens, or earlier for a smaller provider window.`
      : claudeSubscription && !fullClaudeWindow ? `This Claude model compacts by ${number(compactTarget)} tokens, or earlier if its context limit is smaller.`
      : peak < compactTarget ? `No compaction due yet: largest call ${number(peak)}; target ${number(compactTarget)}.` : 'Context reached the compaction target; no compaction record is available yet.';
    const providers = latestProvider ? connectionName(latestProvider) : row.engine === 'codex' ? 'ChatGPT subscription' : 'Not recorded';
    const auxiliary = row.auxiliaryCalls ? `<p>Separate engine calls, including summaries: ${number(row.auxiliaryCalls)} calls; ${number(row.auxiliaryInput)} input tokens, ${number(row.auxiliaryCached)} from cache${row.auxiliaryInput > 0 ? ` (${(row.auxiliaryCached / row.auxiliaryInput * 100).toFixed(1)}%)` : ''}. These are excluded from the conversation share above.</p>` : '<p>Separate engine-call cache usage has not been recorded.</p>';
    return `<article class="${cacheWarning ? 'cache-warning' : ''}"><div class="identity"><h2>${escape(agentName(row.lane))}</h2><span>${escape(engineName(row.engine))}</span></div><p class="models">${row.latestModel ? escape(modelName(row.latestModel)) : 'Model usage not recorded'} · ${escape(providers)}</p><p class="freshness">Last record ${time(row.lastAt)} ET</p><div class="cache"><strong>${cached}</strong><span>input from cache<br>${row.calls ? `${number(row.calls)} measured conversation ${row.calls === 1 ? 'call' : 'calls'}` : 'Conversation calls not measured'}</span><i aria-hidden="true"></i></div>${row.cachedShare !== null ? `<meter aria-label="Input from cache for ${escape(agentName(row.lane))}" min="0" max="1" value="${row.cachedShare}"></meter>` : '<p>Cache share not measured.</p>'}<p class="verdict ${cacheWarning ? 'attention' : ''}">${cacheStatus}</p><p class="verdict ${currentStartTooLarge || currentCompacted && latestAfter > ceiling ? 'attention' : ''}">${headroom}</p>${visibleWarning}<dl><div><dt>Latest start · tokens</dt><dd>${row.starts.length ? number(row.starts.at(-1)) : 'Not measured'}</dd></div><div><dt>Highest recorded · tokens</dt><dd>${row.calls ? number(row.peakInput) : 'Not measured'}</dd></div><div><dt>Unexpected session changes</dt><dd>${row.replacements}</dd></div><div><dt>First request after compact</dt><dd>${latestAfter > 0 ? number(latestAfter) : row.compacts.length ? latestCompact?.measurementPending ? 'Reading saved total' : 'Not recorded in saved history' : 'Not due yet'}${latestCompact && !currentCompacted ? '<small> · earlier session</small>' : ''}</dd></div></dl><details><summary>Explore ${escape(agentName(row.lane))}'s session <span aria-hidden="true">⌄</span></summary><p>${autoStatus}</p><p>${escape(startCheck)}</p><p>${escape(overhead)}</p>${bound}${details}${unpaired ? `<ul>${unpaired}</ul>` : ''}<p>Cache checks compare each growing request with the previous request in the same session, skipping the first call after compaction. ${number(row.cacheMissCalls)} of ${number(row.cacheChecks)} checks reused less than 80% of that previous context${cacheWarning ? `; the longest run was ${number(row.maxCacheMissStreak)} misses` : ''}. Latest run: ${number(row.latestCacheMissStreak)} misses. ${number(row.cacheRecoveryChecks)} comparable calls have reused history since the last miss or compaction; recovery requires two.</p>${auxiliary}${health}<p>Connection: ${escape(providers)}. ${row.fixedPrefixes ? `${number(row.fixedPrefixes)} different instruction/tool ${row.fixedPrefixes === 1 ? 'catalog was' : 'catalogs were'} seen; discovery can change them, so this alone is not a cache failure.` : 'The engine did not supply an instruction/tool catalog fingerprint.'}<br>Model IDs: ${row.models.map(escape).join(' · ') || 'Not recorded'}.</p></details></article>`;
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Session health · ${escape(date)}</title><style>
  *{box-sizing:border-box}body{margin:0;background:#0b1014;color:#edf7f4;font:15px system-ui,sans-serif;padding:clamp(20px,5vw,64px)}body:before{content:"";position:fixed;inset:-30%;pointer-events:none;background:radial-gradient(ellipse at 20% 15%,#244c3928,transparent 45%),radial-gradient(ellipse at 80% 70%,#34586720,transparent 45%);animation:drift 18s ease-in-out infinite alternate;z-index:-1}main{max-width:1320px;margin:auto}header{margin:0 0 30px}header small{color:#9ce7c5;text-transform:uppercase;letter-spacing:.16em}h1{font-size:clamp(32px,5vw,56px);letter-spacing:-.05em;margin:12px 0}header p{max-width:740px;line-height:1.6;color:#a3b9b0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:18px;align-items:start}article{background:linear-gradient(145deg,#182821,#121c1c);border:1px solid #2c4338;border-radius:24px;padding:24px;transition:transform .22s cubic-bezier(.2,.8,.2,1),border-color .2s,box-shadow .2s}article:not(:has(details[open])):hover{transform:translateY(-6px) rotate(-.4deg) scale(1.01);border-color:#9ce7c5;box-shadow:0 18px 40px #0005}article:focus-within{border-color:#b8f6d4;box-shadow:0 0 0 3px #9ce7c533}.identity{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:14px}.identity h2{font-size:22px;margin:0;overflow-wrap:anywhere}.models{color:#b4c5be;font-size:13px;line-height:1.5;overflow-wrap:anywhere;margin:12px 0 0}.identity span{white-space:nowrap;color:#c4d8cd;border:1px solid #3d5547;padding:5px 9px;border-radius:99px;font-size:12px}.cache{display:flex;align-items:baseline;gap:10px;margin-top:24px}.cache strong{font-size:42px;letter-spacing:-.05em}.cache i{align-self:center;width:8px;height:8px;border-radius:100%;background:#9ce7c5;box-shadow:0 0 14px #9ce7c577;animation:breathe 3s ease-in-out infinite}.cache span,dt{color:#9eb8ab;font-size:13px}meter{display:block;width:100%;height:10px;margin:10px 0 24px;accent-color:#a0e8be}dl{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin:0}dd{margin:5px 0 0;font-size:18px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}details{border-top:1px solid #2d4538;margin-top:24px;padding-top:12px;font-size:13px;line-height:1.6}summary{display:flex;align-items:center;justify-content:space-between;min-height:48px;padding:12px;gap:12px;cursor:pointer;list-style:none;color:#b8f6d4;border-radius:12px;background:#9ce7c509;transition:background .2s,transform .2s}summary::-webkit-details-marker{display:none}summary:hover{color:white;background:#9ce7c51c;transform:translateY(-2px)}summary:focus-visible{outline:3px solid #b8f6d4;outline-offset:4px}summary span{font-size:20px;transition:transform .25s cubic-bezier(.2,1.6,.4,1)}details[open] summary{background:#254335}details[open] summary span{transform:rotate(180deg)}summary:active{transform:scale(.97)}details p,details li{color:#b4c5be;overflow-wrap:anywhere}details[open]>p,details[open]>ul{animation:unfold .25s ease-out}ul{padding-left:18px}li+li{margin-top:12px}.compact-history{max-height:380px;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable}.attention{color:#ffcba0!important}.cache-warning{border-color:#986b3c}.cache-warning .cache i{background:#ffcba0;box-shadow:0 0 14px #ffcba077}.cache-warning meter{accent-color:#ffcba0}meter::-webkit-meter-optimum-value{background:#9ce7c5}.cache-warning meter::-webkit-meter-optimum-value{background:#ffcba0}.cache-warning meter::-moz-meter-bar{background:#ffcba0}.verdict{font-size:13px;line-height:1.5;margin:10px 0}.freshness{font-size:12px;color:#a3b9b0}.overview{display:flex;flex-wrap:wrap;gap:12px;margin:20px 0}.overview span{border:1px solid #456050;border-radius:14px;padding:10px 14px;background:#182821}.empty{border:1px dashed #456050;border-radius:24px;padding:32px;color:#b4c5be}@keyframes breathe{50%{opacity:.4;transform:scale(.7)}}@keyframes drift{to{transform:translate(4%,3%) rotate(4deg)}}@keyframes unfold{from{opacity:0;transform:translateY(-5px)}to{opacity:1;transform:none}}@media(prefers-reduced-motion:reduce){*,:before{animation:none!important;transition:none!important}}
  </style></head><body><main><header><small>TARDIS · ${escape(date)} · ET</small><h1>Room to think.</h1><p>See where memory and caching need a look. Open any card for the real measurements, including what we cannot prove yet.</p><p>Configured compaction target: 180,000 tokens for Claude Code and Codex. Gemini through Antigravity chooses its own compaction point; its 180,000-token limit is not configured.</p>${report.rows.length ? `<p>Measured ${time(firstAt)}–${time(lastAt)} ET. These records cover the whole date, including earlier compaction settings. Highest recorded is the daily peak, not the current context size. Cache shares include cold starts and the first call after compaction.</p><div class="overview"><span>${attentionCount} ${attentionCount === 1 ? 'lane has' : 'lanes have'} checks to review</span><span>${report.rows.length} lanes measured</span></div>` : ''}</header><section class="grid" aria-label="Agent session measurements, current issues first">${cards || '<p class="empty">No calls measured for this date yet. The first real agent call will appear here.</p>'}</section></main></body></html>`;
}
export function startSessionMetricsReport(): void {
  let last = '';
  const tick = () => {
    const now = Date.now();
    if (inQuietHours(now)) return;
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' }).format(now));
    if (hour !== 21 || last === day(now)) return;
    mkdirSync(directory, { recursive: true });
    const file = join(directory, `${day(now)}.html`);
    if (existsSync(file)) { last = day(now); return; }
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, nativeSessionReportHtml(), { mode: 0o600 });
    renameSync(tmp, file);
    last = day(now);
  };
  const timer = setInterval(() => { try { tick(); } catch { console.warn('[native-session] nightly report failed'); } }, 60_000);
  timer.unref();
}
