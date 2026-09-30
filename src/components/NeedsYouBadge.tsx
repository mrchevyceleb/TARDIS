// "Needs you: N" on every screen, the (N) prefix on the window title, and a
// desktop alert when a new high-priority item lands on the Desk. Everything
// reads the shell's /api/desk/summary poll; nothing here fetches on its own.

import { Bell, BellRing, Inbox } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useMediaQuery } from '../chat/hooks/useMediaQuery';
import { FIRST_OPEN_REF, type DeskHighItem, type DeskRef, type DeskSummary } from '../data/desk';
import { showToast } from '../native/shell';
import './needsYou.css';

/** The chip. Hidden at zero; rose and breathing while anything is high. */
export function NeedsYouBadge({ summary, onOpen }: { summary: DeskSummary | undefined; onOpen: () => void }) {
  const count = summary?.openTodos ?? 0;
  const high = summary?.highTodos ?? 0;
  if (count <= 0) return null;
  const hot = high > 0;
  const label = `Needs you: ${count}${hot ? `, ${high} high priority` : ''}`;
  const Icon = hot ? BellRing : Inbox;
  return (
    <button
      type="button"
      className={`ny-badge${hot ? ' is-hot' : ''}`}
      onClick={onOpen}
      aria-label={`${label}. Open the Desk`}
      title={`${label}. Open the first one`}
    >
      <Icon size={15} aria-hidden="true" className="ny-badge-icon" />
      <span className="ny-badge-label" aria-hidden="true">Needs you</span>
      {/* Keyed so a new count pops in. */}
      <span key={count} className="ny-badge-count" aria-hidden="true">{count > 99 ? '99+' : count}</span>
    </button>
  );
}

// ---- window title --------------------------------------------------------------------

const TITLE_PREFIX = /^\(\d+\+?\) /;

function useTitleCount(count: number): void {
  useEffect(() => {
    const base = document.title.replace(TITLE_PREFIX, '');
    document.title = count > 0 ? `(${count > 99 ? '99+' : count}) ${base}` : base;
  }, [count]);
  useEffect(() => () => { document.title = document.title.replace(TITLE_PREFIX, ''); }, []);
}

// ---- desktop alerts ------------------------------------------------------------------

/** Per device: the high items this browser has already alerted on (or chose
 *  not to). Missing means this device has never run the alerts. */
const SEEN_KEY = 'rivendell:needs-you-seen';
const SEEN_CAP = 200;
const DAY_MS = 86_400_000;
const COALESCED_TAG = 'rivendell-needs-you';

function readSeen(): string[] | null {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : null;
  } catch {
    return null;
  }
}

function writeSeen(ids: string[]): void {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(ids)); } catch { /* private mode: alerts may repeat */ }
}

/** Which high items to alert on now, and the seen list to keep. First run seeds
 *  everything silently. Quiet hours hold new items (unmarked) so they go out
 *  when quiet ends. A focused window, or an item over a day old, is marked
 *  seen without an alert. */
function planAlerts(high: DeskHighItem[], seen: string[] | null, opts: { quiet: boolean; focused: boolean; now: number }): { seen: string[]; fire: DeskHighItem[] } | null {
  if (seen === null) return { seen: high.map((h) => h.id).slice(-SEEN_CAP), fire: [] };
  const known = new Set(seen);
  const fresh = high.filter((h) => h.id && !known.has(h.id));
  if (!fresh.length || opts.quiet) return null;
  const fire = opts.focused ? [] : fresh.filter((h) => {
    const created = Date.parse(h.createdAt);
    return !Number.isFinite(created) || opts.now - created < DAY_MS;
  });
  return { seen: [...seen, ...fresh.map((h) => h.id)].slice(-SEEN_CAP), fire };
}

function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.Notification === 'function';
}

function showAlert(items: DeskHighItem[], open: (ref: DeskRef) => void): void {
  const single = items.length === 1 ? items[0] : null;
  const shown = items.slice(0, 3).map((h) => h.title);
  const more = items.length - shown.length;
  try {
    const alert = single
      ? new Notification(single.title, { body: single.from ? `From ${single.from}` : 'On the Desk', tag: single.id, icon: '/icon-192.png' })
      : new Notification(`${items.length} things need you`, {
          body: [...shown, ...(more > 0 ? [`+${more} more`] : [])].join('\n'),
          tag: COALESCED_TAG,
          icon: '/icon-192.png',
        });
    alert.onclick = () => {
      try { window.focus(); } catch { /* the OS decides */ }
      open(single ? { kind: 'todo', id: single.id } : FIRST_OPEN_REF);
      alert.close();
    };
  } catch {
    // Some mobile browsers only show alerts from a service worker; TARDIS ships
    // none on purpose, and the phone gets its pushes another way.
  }
}

/** Title count plus desktop alerts. Call once per shell with the summary poll. */
export function useNeedsYouAlerts(summary: DeskSummary | undefined, onOpen: (ref: DeskRef) => void): void {
  useTitleCount(summary?.openTodos ?? 0);
  const openRef = useRef(onOpen);
  useEffect(() => { openRef.current = onOpen; }, [onOpen]);

  useEffect(() => {
    // An older server has no `answerable`: stay silent and do not seed, so the
    // first run happens once the server can say what is new.
    if (!summary?.answerable || !Array.isArray(summary.high) || !notificationsSupported()) return;
    const plan = planAlerts(summary.high, readSeen(), {
      quiet: summary.quiet === true,
      focused: document.visibilityState === 'visible' && document.hasFocus(),
      now: Date.now(),
    });
    if (!plan) return;
    writeSeen(plan.seen);
    if (plan.fire.length && Notification.permission === 'granted') showAlert(plan.fire, (ref) => openRef.current(ref));
  }, [summary]);
}

/** Browsers ask before showing alerts, and only from a click. The desktop app
 *  grants them itself, and phones get pushes instead, so this only shows in a
 *  desktop browser that has not been asked yet. */
export function DesktopAlertsButton() {
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(
    () => (notificationsSupported() ? Notification.permission : 'unsupported'),
  );
  const phone = useMediaQuery('(max-width: 760px), (pointer: coarse) and (max-width: 1180px)');
  if (permission !== 'default' || phone) return null;
  const ask = () => {
    void Promise.resolve(Notification.requestPermission())
      .then((next) => {
        setPermission(next);
        showToast(next === 'granted'
          ? 'Desktop alerts are on. New high-priority items will ping this computer.'
          : 'Desktop alerts stay off. You can allow them in this site\'s browser settings.');
      })
      .catch(() => { showToast('This browser would not ask about alerts. Allow them in this site\'s browser settings.'); });
  };
  return (
    <button type="button" className="desk-mini-btn ny-alerts-btn" onClick={ask} title="Get a desktop alert when a high-priority item needs you">
      <Bell size={14} aria-hidden="true" />
      <span>Turn on desktop alerts</span>
    </button>
  );
}
