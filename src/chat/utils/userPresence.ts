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
 * Present = visible AND (the window has focus OR real input in the last two
 * minutes). The recent-input path still covers devtools or another pane taking
 * focus while the user is reading and scrolling the thread.
 */

export const PRESENCE_IDLE_MS = 2 * 60_000

// No input yet: loading or restarting the app is not a person arriving.
// A focused window is present anyway; an unfocused one waits for real input.
let lastInputAt = 0
let installed = false
let lastPresent: boolean | null = null
let idleTimer: number | null = null
const listeners = new Set<(present: boolean) => void>()

export function userPresent(): boolean {
  if (typeof document === 'undefined') return true
  if (document.visibilityState !== 'visible') return false
  return document.hasFocus() || Date.now() - lastInputAt < PRESENCE_IDLE_MS
}

/** Recompute; tell listeners on a change and arm the idle flip. */
function check() {
  const present = userPresent()
  if (idleTimer !== null) window.clearTimeout(idleTimer)
  idleTimer = null
  // Unfocused but recently used: re-check the moment that input goes stale.
  if (present && !document.hasFocus()) {
    idleTimer = window.setTimeout(check, Math.max(0, lastInputAt + PRESENCE_IDLE_MS - Date.now()) + 50)
  }
  if (present === lastPresent) return
  lastPresent = present
  for (const listener of [...listeners]) listener(present)
}

function onInput() {
  lastInputAt = Date.now()
  if (lastPresent !== true || idleTimer !== null) check()
}

const INPUT_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const
const INPUT_OPTIONS = { capture: true, passive: true } as const

function install() {
  if (installed || typeof window === 'undefined') return
  installed = true
  for (const type of INPUT_EVENTS) window.addEventListener(type, onInput, INPUT_OPTIONS)
  window.addEventListener('focus', check)
  window.addEventListener('blur', check)
  document.addEventListener('visibilitychange', check)
  lastPresent = userPresent()
  check()
}

/** The last subscriber left: drop the global listeners and the idle timer. */
function uninstall() {
  if (!installed) return
  installed = false
  for (const type of INPUT_EVENTS) window.removeEventListener(type, onInput, INPUT_OPTIONS)
  window.removeEventListener('focus', check)
  window.removeEventListener('blur', check)
  document.removeEventListener('visibilitychange', check)
  if (idleTimer !== null) window.clearTimeout(idleTimer)
  idleTimer = null
  lastPresent = null
}

/** Subscribe to presence flips (present -> idle and back). Returns an unsubscribe. */
export function onPresenceChange(listener: (present: boolean) => void): () => void {
  listeners.add(listener)
  install()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) uninstall()
  }
}
