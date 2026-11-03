// Routine schedule words for the Automations panel: presets, custom
// every-N-minutes/hours intervals, and the plain-English labels for both.
// Pure module (no React, no CSS) so tests can import it directly.
// The server accepts every:<n>m|h from 1 minute up to 31 days
// (MAX_EVERY_MINUTES in server/src/routes/routines.ts); the panel mirrors
// that range so anything typed here is something the scheduler will run.

export type EveryUnit = 'm' | 'h';

export const MAX_EVERY_MINUTES = 31 * 24 * 60;
export const CUSTOM_INTERVAL_VALUE = '__custom_interval__';

export function parseEveryInterval(schedule: string): { value: number; unit: EveryUnit } | null {
  const m = /^every:(\d+)(m|min|h|hr)$/.exec(schedule.trim().toLowerCase());
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isSafeInteger(value) || value < 1) return null;
  return { value, unit: m[2].startsWith('h') ? 'h' : 'm' };
}

export function buildEverySchedule(value: number, unit: EveryUnit): string {
  return `every:${value}${unit}`;
}

export function customIntervalLabel(value: number, unit: EveryUnit): string {
  return unit === 'h'
    ? `Every ${value} hour${value === 1 ? '' : 's'}`
    : `Every ${value} minute${value === 1 ? '' : 's'}`;
}

/** Friendly reason the typed interval cannot be saved, or null when it can. */
export function customIntervalError(raw: string, unit: EveryUnit): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return 'Type how often, like 5 or 45.';
  if (!/^\d+$/.test(trimmed)) return 'Whole numbers only.';
  const value = Number(trimmed);
  if (value < 1) return 'Use 1 or more.';
  const minutes = unit === 'h' ? value * 60 : value;
  if (minutes > MAX_EVERY_MINUTES) {
    return unit === 'h' ? 'Up to 744 hours (31 days).' : 'Up to 44,640 minutes (31 days).';
  }
  return null;
}

// Light cron humanizer for the Routines card. Shows "Weekdays · every 30 min,
// 9:12 AM–4:42 PM", not "Cron 12,42 9-16 * * 1-5".
export function humanizeRoutine(schedule: string): string {
  const every = parseEveryInterval(schedule);
  if (every) {
    return every.unit === 'h'
      ? `Every ${every.value} hour${every.value === 1 ? '' : 's'}`
      : `Every ${every.value} min`;
  }
  const d = /^(weekdays|daily):(\d{1,2}):(\d{2})$/.exec(schedule);
  if (d) {
    return `${d[1] === 'weekdays' ? 'Weekdays' : 'Daily'} · ${fmtClock(parseInt(d[2], 10), parseInt(d[3], 10))}`;
  }
  if (schedule.startsWith('cron:')) return humanizeCron(schedule.slice(5));
  return humanizeCron(schedule);
}

function fmtClock(h: number, m: number): string {
  const ap = h >= 12 ? 'PM' : 'AM';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${String(m).padStart(2, '0')} ${ap}`;
}

function parseIntList(field: string): number[] | null {
  if (!/^\d+(,\d+)*$/.test(field)) return null;
  return field.split(',').map(Number);
}

function parseStep(field: string): number | null {
  const m = /^\*\/(\d+)$/.exec(field);
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? n : null;
}

function parseRange(field: string): [number, number] | null {
  const m = /^(\d+)-(\d+)$/.exec(field);
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

function describeDays(dow: string): string {
  const sorted = (parseIntList(dow) ?? []).slice().sort((a, b) => a - b).join(',');
  if (dow === '*' || dow === '0-6' || dow === '0-7') return '';
  if (dow === '1-5') return 'Weekdays';
  if (sorted === '0,6' || dow === '6,0') return 'Weekends';
  if (sorted === '1,5') return 'Mon and Fri';
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  if (/^[0-6]$/.test(dow) || dow === '7') return DAYS[dow === '7' ? 0 : Number(dow)] ?? '';
  const list = parseIntList(dow);
  if (list?.every((d) => d >= 0 && d <= 7)) {
    return list.map((d) => DAYS[d === 7 ? 0 : d]).filter(Boolean).join(', ');
  }
  return '';
}

function joinWhen(when: string, days: string): string {
  if (days && when) return `${days} · ${when}`;
  return days || when || '';
}

export function humanizeCron(schedule: string): string {
  const raw = schedule.trim().replace(/^cron:/, '');
  const parts = raw.split(/\s+/);
  if (parts.length !== 5) return schedule;
  const [min, hour, dom, mon, dow] = parts;
  if (dom !== '*' || mon !== '*') {
    if (/^\d+$/.test(min) && /^\d+$/.test(hour) && /^\d+$/.test(dom) && mon === '*') {
      return `On the ${ordinal(Number(dom))} of every month at ${fmtClock(Number(hour), Number(min))}`;
    }
    return raw;
  }

  const days = describeDays(dow);
  const minStep = parseStep(min);
  const hourStep = parseStep(hour);
  const hourRange = parseRange(hour);
  const hourList = parseIntList(hour);
  const minList = parseIntList(min);
  const oneMin = /^\d+$/.test(min) ? Number(min) : null;

  if (minStep && hour === '*') return joinWhen(`every ${minStep} min`, days);
  if (minStep && hourRange) {
    return joinWhen(`every ${minStep} min, ${fmtClock(hourRange[0], 0)} to ${fmtClock(hourRange[1], 59)}`, days);
  }
  if (hourStep && (oneMin != null || min === '0')) {
    const mm = oneMin ?? 0;
    return joinWhen(`every ${hourStep} hours at :${String(mm).padStart(2, '0')}`, days);
  }
  if (oneMin != null && hourRange) {
    return joinWhen(`hourly at :${String(oneMin).padStart(2, '0')}, ${fmtClock(hourRange[0], oneMin)} to ${fmtClock(hourRange[1], oneMin)}`, days);
  }
  if (minList && hourRange) {
    const span = minList.length === 2 ? Math.abs(minList[1] - minList[0]) : 0;
    const start = fmtClock(hourRange[0], Math.min(...minList));
    const end = fmtClock(hourRange[1], Math.max(...minList));
    const cadence = span === 30 ? `every 30 min, ${start} to ${end}` : `at :${minList.map((n) => String(n).padStart(2, '0')).join(' and :')}, ${start} to ${end}`;
    return joinWhen(cadence, days);
  }
  if (oneMin != null && hourList) {
    const times = hourList.map((h) => fmtClock(h, oneMin)).join(', ');
    return joinWhen(times, days);
  }
  if (oneMin != null && hour === '*') {
    return joinWhen(`hourly at :${String(oneMin).padStart(2, '0')}`, days);
  }
  if (oneMin != null && /^\d+$/.test(hour)) {
    return joinWhen(fmtClock(Number(hour), oneMin), days) || `Every day at ${fmtClock(Number(hour), oneMin)}`;
  }
  return raw;
}

function ordinal(n: number): string {
  const s = n % 10;
  return `${n}${s === 1 && n !== 11 ? 'st' : s === 2 && n !== 12 ? 'nd' : s === 3 && n !== 13 ? 'rd' : 'th'}`;
}

export const SCHEDULE_PRESETS: Array<{ value: string; label: string }> = [
  { value: 'every:30m', label: 'Every 30 minutes' },
  { value: 'every:2h', label: 'Every 2 hours' },
  { value: 'every:4h', label: 'Every 4 hours' },
  { value: 'daily:09:00', label: 'Daily · 9:00 AM' },
  { value: 'daily:17:00', label: 'Daily · 5:00 PM' },
  { value: 'weekdays:09:00', label: 'Weekdays · 9:00 AM' },
  { value: 'cron:12,42 9-16 * * 1-5', label: 'Weekdays · every 30 min, 9 AM to 5 PM' },
  { value: 'cron:17 18,22,2,6 * * 1-5', label: 'Weeknights · 6 PM, 10 PM, 2 AM, 6 AM' },
  { value: 'cron:17 */4 * * 0,6', label: 'Weekends · every 4 hours' },
  { value: 'cron:23 8-17 * * 1-5', label: 'Weekdays · hourly, 8 AM to 5 PM' },
  { value: 'cron:23 21,1,5 * * 1-5', label: 'Weeknights · 9 PM, 1 AM, 5 AM' },
  { value: 'cron:23 */4 * * 0,6', label: 'Weekends · every 4 hours' },
  { value: 'cron:0 * * * *', label: 'Hourly' },
];

export const CUSTOM_INTERVAL_CHIPS: Array<{ value: number; unit: EveryUnit; label: string }> = [
  { value: 5, unit: 'm', label: '5 min' },
  { value: 15, unit: 'm', label: '15 min' },
  { value: 45, unit: 'm', label: '45 min' },
  { value: 1, unit: 'h', label: '1 hour' },
  { value: 3, unit: 'h', label: '3 hours' },
];

/** Options for the schedule picker. "Custom interval…" sits right after the
 *  every-* presets, where interval picking already lives. A schedule no
 *  preset covers keeps its own entry, unless the custom fields are already
 *  showing it (then it would just be the same choice twice). */
export function scheduleOptions(current: string, customActive = false): Array<{ value: string; label: string }> {
  const options = [...SCHEDULE_PRESETS];
  let insertAt = options.length;
  options.forEach((opt, i) => { if (opt.value.startsWith('every:')) insertAt = i + 1; });
  options.splice(insertAt, 0, { value: CUSTOM_INTERVAL_VALUE, label: 'Custom interval…' });
  const covered = SCHEDULE_PRESETS.some((p) => p.value === current)
    || (customActive && parseEveryInterval(current) !== null);
  if (covered) return options;
  return [{ value: current, label: humanizeRoutine(current) }, ...options];
}
