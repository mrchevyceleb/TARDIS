/**
 * Is a person actually looking at this window? Unread badges hinge on it:
 * a thread counts as seen (mark-read POST, and the socket's watch flag) only
 * while this is true.
 *
 * visibilityState alone is not enough. Electron keeps it 'visible' unless the
 * window is minimized, even behind other windows or with nobody at the machine,
 * so an idle desktop sitting on a thread (Trenzalore on Riley's chat) kept
 * swallowing every badge meant for Matt's other devices.
 *
 * Present = visible AND (real input in the last two minutes OR (the window
 * has focus AND input in the last ten minutes)). Focus alone is not enough: a
 * forgotten window can just as easily be the focused app. The recent-input
 * path still covers devtools or another pane taking focus while someone reads
 * and scrolls the thread. Someone reading without touching anything for ten
 * minutes gets a badge that clears on their next touch.
 */

export const PRESENCE_IDLE_MS = 2 * 60_000
export const FOCUSED_IDLE_MS = 10 * 60_000

// No input yet: loading or restarting the app is not a person arriving.
// performance.now() is monotonic, so a clock change cannot stretch the window.
let lastInputAt = Number.NEGATIVE_INFINITY
let installed = false
let lastPresent: boolean | null = null
let idleTimer: number | null = null
const listeners = new Set<(present: boolean) => void>()

export function userPresent(): boolean {
  if (typeof document === 'undefined') return true
  if (document.visibilityState !== 'visible') return false
  const sinceInput = performance.now() - lastInputAt
  return sinceInput < PRESENCE_IDLE_MS || (document.hasFocus() && sinceInput < FOCUSED_IDLE_MS)
}

/** Recompute; tell listeners on a change and arm the idle flip. */
function check() {
  const present = userPresent()
  if (idleTimer !== null) window.clearTimeout(idleTimer)
  idleTimer = null
  // Present only because of recent input: re-check when it goes stale. Input
  // in between just moves lastInputAt; this check then re-arms from it.
  if (present && listeners.size > 0) {
    const idleAfter = document.hasFocus() ? FOCUSED_IDLE_MS : PRESENCE_IDLE_MS
    idleTimer = window.setTimeout(check, Math.min(idleAfter, Math.max(0, lastInputAt + idleAfter - performance.now())) + 50)
  }
  if (present === lastPresent) return
  lastPresent = present
  for (const listener of [...listeners]) listener(present)
}

function onInput() {
  lastInputAt = performance.now()
  // Already present: the armed idle check re-reads lastInputAt when it fires.
  if (lastPresent !== true) check()
}

const INPUT_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const
const INPUT_OPTIONS = { capture: true, passive: true } as const

// Installed once for the app's lifetime (a few passive listeners): the click
// or key that opens a chat happens before that chat subscribes, and must count.
function install() {
  if (installed || typeof window === 'undefined') return
  installed = true
  for (const type of INPUT_EVENTS) window.addEventListener(type, onInput, INPUT_OPTIONS)
  window.addEventListener('focus', check)
  window.addEventListener('blur', check)
  document.addEventListener('visibilitychange', check)
  lastPresent = userPresent()
}
install()

/** Subscribe to presence flips (present -> idle and back). Returns an unsubscribe. */
export function onPresenceChange(listener: (present: boolean) => void): () => void {
  install()
  listeners.add(listener)
  check()
  return () => {
    listeners.delete(listener)
    // Nobody left to tell: no idle timer needed until the next subscriber.
    if (listeners.size === 0 && idleTimer !== null) {
      window.clearTimeout(idleTimer)
      idleTimer = null
    }
  }
}
