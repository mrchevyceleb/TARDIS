import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { STATE_DIR } from './config.ts';
import { bareChatId, isAgentThread } from './threadKey.ts';
import { sessionPolicy } from './sessionPolicy.ts';
import { queueFlagDigest } from '../lib/flagDigest.ts';
import { inQuietHours } from '../lib/quietHours.ts';

export type NativeCall = {
  at?: number; lane: string; engine: string; model: string; sessionId?: string;
  input: number; cached: number; output: number; prefix?: string;
  auxiliary?: boolean; harnessChars?: number; provider?: string; resumed?: boolean;
};
type Metric = NativeCall & { at: number; event: string; cachedShare?: number; before?: number; after?: number; trigger?: string; reason?: string };
const directory = join(STATE_DIR, 'native-session-metrics');
const alerted = new Set<string>();
const sessions = new Map<string, string>();
const nextCall = new Set<string>();
const afterCompact = new Set<string>();
const day = (at = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
function append(record: Metric): void {
  try {
    mkdirSync(directory, { recursive: true });
    appendFileSync(join(directory, `${day(record.at)}.jsonl`), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch { console.warn('[native-session] metric could not be saved'); }
}
function alert(lane: string, reason: string): void {
  const key = `${day()}|${lane}|${reason}`;
  if (alerted.has(key)) return;
  alerted.add(key);
  queueFlagDigest('chief-of-staff', `native-session:${lane}:${reason}`, `Session health ${bareChatId(lane).replace(/^bot-/, '')}: ${reason}. Read the native session report before a restart.`, undefined, true);
}
export function recordNativeCall(call: NativeCall): void {
  if (!isAgentThread(call.lane) || !Number.isFinite(call.input) || call.input <= 0) return;
  const cached = Math.min(call.input, Math.max(0, call.cached));
  const cachedShare = cached / call.input;
  const sessionKey = `${bareChatId(call.lane)}|${call.engine}|${call.sessionId || ''}`;
  if (call.auxiliary) {
    append({ ...call, at: call.at ?? Date.now(), cached, event: 'auxiliary', cachedShare });
    return;
  }
  const first = !call.resumed && !nextCall.has(sessionKey);
  const warm = nextCall.has(sessionKey);
  nextCall.add(sessionKey);
  append({ ...call, at: call.at ?? Date.now(), cached, event: first ? 'start' : 'call', cachedShare });
  const ceiling = sessionPolicy(call.lane).startTokenCeiling ?? 33_000;
  if (afterCompact.delete(sessionKey)) {
    append({ ...call, at: call.at ?? Date.now(), cached, event: 'after-compact', cachedShare });
    if (call.input > ceiling) alert(call.lane, `first call after compact ${call.input} exceeds ${ceiling} tokens`);
  }
  if (first && call.input > ceiling) alert(call.lane, `start ${call.input} exceeds ${ceiling} tokens`);
  if (warm && cachedShare < 0.8) alert(call.lane, `cached share ${(100 * cachedShare).toFixed(1)}% is below 80%`);
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
  append({ at: Date.now(), event: 'compact', lane, engine, model: '', sessionId: sessionId ?? undefined, input: 0, cached: 0, output: 0, before, after, trigger: String(metadata?.trigger ?? 'native') });
  afterCompact.add(`${bareChatId(lane)}|${engine}|${sessionId || ''}`);
  // Native metadata can exclude the fixed prompt. Measure the next real call.
}
export function recordNativeFailure(lane: string, engine: string, reason: string): void {
  append({ at: Date.now(), event: 'failure', lane, engine, model: '', input: 0, cached: 0, output: 0, reason });
  alert(lane, reason);
}
export function fixedPrefix(request: any): string {
  // Hash only. Request text, credentials and tool arguments never enter metrics.
  return createHash('sha256').update(JSON.stringify({ system: request.system, tools: request.tools })).digest('hex');
}
export function nativeSessionReport(date = day()): { date: string; rows: any[] } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid report date');
  const file = join(directory, `${date}.jsonl`);
  const records: Metric[] = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }) : [];
  const lanes = new Map<string, any>();
  for (const event of records) {
    if (event.auxiliary) continue;
    const key = `${bareChatId(event.lane)}|${event.engine}`;
    const row = lanes.get(key) ?? { lane: bareChatId(event.lane).replace(/^bot-/, ''), engine: event.engine, calls: 0, input: 0, cached: 0, starts: [], compacts: [], afterCompacts: [], failures: [], replacements: 0, maxHarnessChars: 0, prefixes: new Set<string>() };
    if (event.event === 'replacement') row.replacements++;
    if (event.event === 'compact') row.compacts.push({ before: event.before, after: event.after, trigger: event.trigger });
    if (event.event === 'start') row.starts.push(event.input);
    if (event.event === 'failure') row.failures.push(event.reason);
    if (event.event === 'after-compact') row.afterCompacts.push(event.input);
    if (event.input && event.event !== 'after-compact') { row.calls++; row.input += event.input; row.cached += event.cached; }
    row.maxHarnessChars = Math.max(row.maxHarnessChars, event.harnessChars ?? 0);
    if (event.prefix) row.prefixes.add(event.prefix);
    lanes.set(key, row);
  }
  return { date, rows: [...lanes.values()].map(({ prefixes, ...row }) => ({ ...row, cachedShare: row.input ? row.cached / row.input : null, fixedPrefixes: prefixes.size })) };
}
export function nativeSessionReportHtml(date = day()): string {
  const report = nativeSessionReport(date);
  const escape = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  const rows = report.rows.map(row => `<tr><td>${escape(row.lane)}</td><td>${escape(row.engine)}</td><td>${escape(row.starts.join(', ') || 'No new start')}</td><td>${escape(row.compacts.map((x: any) => `${x.before} → ${x.after}`).join(', ') || 'None')}</td><td>${row.replacements}</td><td>${row.cachedShare === null ? 'Unmeasured' : `<meter min="0" max="1" value="${row.cachedShare}"></meter> ${(row.cachedShare * 100).toFixed(1)}%`}</td><td>${row.maxHarnessChars} chars</td></tr>`).join('');
  return `<!doctype html><meta charset="utf-8"><title>Native session health ${escape(date)}</title><style>body{font:16px system-ui;background:#101321;color:#eff2ff;padding:32px}table{width:100%;border-collapse:collapse}td,th{padding:14px;text-align:left;border-bottom:1px solid #394058}meter{accent-color:#96f5c5}p{color:#bbc5da}</style><h1>Session health · ${escape(date)}</h1><p>Measured native calls and compactions. Harness size is recorded in characters; it is not a token estimate. No measurement is a pass by default.</p><table><thead><tr><th>Agent</th><th>Engine</th><th>Start tokens</th><th>Native compaction</th><th>Unexpected resets</th><th>Input cached</th><th>Largest harness addition</th></tr></thead><tbody>${rows}</tbody></table>`;
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
