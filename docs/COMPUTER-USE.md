# Computer use

Every engine receives the built-in `rivendell-device` MCP: Claude, Codex,
Grok/Z.ai and Banana's OpenRouter, Fireworks and local models. Shared turn
guidance tells companions to operate desktop apps, browser sessions and agent
management UIs themselves, instead of handing routine UI steps back to the user.
Shell/API tools remain appropriate for non-UI work.

## Automatic control and the default desktop

Automatic mode is an explicit **machine-owner standing authorization**, not a
confirmation for every click. After opt-in, agents acquire five-minute leases
without approval popups. A lease coordinates access between agents; it is not
an approval queue. On expiry, agents can acquire a new lease and inspect the
screen before continuing. They must release control when finished.

For a dedicated Linux host, set these on the **companion service**:

```ini
Environment=RIVENDELL_COMPUTER_UNATTENDED=true
Environment=RIVENDELL_COMPUTER_INDICATOR=false
```

The second setting keeps native progress windows from covering the apps being
operated. Control status and Stop/Resume remain in the TARDIS console. Omit it
to retain the host's native Stop window.

Set these on the **TARDIS server**, not just the companion:

```ini
Environment=RIVENDELL_COMPUTER_DEFAULT_DEVICE=<device-id>
Environment=RIVENDELL_COMPUTER_ALLOW_BACKGROUND=true
```

Use the stable id from `device_list` or `/api/devices`. A unique device name is
also accepted in the operator setting. `computer_start` can omit `device`:
server-side resolution uses the chat's explicit selection first, then this
default. It returns the actual `device` and `session` for subsequent calls.
An offline/ambiguous default is an error, **never a reason to take over another
computer**. The local Electron PC is an explicit target, not a fallback.

The background flag is standing authorization for assigned peer/routine work.
It is off by default; background starts are rejected otherwise. Contexts are
signed caller identity, not permission to override a machine's mode. Only the
most recently issued context for an owner is valid: a later peer turn cannot
reuse that owner's earlier human context. Background work must still yield to
human conversations and cannot preempt another controller.

For an Electron computer, use **Ship → Automatic Computer Control for This
Server**. Trust is stored locally as `computerTrustedOrigin`, pinned to the
selected HTTPS/loopback origin, and is not writable through renderer IPC or a
server request. **Require Computer Control Approval** removes that opt-in.
Opening a different server does not inherit trust. Fresh installations ask for
native consent until their own operator enables automatic mode.

**Stop is not a request to retry.** The web Stop button, native Stop window,
Ship menu and local hotkey revoke the grant. In automatic mode they also pause
new grants until the operator selects **Resume control**. Agents must never
resume themselves, change trust settings, or restart a companion to get around
a pause/refusal. Pauses survive link reconnects; a new app/companion process
initializes control afresh. The native Ctrl/Command + Alt + Shift + Escape
shortcut stops **that local machine**; use the console's Stop button for a
remote host.

## Host and client setup

- **Host desktop:** `npm run computer:host`, in the logged-in graphical session.
  This is independent of Electron and controls the real desktop, not a headless
  browser. It opens no inbound port.
- **This computer:** run the updated Electron app. Windows input uses bundled
  Windows APIs rather than page-only events. No Python installation is needed.

Native input currently supports **Windows** and **GNOME X11**. macOS and
Wayland report unavailable pending native permission/portal adapters. Locked
sessions and Windows UAC/secure desktops are not controllable. SSH alone does
not create a graphical session.

Linux dependencies: `xdotool`, `wmctrl`, `x11-xserver-utils` (`xrandr`),
`maim`, `libglib2.0-bin` (`gdbus`) and `zenity` for attended prompts
or the optional native indicator. Then:

```bash
npm install
npm run computer:host
```

`DISPLAY`, `XAUTHORITY`, `DBUS_SESSION_BUS_ADDRESS` and `XDG_SESSION_TYPE` must
refer to the actual user's desktop. Never guess display numbers, use `xhost +`,
or run the companion as root. Keep machine clocks synchronized; requests have
absolute deadlines so delayed packets cannot start expired work.

An optional **user** service (adapt the checkout path):

```ini
[Unit]
Description=TARDIS desktop companion
After=graphical-session-pre.target
PartOf=graphical-session.target

[Service]
WorkingDirectory=%h/src/TARDIS
ExecStart=%h/src/TARDIS/node_modules/.bin/tsx %h/src/TARDIS/server/src/devices/host.ts
Restart=on-failure
RestartSec=3

[Install]
WantedBy=graphical-session.target
```

Import the graphical environment from a desktop terminal if necessary:

```bash
systemctl --user import-environment DISPLAY XAUTHORITY DBUS_SESSION_BUS_ADDRESS XDG_SESSION_TYPE
```

`RIVENDELL_COMPUTER_SERVER_URL` defaults to `http://127.0.0.1:8091`; any
non-loopback address requires HTTPS. `RIVENDELL_COMPUTER_NAME` sets the host's
friendly name. Identity/key state is private in `computer-host.json`; the
server stores key hashes in `device-pairings.json`. Preserve client identity
on updates. Pairing pins reconnects after first use; it is not an account login.

## Workflows, vision and retry safety

`computer_start` → `computer_inspect` → operate one exact window → verify →
`computer_stop`. Use the normal browser profile and existing sessions for
websites, including sign-in on user-authorized accounts. Never scrape unrelated
credential stores, print passwords into chat, or bypass MFA/security challenges.
External side effects remain draft/review-first.

Prefer `computer_capture(window=<id>)`. It raises and verifies that exact window before
cropping, discards pixels if focus/geometry changes during capture, then returns
a readable window-only MCP JPEG, accurate bounds, capture time and one-use frame. Mouse coordinates are
pixels in **that returned image**. The device verifies the window did not move,
focuses it before clicking, maps coordinates into OS pixels, and returns the
same window region. Whole-display frames expire after 30 seconds; exact-window
frames after 90 seconds. Any input consumes a frame.

On GNOME/X11, window positions come from X's actual client geometry. Do not use
`wmctrl -lG` positions: client-side decorated GTK windows can report incorrect
origins there even while their width/height look plausible. Windows uses
per-monitor-v2 physical coordinates and supports negative virtual-screen origins.

For terminals and Pi TUIs, **do not click the prompt**. Use
`computer_focus(window)`; then
`computer_type(window,operationId,text)`. These tools activate the exact native
window and verify the OS active-window identity before and after keyboard input.
`computer_type` does not press Enter and returns a window screenshot: verify the
text is visibly in the prompt, then call
`computer_key(window,new-operationId,["ENTER"])`. Keyboard input without an exact
window is rejected. Every type/key id is atomically reserved before async work; a retry with the
same id returns a cached outcome instead of typing/submitting twice, while
changing its window/content is rejected. Exact same-window text is also
deduplicated if a model invents another id after misreading the screenshot.
The device keeps up to 256 keyboard outcomes per five-minute grant without
retaining screenshots. A short settle delay prevents the returned screenshot
from racing queued events. When available, the Moria server adds bounded local
Tesseract OCR to targeted keyboard results. Use the screenshot and OCR as proof;
if OCR contains the exact marker, do not type it again. If the same focus/input goal fails twice, stop rather than guessing.

Text-only engines use `computer_step` for at most one visually grounded action
and a textual observation. Supply a unique `stepId` per new goal, and reuse
that **same** id on retries. The server journals the outcome before dispatch:
a lost response during post-action vision cannot execute the step again. A
reused id with different arguments is rejected. The journal is bounded to 256
steps per grant and reset on a new grant; never replay uncertain work under a
new id/grant. Pre-input failures can safely retry the same id.

Vision uses `RIVENDELL_VISION_BASE_URL` (default local LM Studio). Pin a fast
model with `RIVENDELL_COMPUTER_VISION_MODEL`, or reuse an explicit
`RIVENDELL_VISION_MODEL`. Auto mode prefers an already-loaded small VLM; it
does not silently load another large model. A labeled pixel grid prevents
confusion with internal image scaling. Slow grounding recaptures and requires
identical pixels before acting. If vision is unavailable, agents must not guess.

## Trust and privacy

GUI control is broad desktop access, **not a sandbox**. It can reach terminals,
passwords on screen, browser sessions and files outside the workspace. The
structured `device_exec/read/write/open` tools retain their existing approval
and credential-path rules; GUI access is not a route around a refusal.

Keep TARDIS on loopback or a trusted private proxy, never the public Internet.
Input APIs require the TARDIS MCP credential plus signed identity for starts;
no caller identity is held in Banana's shared MCP process. The web UI can
stop/resume existing standing authority, but cannot enable a machine's
automatic mode or forge an agent identity.

Screenshots are bounded and held for the current grant. Linux temporary files
are removed; previews are manual last-frame views, not hidden recordings.
TARDIS history omits screen image payloads and derived OCR text. OCR is
model-visible only for the current tool result and can be disabled with
`RIVENDELL_COMPUTER_OCR=off`; if Tesseract is absent, keyboard tools continue
without OCR. **The selected provider and its native CLI session may retain both
screenshots and OCR text.** Only share screens that provider may receive. Tools and guidance become available to existing warm
engines at their next genuine start; never restart busy turns to refresh them.
