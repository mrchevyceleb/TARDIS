# Computer use

Every TARDIS engine receives the built-in `rivendell-device` MCP: Claude,
Codex, Grok/Z.ai and Banana's OpenRouter, Fireworks and local models. Agent
personas do not need individual MCP setup. Operator MCP mirroring cannot
replace these reserved built-ins. Existing warm engines pick up changed MCP
configuration at their next genuine process start; never kill busy turns to
refresh tools.

## Targets

- **Host desktop:** run `npm run computer:host` in the host's logged-in graphical
  session. The companion is independent of the Electron app and controls the
  real desktop, not a headless browser.
- **This computer:** run the updated Electron app. It connects outbound to the
  server; no port is opened on the computer. Windows input uses native Windows
  APIs in a bundled helper, not Electron page events. No Python installation.

The Computer section above each chat composer selects a stable device id for
that thread. Selection is server state, not an approval. The selection does
not silently move to another machine when a device disconnects. Electron's
read-only preload identity marks **This computer**; a browser alone cannot
expose the user's OS desktop.

Current native adapters support **Windows** and **GNOME on X11**. macOS and
Wayland explicitly report unavailable; they need platform permission/portal
adapters rather than an X11 workaround. Windows UAC/secure desktops and locked
sessions are not controllable. The host companion needs a logged-in desktop;
SSH alone does not create one.

## Linux host setup

Install the project dependencies and `xdotool`, `wmctrl`, `x11-xserver-utils`
(`xrandr`), `gnome-screenshot`, `libglib2.0-bin` (`gdbus`) and `zenity` through
your OS package manager. From a terminal in the graphical session:

```bash
npm install
npm run computer:host
```

`DISPLAY`, `XAUTHORITY`, `DBUS_SESSION_BUS_ADDRESS` and `XDG_SESSION_TYPE` must
refer to that user's real desktop. Do not guess display numbers, use `xhost +`,
or run the companion as root. The GNOME screensaver's lock check must work;
otherwise input fails closed.

For an optional always-on **user** service, adapt this example to your checkout:

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

Import the graphical environment into the user service manager from a desktop
terminal if your desktop has not already done so:

```bash
systemctl --user import-environment DISPLAY XAUTHORITY DBUS_SESSION_BUS_ADDRESS XDG_SESSION_TYPE
```

Optional environment variables (none are enabled in a fresh clone):

| Variable | Meaning |
| --- | --- |
| `RIVENDELL_COMPUTER_SERVER_URL` | Server URL; defaults to `http://127.0.0.1:8091`. Non-loopback requires HTTPS. |
| `RIVENDELL_COMPUTER_NAME` | Friendly host name; otherwise the OS hostname. |
| `RIVENDELL_COMPUTER_UNATTENDED=true` | Explicit host-only opt-in to five-minute grants without an approval dialog. A native Stop indicator still appears. Never enabled implicitly. Electron ignores this setting. |

The companion stores its device identity/key in `computer-host.json` under
the configured TARDIS state directory. The server stores hashes of registered
keys in `device-pairings.json`. Keep the client key private. Restoring a client
backup should include its identity; don't delete pairing state just to bypass
a mismatch. Registration keys pin reconnects after first use; first use still
relies on the private-network boundary and native consent, not account login.

## Control and safety

An agent requests a **five-minute, per-task grant** on an explicit computer.
Electron always shows a native warning naming the agent, server and task.
Neither the web renderer nor a saved checkbox can grant screen/input access.
The native indicator, Ship → Stop Computer Control, or
**Ctrl/Command + Alt + Shift + Escape** revoke it. Closing the indicator also
stops control. On the Linux host, close/cancel the native progress window.
Keep machine clocks synchronized: desktop requests carry an absolute deadline
so a delayed network packet cannot start an expired approval. A cancelled
pending grant reserves the physical desktop until the client acknowledges
Stop, or that deadline plus a short clock margin expires.
The web Stop button and explicit chat Stop also revoke control. Disconnect,
lock/suspend (Electron), timeout and expiry invalidate the grant. The host
checks lock state before each operation. Only one request runs at a time;
competing agents get a busy answer, not interleaved keystrokes. Host and
Electron clients on the same user desktop share a physical-desktop identity
so the server also prevents parallel grants through both clients.

**GUI control is broad desktop access, not a sandbox.** It can reach terminals,
browser profiles, passwords displayed on screen, and files outside the
workspace. The existing command/path protections still govern structured
`device_exec/read/write/open` tools; they cannot constrain arbitrary GUI input.
Approve only a requested task and keep private windows out of view. Agents are
instructed to treat screen content as untrusted and seek explicit approval for
commands, sends, purchases, deletes and sensitive access. These are behavioral
requirements, not a claim that software can infer every click's consequences.
Background work must yield to visible human conversations and may not bypass a
busy desktop or denied request.

TARDIS still needs loopback or a trusted private proxy; **do not expose it to
the public Internet**. Input APIs additionally require a per-server-process
MCP credential and a signed per-turn identity for grant requests. No identity
is held in Banana's shared MCP process. A delegated worker uses its parent's
authorized context/grant; it must not invent a caller name. The trusted web UI
can stop or preview an already-granted session, but cannot invoke input APIs.

## Tool loop and vision

`device_list` → `computer_start` → `computer_inspect` → `computer_capture` →
`computer_act` → verify → `computer_stop`.

Capture returns an actual MCP JPEG image with dimensions, monitor id, OS
bounds, capture time and a one-use frame id. Coordinates are **pixels in that
resized image**; the execution device maps them to OS pixels, including
negative-origin monitors. Frames expire after 30 seconds and are invalidated
when displays change or input is attempted. A failed/uncertain action is never
replayed automatically. All key/drag operations are bounded; there is no
unbounded key-down tool.

Text-only engines use `computer_step` instead of guessing from a caption. The
operator-configured local vision model sees a fresh screen, chooses at most
one small action, and describes the screen afterward. The device applies the
same grant/frame/action checks. If post-action vision fails, the response
explicitly says input already ran. This path uses
`RIVENDELL_VISION_BASE_URL` (default local LM Studio). Pin a fast grounding model
with `RIVENDELL_COMPUTER_VISION_MODEL`, or reuse an explicit
`RIVENDELL_VISION_MODEL`. Auto mode prefers an already-loaded small VLM and
never silently loads another large model. A labeled pixel grid helps models
avoid confusing internal image scaling with screenshot coordinates. Slow
steps recapture and require identical pixels before acting; changed screens
fail closed. Vision-disabled/unavailable states produce a clear error. It is not
a generic autonomous task loop and does not perform sensitive external actions.

Screenshots are downscaled, bounded and held only for the current grant;
Linux temporary capture files are deleted. The console preview is a manual,
last-frame view, not a hidden recording. TARDIS history keeps frame metadata
but omits screen image payloads. **The selected model provider and its native
CLI session storage may retain tool images**; this is outside the relay's
retention policy. Don't share a screen containing data that provider may not
receive.
