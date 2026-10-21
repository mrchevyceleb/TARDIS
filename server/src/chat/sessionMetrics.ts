import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs';
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
type WorkingContext = { files: number; fileCharacters: number; summaryCharacters: number };
type Metric = NativeCall & { workingContext?: WorkingContext; at: number; event: string; cachedShare?: number; before?: number; after?: number; trigger?: string; reason?: string };
const directory = join(STATE_DIR, 'native-session-metrics');
const alerted = new Set<string>();
const sessions = new Map<string, string>();
const nextCall = new Set<string>();
const cacheHistory = new Map<string, { input: number; misses: number }>();
const pendingFile = join(directory, 'pending-compacts.json');
function pendingCompacts(): string[] {
  try { const values = JSON.parse(readFileSync(pendingFile, 'utf8')); return Array.isArray(values) ? values.filter(value => typeof value === 'string') : []; } catch { return []; }
}
const afterCompact = new Set<string>(pendingCompacts());
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
  const justCompacted = afterCompact.delete(sessionKey);
  if (justCompacted) {
    savePendingCompacts();
    append({ ...call, at: call.at ?? Date.now(), cached, event: 'after-compact', cachedShare,
      ...(call.engine === 'claude-code' ? { workingContext: nativeWorkingContext(call.lane, call.sessionId) } : {}) });
    // This total includes native re-attached working files. The fixed-start
    // ceiling is checked on the actual start, not on restored working context.
  }
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
  append({ at: Date.now(), event: 'compact', lane, engine, model: '', sessionId: sessionId ?? undefined, input: 0, cached: 0, output: 0, before, after, trigger: String(metadata?.trigger ?? 'native') });
  afterCompact.add(`${bareChatId(lane)}|${engine}|${sessionId || ''}`);
  savePendingCompacts();
  // Native metadata can exclude the fixed prompt. Measure the next real call.
}
export function recordNativeNotice(lane: string, engine: string, reason: string): void {
  append({ at: Date.now(), event: 'notice', lane, engine, model: '', input: 0, cached: 0, output: 0, reason });
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
  const lastInputs = new Map<string, number>();
  for (const event of records) {
    if (event.auxiliary || event.event === 'notice' || /Cross-engine switch involving Codex is held/.test(event.reason || '')) continue;
    const key = `${bareChatId(event.lane)}|${event.engine}`;
    const row = lanes.get(key) ?? { lane: bareChatId(event.lane).replace(/^bot-/, ''), engine: event.engine, calls: 0, input: 0, cached: 0, starts: [], compacts: [], afterCompacts: [], workingContexts: [], failures: [], recovered: [], models: new Set<string>(), providers: new Set<string>(), replacements: 0, maxHarnessChars: 0, prefixes: new Set<string>() };
    if (event.model) row.models.add(event.model);
    if (event.provider) row.providers.add(event.provider);
    if (event.event === 'compact' || (event.input > 0 && event.event !== 'after-compact')) {
      const resolved = row.failures.filter((reason: string) => /Native (?:resume|compact)|old provider/i.test(reason));
      row.recovered.push(...resolved);
      row.failures = row.failures.filter((reason: string) => !resolved.includes(reason));
    }
    if (event.event === 'replacement') row.replacements++;
    const sessionKey = `${key}|${event.sessionId || ''}`;
    if (event.event === 'compact') row.compacts.push({ before: event.before || lastInputs.get(sessionKey), after: event.after, trigger: event.trigger });
    if (event.input > 0) lastInputs.set(sessionKey, event.input);
    if (event.event === 'start') row.starts.push(event.input);
    if (event.event === 'failure') row.failures.push(event.reason);
    if (event.event === 'after-compact') {
      const compact = row.compacts.at(-1);
      if (compact && !compact.after) compact.after = event.input;
      row.afterCompacts.push(event.input); if (event.workingContext) row.workingContexts.push(event.workingContext); }
    if (event.input && event.event !== 'after-compact') { row.calls++; row.input += event.input; row.cached += event.cached; }
    row.maxHarnessChars = Math.max(row.maxHarnessChars, event.harnessChars ?? 0);
    if (event.prefix) row.prefixes.add(event.prefix);
    lanes.set(key, row);
  }
  return { date, rows: [...lanes.values()].map(({ prefixes, models, providers, ...row }) => ({ ...row, models: [...models], providers: [...providers], cachedShare: row.input ? row.cached / row.input : null, fixedPrefixes: prefixes.size })) };
}
export function nativeSessionReportHtml(date = day()): string {
  const report = nativeSessionReport(date);
  const escape = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  const number = (n: number) => n.toLocaleString('en-US');
  const sizes = (values: number[]) => values.length ? values.map(number).join(' · ') : 'Not measured';
  const agentName = (name: string) => name === 'chief-of-staff' ? 'Max' : name.split('-').map(word => word[0]?.toUpperCase() + word.slice(1)).join(' ');
  const engineName = (engine: string) => engine === 'claude-code' ? 'Claude Code' : engine === 'codex' ? 'Codex' : engine;
  const cards = report.rows.map(row => {
    const cached = row.cachedShare === null ? 'Not measured' : `${(row.cachedShare * 100).toFixed(1)}%`;
    const working = row.workingContexts.map((x: WorkingContext) => `<li>Native summary: ${number(x.summaryCharacters)} characters. Re-attached working files: ${number(x.files)} ${x.files === 1 ? 'file' : 'files'} · ${number(x.fileCharacters)} characters.</li>`).join('');
    const details = row.compacts.map((x: any) => `<li>${escape(x.trigger)} · ${x.before > 0 ? number(x.before) : 'Not measured'} before · ${x.after > 0 ? number(x.after) : 'Awaiting next call'} after native compact</li>`).join('');
    const health = row.failures.length
      ? `<p class="attention">Needs a look</p><ul>${row.failures.map((reason: string) => `<li>${escape(reason)}</li>`).join('')}</ul>`
      : `<p>${row.recovered.length ? `${number(row.recovered.length)} earlier ${row.recovered.length === 1 ? 'issue recovered' : 'issues recovered'} automatically. ` : ''}No unresolved session failures.</p>`;
    return `<article><div class="identity"><h2>${escape(agentName(row.lane))}</h2><span>Runner: ${escape(engineName(row.engine))}</span></div><p class="models">${row.models.map(escape).join(" · ") || "No model call yet"}</p><div class="cache"><strong>${cached}</strong><span>input from cache</span></div><meter aria-label="Input from cache for ${escape(row.lane)}" min="0" max="1" value="${row.cachedShare ?? 0}"></meter><dl><div><dt>New session</dt><dd>${sizes(row.starts)}</dd></div><div><dt>First call after compact, including working files</dt><dd>${sizes(row.afterCompacts)}</dd></div><div><dt>Unexpected resets</dt><dd>${row.replacements}</dd></div><div><dt>Calls measured</dt><dd>${number(row.calls)}</dd></div></dl><details><summary>See session detail <span aria-hidden="true">⌄</span></summary><p>${number(row.maxHarnessChars)} characters added per turn at most.${row.fixedPrefixes ? ` ${number(row.fixedPrefixes)} measured instruction ${row.fixedPrefixes === 1 ? 'version' : 'versions'}.` : ''}</p><ul>${details || '<li>No native compaction measured yet.</li>'}${working}</ul>${health}</details></article>`;
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Session health · ${escape(date)}</title><style>
  *{box-sizing:border-box}body{margin:0;background:#0b1014;color:#edf7f4;font:15px system-ui,sans-serif;padding:clamp(20px,5vw,64px)}main{max-width:1320px;margin:auto}header{margin:0 0 30px}header small{color:#9ce7c5;text-transform:uppercase;letter-spacing:.16em}h1{font-size:clamp(32px,5vw,56px);letter-spacing:-.05em;margin:12px 0}header p{max-width:700px;line-height:1.6;color:#a3b9b0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:18px;align-items:start}article{background:linear-gradient(145deg,#182821,#121c1c);border:1px solid #2c4338;border-radius:24px;padding:24px;transition:transform .22s cubic-bezier(.2,.8,.2,1),border-color .2s,box-shadow .2s}article:hover{transform:translateY(-5px) rotate(-.35deg);border-color:#9ce7c5;box-shadow:0 15px 35px #0004}.identity{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:14px}.identity h2{font-size:22px;margin:0;overflow-wrap:anywhere} .models{color:#b4c5be;font-size:13px;line-height:1.5;overflow-wrap:anywhere;margin:12px 0 0}.identity span{white-space:nowrap;color:#c4d8cd;border:1px solid #3d5547;padding:5px 9px;border-radius:99px;font-size:12px}.cache{display:flex;align-items:baseline;gap:10px;margin-top:24px}.cache strong{font-size:42px;letter-spacing:-.05em}.cache span,dt{color:#9eb8ab;font-size:13px}meter{display:block;width:100%;height:10px;margin:10px 0 24px;accent-color:#a0e8be}dl{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin:0}dd{margin:5px 0 0;font-size:18px;font-variant-numeric:tabular-nums}details{border-top:1px solid #2d4538;margin-top:24px;padding-top:18px;font-size:13px;line-height:1.6}summary{cursor:pointer;list-style:none;color:#b8f6d4;border-radius:8px;transition:color .2s,transform .2s}summary:hover{color:white;transform:translateX(3px)}summary:focus-visible{outline:2px solid #b8f6d4;outline-offset:5px}summary span{float:right}details[open] summary span{transform:rotate(180deg)}summary:active{transform:scale(.97);background:#254335}details p,details li{color:#b4c5be}ul{padding-left:18px}.attention{color:#ffcba0!important}.empty{border:1px dashed #456050;border-radius:24px;padding:32px;color:#b4c5be}@media(prefers-reduced-motion:reduce){*{transition:none!important}}
  </style></head><body><main><header><small>TARDIS · ${escape(date)} · ET</small><h1>Room to think.</h1><p>See how much each agent remembers, how much input comes from cache, and whether its session stayed intact. Counts after compaction include the working files the engine brings back. Open a card for the file and summary totals.</p></header><section class="grid" aria-label="Agent session measurements">${cards || '<p class="empty">No calls measured for this date yet. The first real agent call will appear here.</p>'}</section></main></body></html>`;
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
