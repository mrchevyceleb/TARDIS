# Robot companion

TARDIS can give its companions a body. A small Python service runs on a desk
robot, dials into the ship over the same `/ws/device` link the desktop app
uses, and from then on every engine can see, speak, emote and move through it
with the `robot_*` tools. Voice rides on the existing Jarvis worker: the robot
is one more caller with a wake word, microphones and a speaker.

The reference body is the [Doly](https://github.com/robotdoly/DOLY-DIY) desk
robot (Raspberry Pi CM4, two eye displays, arms, wheels, touch and distance
sensors, edge detectors, an IMU, an 8 MP camera, microphones and a speaker).
Any robot works by implementing `robot/tardis_robot/hardware/base.py`; a mock
body ships for development.

## What the companions get

Every engine already receives the built-in `rivendell-device` MCP. When a
robot is linked it also carries:

| Tool | Does |
| --- | --- |
| `robot_list` / `robot_status` | Linked robots, battery, voice state, last expression, hardware errors. |
| `robot_say` | Speak with the robot's on-board voice, optionally with an eye animation. Refused during a live voice call, where the reply is already spoken. |
| `robot_express` | One of the eye animations (`HAPPY`, `THINK`, `PUZZLED`, `CAUTIOUS`, `LOOK LEFT`, …). |
| `robot_eyes` / `robot_leds` | Iris colour, background, iris shape; body light colour with an optional fade. |
| `robot_move` | Drive by millimetres or turn by degrees. Capped at 1 m and 360° per call; the robot refuses to drive off an edge and stops on obstacles. |
| `robot_arms` | Arm angle and speed, left, right or both. |
| `robot_look` | A camera photo, returned as an image. |
| `robot_sensors` | Touch pads, distance, edge detectors, IMU orientation, battery. |
| `robot_events` | What the robot noticed: touches, gestures, being picked up, edges, obstacles, low battery, voice summons. |
| `robot_stop` | Halt all motion. |

Turn prompts include a short `<rivendell-robot>` block only while a robot is
online, so threads without one pay nothing.

The console shows a **Robot** panel above the composer while a robot is
linked, with battery, voice state, quick expressions, a say box, stop, and the
last few events.

### Events and reflexes

The robot keeps small reflexes local: a touch gets a happy blink, an edge or a
lift stops the wheels, low battery shows on the eyes. Everything it notices is
also sent to the ship and kept in a bounded log (`/api/robots/events`).

Set `RIVENDELL_ROBOT_AGENT=<teammate name or id>` on the server to hand
notable events (long touches, gestures, edges, obstacles, low battery, voice
summons) to one companion as a team message, rate limited to one per event
type every fifteen seconds. Off by default.

### Voice

With LiveKit and ElevenLabs configured on the server (see `.env.example`),
the robot summons Jarvis on the wake word "hey Jarvis" or a long press on a
touch pad, and ends the call on a double tap, on silence, or when the agent
closes. Its Jarvis thread is `jarvis-robot-<name>`, which adds a robot-body
addendum to the spoken persona: the model knows the words already play from
the speaker and uses `robot_express` and friends for the physical side.

The robot has no hardware echo cancellation, so the microphone is muted while
the agent speaks (`TARDIS_VOICE_GATE=1`). Barge-in is therefore off. Set
`TARDIS_VOICE_AEC=1` to try LiveKit's software canceller as well.

## Install on a Doly

The robot needs to reach the ship. Put it on the tailnet (`curl -fsSL
https://tailscale.com/install.sh | sh && sudo tailscale up`) and use the HTTPS
address from `tailscale serve status` on the server. Plain `http://` works only
on the server itself; TARDIS has no login of its own.

On the robot:

```bash
git clone --depth 1 https://github.com/mrchevyceleb/TARDIS.git
cd TARDIS/robot
sudo ./install.sh https://your-server.your-tailnet.ts.net Doly
```

The installer creates a virtual environment under `/opt/tardis-robot` (with
`--system-site-packages`, so the preinstalled Doly SDK and OpenCV stay
visible), installs the voice and wake-word extras when they build, writes
`/etc/tardis-robot.env`, and enables `tardis-robot.service`. The service runs
as root like the SDK examples, because the SDK stops the stock Doly service
and talks to the hardware directly.

```bash
journalctl -u tardis-robot -f            # logs
sudo nano /etc/tardis-robot.env           # settings, then restart
/opt/tardis-robot/venv/bin/tardis-robot --check
```

The first link pins the robot's registration key on the server (trust on
first use). Its identity lives in `/var/lib/tardis-robot/identity.json`; keep
it private, and delete it to re-pair as a new device.

Settings (all in `/etc/tardis-robot.env`, documented in `robot/.env.example`):
`TARDIS_URL`, `TARDIS_ROBOT_NAME`, `TARDIS_ROBOT_HARDWARE` (`auto`, `doly`,
`mock`), `TARDIS_VOICE` (`auto`, `on`, `off`), `TARDIS_WAKE_WORD`,
`TARDIS_WAKE_THRESHOLD`, `TARDIS_TOUCH_SUMMON`, `TARDIS_VOICE_IDLE_SECS`,
`TARDIS_VOICE_GATE`, `TARDIS_VOICE_AEC`, `TARDIS_AUDIO_INPUT`,
`TARDIS_AUDIO_OUTPUT`, `TARDIS_ROBOT_VOLUME`, `TARDIS_EYE_COLOR`,
`TARDIS_EYE_BACKGROUND`, `TARDIS_TURN_SIGN` (flip if the Doly turns the wrong
way), `TARDIS_SOUNDS_DIR`.

## Develop without a robot

```bash
cd robot
python -m venv .venv && . .venv/bin/activate
pip install -e ".[voice]"
TARDIS_URL=http://127.0.0.1:8091 tardis-robot --hardware mock --name Sim
python -m unittest discover -s tests
```

The mock body logs every action, returns plausible sensors and a synthetic
camera frame, and takes real time to "move" so cancellation and timeouts
behave. With `--voice on` and the ship's LiveKit configured, it joins a Jarvis
room with silent audio, which is enough to exercise the token, dispatch and
data-channel path.

## Wire protocol

Same link as the desktop app (`server/src/devices/bridge.ts`), plus:

```text
robot  → server  {type:'hello', …, kind:'robot', capabilities:[…], robot:{battery, voice, expression, moving, hardware, errors}}
                 {type:'robot-state', robot:{…}}
                 {type:'event', event:{name, data}}
server → robot   {type:'request', id, op:'robot.<command>', params}
robot  → server  {type:'reply', id, ok, result|error}
```

Commands: `status`, `say`, `express`, `eyes`, `leds`, `drive`, `turn`, `arms`,
`stop`, `look`, `sensors`, `volume`, `play`, `sleep`, `wake`. Parameters are
shape-checked on the server (`server/src/devices/robots.ts`) and clamped again
on the robot. A robot must present its pairing key to register as `robot`; an
unpaired socket is listed as a plain computer and gets no `robot.*` traffic.

HTTP: `GET /api/robots`, `GET /api/robots/catalogue`, `GET /api/robots/events`,
`GET /api/robots/events/stream` (SSE), `POST /api/robots/<command>` with
`{ robot?, …params }`.
