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
  auxiliary?: boolean; harnessChars?: number; harnessPhase?: 'startup' | 'turn'; provider?: string; resumed?: boolean;
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
    const row = lanes.get(key) ?? { lane: bareChatId(event.lane).replace(/^bot-/, ''), engine: event.engine, calls: 0, input: 0, cached: 0, starts: [], compacts: [], afterCompacts: [], postCompactChecks: [], workingContexts: [], failures: [], recovered: [], models: new Set<string>(), providers: new Set<string>(), replacements: 0, minHarnessChars: null, maxHarnessChars: null, startupHarnessChars: null, unclassifiedHarnessChars: null, prefixes: new Set<string>() };
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
      row.afterCompacts.push(event.input); row.postCompactChecks.push({ input: event.input, workingContext: event.workingContext }); if (event.workingContext) row.workingContexts.push(event.workingContext); }
    if (event.input && event.event !== 'after-compact') { row.calls++; row.input += event.input; row.cached += event.cached; }
    if (event.harnessChars !== undefined && event.event !== 'after-compact') {
      const field = event.harnessPhase === 'startup' ? 'startupHarnessChars'
        : event.harnessPhase === 'turn' ? 'maxHarnessChars' : 'unclassifiedHarnessChars';
      row[field] = Math.max(row[field] ?? 0, event.harnessChars);
      if (event.harnessPhase === 'turn') row.minHarnessChars = Math.min(row.minHarnessChars ?? event.harnessChars, event.harnessChars);
    }
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
  const cards = report.rows.map(row => {
    const cached = row.cachedShare === null ? 'Not measured' : `${(row.cachedShare * 100).toFixed(1)}%`;
    const ceiling = sessionPolicy(`bot-${row.lane}`).startTokenCeiling ?? 33_000;
    const oversized = row.starts.filter((n: number) => n > ceiling);
    const working = row.postCompactChecks.map((x: { input: number; workingContext?: WorkingContext }) => {
      const context = x.workingContext;
      if (!context) return `<li>${number(x.input)} total tokens after compact. This older measurement has no saved file breakdown.</li>`;
      // Providers meter the combined request. Character-derived values are
      // estimates, never a substitute for the measured first-call ceiling.
      const fileEstimate = context.fileCharacters / 4;
      const fixedEstimate = Math.max(0, x.input - fileEstimate);
      return `<li><strong>About ${(fixedEstimate / 1000).toFixed(1)}k instruction and summary tokens</strong>, plus about ${(fileEstimate / 1000).toFixed(1)}k working-file tokens. Both are estimates (4 characters per token); the measured total is ${number(x.input)} tokens.<br>Native summary: ${number(context.summaryCharacters)} characters. Restored working files: ${number(context.files)} ${context.files === 1 ? 'file' : 'files'}, ${number(context.fileCharacters)} characters. The engine keeps these files available.</li>`;
    }).join('');
    const details = row.compacts.map((x: any) => `<li>${escape(x.trigger)} · ${x.before > 0 ? number(x.before) : 'Not measured'} before · ${x.after > 0 ? number(x.after) : 'Awaiting next call'} after native compact</li>`).join('');
    const health = row.failures.length
      ? `<p class="attention">Delivery or session errors need a look</p><ul>${row.failures.map((reason: string) => `<li>${escape(reason)}</li>`).join('')}</ul>`
      : `<p>${row.recovered.length ? `${number(row.recovered.length)} earlier ${row.recovered.length === 1 ? 'issue recovered' : 'issues recovered'} automatically. ` : ''}No unresolved delivery or session errors recorded.</p>`;
    const startCheck = oversized.length ? `<p class="attention">${number(oversized.length)} measured ${oversized.length === 1 ? 'start exceeds' : 'starts exceed'} the ${number(ceiling)}-token ceiling.</p>`
      : `<p>${row.starts.length ? `Measured starts fit the ${number(ceiling)}-token ceiling.` : 'A new-session start has not been measured today.'} After compaction, restored working files are shown separately when recorded.</p>`;
    const overhead = `${row.startupHarnessChars !== null ? `One-time startup text: ${number(row.startupHarnessChars)} characters. ` : ''}${row.maxHarnessChars !== null ? `Added text per turn: ${number(row.minHarnessChars)} to ${number(row.maxHarnessChars)} characters. Changed priorities, cards and commitments add a short notice once; unchanged status stays out.` : 'Recurring turn overhead has not been measured separately yet.'}${row.unclassifiedHarnessChars !== null ? ' Earlier measurements combine startup and recurring text and are excluded from that comparison.' : ''}`;
    const automatic = row.compacts.filter((compact: { trigger?: string }) => /auto/i.test(compact.trigger || ''));
    const autoStatus = automatic.length
      ? `<p>${number(automatic.length)} automatic ${automatic.length === 1 ? 'compaction' : 'compactions'} recorded. Latest: ${automatic.at(-1).before > 0 ? number(automatic.at(-1).before) + ' tokens' : 'size not recorded'}.</p>`
      : '<p class="attention">Automatic compaction near 300k has not been observed today.</p>';
    const providers = row.providers.length ? row.providers.join(' · ') : row.engine === 'codex' ? 'ChatGPT subscription' : 'Not recorded';
    return `<article><div class="identity"><h2>${escape(agentName(row.lane))}</h2><span>${escape(engineName(row.engine))}</span></div><p class="models">${row.models.map(modelName).map(escape).join(' · ') || 'No model call yet'}</p><div class="cache"><strong>${cached}</strong><span>input from cache<br>across ${number(row.calls)} measured calls</span><i aria-hidden="true"></i></div><meter aria-label="Input from cache for ${escape(row.lane)}" min="0" max="1" value="${row.cachedShare ?? 0}"></meter><dl><div><dt>New session · tokens</dt><dd>${sizes(row.starts)}</dd></div><div><dt>After compact · total tokens</dt><dd>${sizes(row.afterCompacts)}</dd></div><div><dt>Unexpected session changes</dt><dd>${row.replacements}</dd></div><div><dt>Calls measured</dt><dd>${number(row.calls)}</dd></div></dl><details><summary>Explore ${escape(agentName(row.lane))}'s session <span aria-hidden="true">↗</span></summary>${autoStatus}<p>${escape(overhead)}</p>${startCheck}<ul>${details || '<li>No native compaction measured today.</li>'}${working}</ul>${health}<p>Connection: ${escape(providers)}.<br>Model IDs: ${row.models.map(escape).join(' · ') || 'Not recorded'}.<br>${row.fixedPrefixes ? `${number(row.fixedPrefixes)} instruction and tool-list versions observed, including tool discovery.` : 'The native engine manages its instruction catalog; no comparable instruction fingerprint was recorded.'}</p></details></article>`;
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Session health · ${escape(date)}</title><style>
  *{box-sizing:border-box}body{margin:0;background:#0b1014;color:#edf7f4;font:15px system-ui,sans-serif;padding:clamp(20px,5vw,64px)}body:before{content:"";position:fixed;inset:-30%;pointer-events:none;background:radial-gradient(ellipse at 20% 15%,#244c3928,transparent 45%),radial-gradient(ellipse at 80% 70%,#34586720,transparent 45%);animation:drift 18s ease-in-out infinite alternate;z-index:-1}main{max-width:1320px;margin:auto}header{margin:0 0 30px}header small{color:#9ce7c5;text-transform:uppercase;letter-spacing:.16em}h1{font-size:clamp(32px,5vw,56px);letter-spacing:-.05em;margin:12px 0}header p{max-width:740px;line-height:1.6;color:#a3b9b0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:18px;align-items:start}article{background:linear-gradient(145deg,#182821,#121c1c);border:1px solid #2c4338;border-radius:24px;padding:24px;transition:transform .22s cubic-bezier(.2,.8,.2,1),border-color .2s,box-shadow .2s}article:hover{transform:translateY(-6px) rotate(-.4deg) scale(1.01);border-color:#9ce7c5;box-shadow:0 18px 40px #0005}article:focus-within{border-color:#b8f6d4;box-shadow:0 0 0 3px #9ce7c533}.identity{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:14px}.identity h2{font-size:22px;margin:0;overflow-wrap:anywhere}.models{color:#b4c5be;font-size:13px;line-height:1.5;overflow-wrap:anywhere;margin:12px 0 0}.identity span{white-space:nowrap;color:#c4d8cd;border:1px solid #3d5547;padding:5px 9px;border-radius:99px;font-size:12px}.cache{display:flex;align-items:baseline;gap:10px;margin-top:24px}.cache strong{font-size:42px;letter-spacing:-.05em}.cache i{align-self:center;width:8px;height:8px;border-radius:100%;background:#9ce7c5;box-shadow:0 0 14px #9ce7c577;animation:breathe 3s ease-in-out infinite}.cache span,dt{color:#9eb8ab;font-size:13px}meter{display:block;width:100%;height:10px;margin:10px 0 24px;accent-color:#a0e8be}dl{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin:0}dd{margin:5px 0 0;font-size:18px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}details{border-top:1px solid #2d4538;margin-top:24px;padding-top:12px;font-size:13px;line-height:1.6}summary{display:flex;align-items:center;justify-content:space-between;min-height:48px;padding:12px;gap:12px;cursor:pointer;list-style:none;color:#b8f6d4;border-radius:12px;background:#9ce7c509;transition:background .2s,transform .2s}summary::-webkit-details-marker{display:none}summary:hover{color:white;background:#9ce7c51c;transform:translateY(-2px)}summary:focus-visible{outline:3px solid #b8f6d4;outline-offset:4px}summary span{font-size:20px;transition:transform .25s cubic-bezier(.2,1.6,.4,1)}details[open] summary{background:#254335}details[open] summary span{transform:rotate(90deg)}summary:active{transform:scale(.97)}details p,details li{color:#b4c5be;overflow-wrap:anywhere}details[open]>p,details[open]>ul{animation:unfold .25s ease-out}ul{padding-left:18px}li+li{margin-top:12px}.attention{color:#ffcba0!important}.empty{border:1px dashed #456050;border-radius:24px;padding:32px;color:#b4c5be}@keyframes breathe{50%{opacity:.4;transform:scale(.7)}}@keyframes drift{to{transform:translate(4%,3%) rotate(4deg)}}@keyframes unfold{from{opacity:0;transform:translateY(-5px)}to{opacity:1;transform:none}}@media(prefers-reduced-motion:reduce){*,:before{animation:none!important;transition:none!important}}
  </style></head><body><main><header><small>TARDIS · ${escape(date)} · ET</small><h1>Room to think.</h1><p>Follow each agent's session, automatic compaction and cached input. Cache shares include new sessions and calls immediately after compaction. Totals after compaction include the working files the engine restores. Explore a card for the breakdown, measured limits and any errors.</p></header><section class="grid" aria-label="Agent session measurements">${cards || '<p class="empty">No calls measured for this date yet. The first real agent call will appear here.</p>'}</section></main></body></html>`;
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
