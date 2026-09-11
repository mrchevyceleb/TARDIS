"""The Doly body (github.com/robotdoly/DOLY-DIY), through its Python SDK.

Every subsystem is initialised independently and every SDK call is guarded:
a missing camera or a flaky sensor becomes an entry in ``status().errors``,
never a dead companion. The SDK's own service must be stopped first because
two owners of the same hardware libraries conflict; ``start()`` does that.

Enum names in the pybind11 modules are CamelCase versions of the C++ values
(``ColorCode.DarkGreen``, ``EyeSide.Both``); ``_enum`` resolves either style.
"""

from __future__ import annotations

import base64
import logging
import os
import tempfile
import threading
import time
import wave
from typing import Any

from .base import Hardware, HardwareStatus, Snapshot

log = logging.getLogger("tardis.hardware.doly")

TURN_SIGN = -1.0 if os.environ.get("TARDIS_TURN_SIGN", "-1").strip() == "-1" else 1.0


def _enum(container: Any, key: str) -> Any:
    """Resolve 'DARK_GREEN' against DARK_GREEN / DarkGreen / darkgreen."""
    if container is None:
        raise RuntimeError("SDK enum unavailable")
    wanted = key.strip().upper().replace(" ", "_")
    camel = "".join(part.capitalize() for part in wanted.split("_"))
    for candidate in (wanted, camel):
        value = getattr(container, candidate, None)
        if value is not None:
            return value
    flat = wanted.replace("_", "")
    for attr in dir(container):
        if attr.startswith("_"):
            continue
        if attr.upper().replace("_", "") == flat:
            return getattr(container, attr)
    raise ValueError(f"unknown value {key!r}")


def _name(value: Any) -> str:
    name = getattr(value, "name", None)
    if isinstance(name, str):
        return name.upper()
    text = str(value)
    return text.split(".")[-1].upper()


class DolyHardware(Hardware):
    name = "doly"
    capabilities = ["say", "express", "eyes", "leds", "drive", "turn", "arms", "look", "sensors", "touch", "tof", "edge", "imu", "battery", "volume", "play", "sleep"]

    def __init__(self, *, eye_color: str, eye_background: str, volume: int) -> None:
        super().__init__()
        self.eye_color = eye_color
        self.eye_background = eye_background
        self.volume = volume
        self.errors: list[str] = []
        self.expression: str | None = None
        self.moving = False
        self._cmd = 0
        self._abort = threading.Event()
        self._sdk_lock = threading.RLock()
        self._last_proximity = 0.0
        self._mods: dict[str, Any] = {}
        self._camera: Any = None
        self._tts_path = os.path.join(tempfile.gettempdir(), "tardis-robot-say.wav")
        self._sounds_dir = os.environ.get("TARDIS_SOUNDS_DIR", "/.doly/sounds")
        self._settings_loaded = False
        self._sdk_versions: list[str] = []

    # ------------------------------------------------------------------ setup
    def start(self) -> None:
        helper = self._import("doly_helper")
        if helper is None:
            raise SystemExit("doly_helper is not importable: run on the robot, or set TARDIS_ROBOT_HARDWARE=mock")
        if helper.stop_doly_service() < 0:
            self._fail("could not stop the stock Doly service")
        if helper.read_settings() < 0:
            self._fail("read_settings failed (arm calibration and IMU offsets unavailable)")
        else:
            self._settings_loaded = True
        self._init_eyes()
        self._init_leds()
        self._init_sound()
        self._init_tts()
        self._init_touch()
        self._init_tof()
        self._init_edge()
        self._init_imu()
        self._init_battery()
        self._init_arms()
        self._init_drive()
        # Advertise only what actually came up, so companions never see a
        # capability the body cannot deliver.
        available = {
            "say": self._mods.get("doly_tts") is not None and self._mods.get("doly_sound") is not None,
            "play": self._mods.get("doly_sound") is not None,
            "volume": self._mods.get("doly_sound") is not None,
            "express": self._mods.get("doly_eye") is not None,
            "eyes": self._mods.get("doly_eye") is not None,
            "sleep": self._mods.get("doly_eye") is not None,
            "leds": self._mods.get("doly_led") is not None,
            "drive": self._mods.get("doly_drive") is not None,
            "turn": self._mods.get("doly_drive") is not None,
            "arms": self._mods.get("doly_arm") is not None,
            "touch": self._mods.get("doly_touch") is not None,
            "tof": self._mods.get("doly_tof") is not None,
            "edge": self._mods.get("doly_edge") is not None,
            "imu": self._mods.get("doly_imu") is not None,
            "battery": self._mods.get("doly_battery") is not None,
        }
        self.capabilities = [name for name in type(self).capabilities if available.get(name, True)]
        log.info("doly body up: %s", ", ".join(self._sdk_versions) or "no version info")

    def stop(self) -> None:
        self.stop_motion()
        for mod in ("doly_drive", "doly_arm", "doly_tof", "doly_touch", "doly_edge", "doly_imu", "doly_battery", "doly_led", "doly_eye", "doly_tts", "doly_sound"):
            m = self._mods.get(mod)
            if m is None:
                continue
            try:
                if mod == "doly_drive":
                    m.dispose(True)
                else:
                    m.dispose()
            except Exception as error:  # noqa: BLE001
                log.debug("%s dispose: %s", mod, error)
        if self._camera is not None:
            try:
                self._camera.stop_photo()
            except Exception:  # noqa: BLE001
                pass

    def _import(self, module: str) -> Any:
        if module in self._mods:
            return self._mods[module]
        try:
            mod = __import__(module)
        except ImportError as error:
            self._fail(f"{module} missing: {error}")
            mod = None
        self._mods[module] = mod
        return mod

    def _fail(self, message: str) -> None:
        log.warning(message)
        if message not in self.errors:
            self.errors.append(message)

    def _version(self, label: str, mod: Any) -> None:
        try:
            self._sdk_versions.append(f"{label} {mod.get_version():.3f}")
        except Exception:  # noqa: BLE001
            pass

    def _next_id(self) -> int:
        self._cmd = (self._cmd % 60000) + 1
        return self._cmd

    # ---------------------------------------------------------------- subsystems
    def _init_eyes(self) -> None:
        eye = self._import("doly_eye")
        color = self._import("doly_color")
        if eye is None or color is None:
            return
        try:
            rc = eye.init(_enum(color.ColorCode, self.eye_color), _enum(color.ColorCode, self.eye_background))
            if rc != 0:
                self._fail(f"eye init rc={rc}")
                self._mods["doly_eye"] = None
                return
            self._version("eye", eye)
        except Exception as error:  # noqa: BLE001
            self._fail(f"eyes unavailable: {error}")
            self._mods["doly_eye"] = None

    def _init_leds(self) -> None:
        led = self._import("doly_led")
        if led is None:
            return
        try:
            if led.init() != 0:
                self._fail("led init failed")
                self._mods["doly_led"] = None
                return
            self._version("led", led)
        except Exception as error:  # noqa: BLE001
            self._fail(f"leds unavailable: {error}")
            self._mods["doly_led"] = None

    def _init_sound(self) -> None:
        snd = self._import("doly_sound")
        if snd is None:
            return
        try:
            if snd.init() < 0:
                self._fail("sound init failed")
                self._mods["doly_sound"] = None
                return
            snd.set_volume(self.volume)
            self._version("sound", snd)
        except Exception as error:  # noqa: BLE001
            self._fail(f"sound unavailable: {error}")
            self._mods["doly_sound"] = None

    def _init_tts(self) -> None:
        tts = self._import("doly_tts")
        if tts is None:
            return
        try:
            if tts.init(_enum(tts.VoiceModel, "MODEL_1"), self._tts_path) < 0:
                self._fail("tts init failed")
                self._mods["doly_tts"] = None
                return
            self._version("tts", tts)
        except Exception as error:  # noqa: BLE001
            self._fail(f"tts unavailable: {error}")
            self._mods["doly_tts"] = None

    def _init_touch(self) -> None:
        touch = self._import("doly_touch")
        if touch is None:
            return
        try:
            if touch.init() < 0:
                self._fail("touch init failed")
                self._mods["doly_touch"] = None
                return
            touch.on_touch(lambda side, state: self.emit("touch", {"side": _name(side).lower(), "state": _name(state).lower()}))
            touch.on_touch_activity(lambda side, activity: self.emit("touch_activity", {"side": _name(side).lower(), "activity": _name(activity).lower()}))
            self._version("touch", touch)
        except Exception as error:  # noqa: BLE001
            self._fail(f"touch unavailable: {error}")
            self._mods["doly_touch"] = None

    def _init_tof(self) -> None:
        tof = self._import("doly_tof")
        if tof is None:
            return
        try:
            if tof.init() < 0:
                self._fail("tof init failed")
                self._mods["doly_tof"] = None
                return
            if tof.setup_continuous(50, 40) < 0:
                self._fail("tof continuous mode failed")
            tof.on_proximity_gesture(lambda left, right: self.emit("gesture", {"left": _name(left.type).lower(), "right": _name(right.type).lower()}))
            tof.on_proximity_threshold(self._on_proximity)
            self._version("tof", tof)
        except Exception as error:  # noqa: BLE001
            self._fail(f"tof unavailable: {error}")
            self._mods["doly_tof"] = None

    def _on_proximity(self, left: Any, right: Any) -> None:
        now = time.monotonic()
        if now - self._last_proximity < 2.0:
            return
        self._last_proximity = now
        self.emit("proximity", {"left_mm": int(getattr(left, "range_mm", 0)), "right_mm": int(getattr(right, "range_mm", 0))})
        if self.moving:
            self.emit("obstacle", {"left_mm": int(getattr(left, "range_mm", 0)), "right_mm": int(getattr(right, "range_mm", 0))})
            self.stop_motion()

    def _init_edge(self) -> None:
        edge = self._import("doly_edge")
        if edge is None:
            return
        try:
            if edge.init() < 0:
                self._fail("edge init failed")
                self._mods["doly_edge"] = None
                return
            enable = getattr(edge, "enable_control", None)
            if callable(enable):
                enable()
            edge.on_change(self._on_edge)
            self._version("edge", edge)
        except Exception as error:  # noqa: BLE001
            self._fail(f"edge unavailable: {error}")
            self._mods["doly_edge"] = None

    def _on_edge(self, sensors: Any) -> None:
        states = [(int(getattr(s, "id", i)), _name(getattr(s, "state", "")).lower()) for i, s in enumerate(sensors)]
        triggered = [i for i, state in states if state not in ("", "low", "0", "off", "false", "none")]
        self.emit("edge", {"sensors": states, "triggered": triggered})
        if triggered and self.moving:
            self.stop_motion()

    def _init_imu(self) -> None:
        imu = self._import("doly_imu")
        helper = self._mods.get("doly_helper")
        if imu is None or helper is None:
            return
        try:
            offsets = (0, 0, 0, 0, 0, 0)
            if self._settings_loaded:
                rc, *values = helper.get_imu_offsets()
                if rc >= 0 and len(values) == 6:
                    offsets = tuple(values)
            if imu.init(1, *offsets) < 0:
                self._fail("imu init failed")
                self._mods["doly_imu"] = None
                return
            imu.on_gesture(lambda gesture, direction: self.emit("imu_gesture", {"gesture": _name(gesture).lower(), "direction": _name(direction).lower()}))
            self._version("imu", imu)
        except Exception as error:  # noqa: BLE001
            self._fail(f"imu unavailable: {error}")
            self._mods["doly_imu"] = None

    def _init_battery(self) -> None:
        battery = self._import("doly_battery")
        if battery is None:
            return
        try:
            battery.on_alarm(lambda capacity: self.emit("battery_alarm", {"battery": int(capacity)}))
            if battery.init() != 0:
                self._fail("battery init failed")
                self._mods["doly_battery"] = None
                return
            battery.set_alarm_threshold(20)
            self._version("battery", battery)
        except Exception as error:  # noqa: BLE001
            self._fail(f"battery unavailable: {error}")
            self._mods["doly_battery"] = None

    def _init_arms(self) -> None:
        arm = self._import("doly_arm")
        if arm is None:
            return
        if not self._settings_loaded:
            self._fail("arms disabled: servo calibration not loaded")
            self._mods["doly_arm"] = None
            return
        try:
            if arm.init() < 0:
                self._fail("arm init failed")
                self._mods["doly_arm"] = None
                return
            self._version("arm", arm)
        except Exception as error:  # noqa: BLE001
            self._fail(f"arms unavailable: {error}")
            self._mods["doly_arm"] = None

    def _init_drive(self) -> None:
        drive = self._import("doly_drive")
        if drive is None:
            return
        try:
            drive.on_error(lambda cmd_id, side, err: self.emit("drive_error", {"side": _name(side).lower(), "error": _name(err).lower()}))
            if drive.init() != 0:
                self._fail("drive init failed")
                self._mods["doly_drive"] = None
                return
            self._version("drive", drive)
        except Exception as error:  # noqa: BLE001
            self._fail(f"drive unavailable: {error}")
            self._mods["doly_drive"] = None

    # -------------------------------------------------------------------- state
    def status(self) -> HardwareStatus:
        battery = None
        b = self._mods.get("doly_battery")
        if b is not None:
            try:
                battery = int(b.get_capacity())
            except Exception:  # noqa: BLE001
                battery = None
        return HardwareStatus(battery=battery, expression=self.expression, moving=self.moving, hardware=self.name, sdk=self._sdk_versions[0] if self._sdk_versions else None, errors=list(self.errors))

    def sensors(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        touch = self._mods.get("doly_touch")
        if touch is not None:
            try:
                out["touch"] = {s: bool(touch.is_touched(_enum(touch.TouchSide, s))) for s in ("left", "right")}
            except Exception as error:  # noqa: BLE001
                out["touch"] = {"error": str(error)}
        tof = self._mods.get("doly_tof")
        if tof is not None:
            try:
                out["tof"] = {_name(s.side).lower(): {"range_mm": int(s.range_mm), "error": int(getattr(s, "error", 0))} for s in tof.get_sensors_data()}
            except Exception as error:  # noqa: BLE001
                out["tof"] = {"error": str(error)}
        edge = self._mods.get("doly_edge")
        if edge is not None:
            try:
                out["edge"] = {"sensors": [(int(getattr(s, "id", i)), _name(getattr(s, "state", "")).lower()) for i, s in enumerate(edge.get_sensors())]}
            except Exception as error:  # noqa: BLE001
                out["edge"] = {"error": str(error)}
        imu = self._mods.get("doly_imu")
        if imu is not None:
            try:
                data = imu.get_imu_data()
                out["imu"] = {"yaw": round(float(data.ypr.yaw), 1), "pitch": round(float(data.ypr.pitch), 1), "roll": round(float(data.ypr.roll), 1)}
            except Exception as error:  # noqa: BLE001
                out["imu"] = {"error": str(error)}
        arm = self._mods.get("doly_arm")
        if arm is not None:
            try:
                out["arms"] = {_name(a.side).lower(): round(float(a.angle), 1) for a in arm.get_current_angle(_enum(arm.ArmSide, "BOTH"))}
            except Exception as error:  # noqa: BLE001
                out["arms"] = {"error": str(error)}
        drive = self._mods.get("doly_drive")
        if drive is not None:
            try:
                pos = drive.get_position()
                out["position"] = {"x": float(pos.x), "y": float(pos.y), "head": float(pos.head)}
            except Exception as error:  # noqa: BLE001
                out["position"] = {"error": str(error)}
        status = self.status()
        if status.battery is not None:
            out["battery"] = status.battery
        return out

    # --------------------------------------------------------------- expression
    def express(self, expression: str, wait: bool = False) -> None:
        eye = self._mods.get("doly_eye")
        if eye is None:
            raise RuntimeError("eyes unavailable")
        expressions = getattr(eye, "expressions", None)
        name = expression
        if expressions is not None:
            name = getattr(expressions, expression.upper().replace(" ", "_"), expression)
        with self._sdk_lock:
            rc = eye.set_animation(self._next_id(), name)
        if isinstance(rc, int) and rc < 0:
            raise RuntimeError(f"eye animation {expression} rejected (rc={rc})")
        self.expression = expression
        if wait:
            end = time.monotonic() + 8
            while eye.is_animating() and time.monotonic() < end:
                time.sleep(0.02)

    def set_eyes(self, *, color, background, shape, side) -> None:
        eye = self._mods.get("doly_eye")
        color_mod = self._mods.get("doly_color")
        if eye is None or color_mod is None:
            raise RuntimeError("eyes unavailable")
        with self._sdk_lock:
            if color or shape:
                iris_shape = _enum(eye.IrisShape, shape or "MODERN")
                iris_color = _enum(color_mod.ColorCode, color or self.eye_color)
                rc = eye.set_iris(iris_shape, iris_color, _enum(eye.EyeSide, side))
                if isinstance(rc, int) and rc < 0:
                    raise RuntimeError(f"set_iris rc={rc}")
                if color:
                    self.eye_color = color
            if background:
                setter = getattr(eye, "set_background", None)
                if callable(setter):
                    setter(color_mod.Color.from_code(_enum(color_mod.ColorCode, background)))
                    self.eye_background = background

    def set_leds(self, *, color, fade_to, fade_ms, side) -> None:
        led = self._mods.get("doly_led")
        color_mod = self._mods.get("doly_color")
        if led is None or color_mod is None:
            raise RuntimeError("leds unavailable")
        activity = led.LedActivity()
        activity.mainColor = color_mod.Color.from_code(_enum(color_mod.ColorCode, color))
        if fade_to:
            activity.fadeColor = color_mod.Color.from_code(_enum(color_mod.ColorCode, fade_to))
        activity.fade_time = int(fade_ms)
        with self._sdk_lock:
            led.process_activity(self._next_id(), _enum(led.LedSide, side), activity)

    def sleep(self) -> None:
        self.express("SLEEP")

    def wake(self) -> None:
        self.express("AWAKE L")

    # -------------------------------------------------------------------- sound
    def say(self, text: str) -> float:
        tts = self._mods.get("doly_tts")
        snd = self._mods.get("doly_sound")
        if tts is None or snd is None:
            raise RuntimeError("on-board speech unavailable")
        with self._sdk_lock:
            rc = tts.produce(text)
        if isinstance(rc, int) and rc < 0:
            raise RuntimeError(f"tts produce rc={rc}")
        seconds = 0.0
        try:
            with wave.open(self._tts_path, "rb") as wav:
                seconds = wav.getnframes() / float(wav.getframerate() or 1)
        except Exception:  # noqa: BLE001
            seconds = min(20.0, 0.25 + len(text.split()) * 0.32)
        self._play_file(self._tts_path, seconds + 1.0)
        return seconds

    def play(self, sound: str) -> None:
        path = os.path.join(self._sounds_dir, f"{sound}.wav")
        if not os.path.isfile(path):
            raise RuntimeError(f"no sound called {sound}")
        self._play_file(path, 30.0)

    def _play_file(self, path: str, budget: float) -> None:
        snd = self._mods.get("doly_sound")
        if snd is None:
            raise RuntimeError("sound unavailable")
        with self._sdk_lock:
            rc = snd.play(path, 1)
        if isinstance(rc, int) and rc < 0:
            raise RuntimeError(f"sound play rc={rc}")
        stop_state = _enum(snd.SoundState, "STOP")
        end = time.monotonic() + budget
        time.sleep(0.1)
        while snd.get_state() != stop_state and time.monotonic() < end:
            time.sleep(0.05)

    def set_volume(self, level: int) -> None:
        snd = self._mods.get("doly_sound")
        if snd is None:
            raise RuntimeError("sound unavailable")
        snd.set_volume(int(level))
        self.volume = int(level)

    # ------------------------------------------------------------------- motion
    def drive(self, distance_mm: float, speed: int) -> dict[str, Any]:
        drive = self._mods.get("doly_drive")
        if drive is None:
            raise RuntimeError("drive unavailable")
        distance_mm = max(-1000.0, min(1000.0, float(distance_mm)))
        speed = max(1, min(100, int(speed)))
        if self._edge_triggered():
            return {"moved": False, "reason": "edge detected; refusing to drive"}
        # Arm the abort flag and mark motion BEFORE the wheels start: a Stop or
        # an obstacle callback that lands during the SDK call must count.
        self._abort.clear()
        self.moving = True
        outcome = "halt failed"
        try:
            with self._sdk_lock:
                rc = drive.go_distance(self._next_id(), distance_mm, speed, True, True)
            if isinstance(rc, int) and rc < 0:
                raise RuntimeError(f"go_distance rc={rc}")
            outcome = self._wait_drive(drive, abs(distance_mm) / 20.0 + 3.0)
        except Exception:
            # The command failed part way: make sure nothing is left rolling.
            outcome = "stopped" if self._halt_drive(drive) else "halt failed"
            raise
        finally:
            # A halt that could not be confirmed keeps the body reported as moving.
            self.moving = "halt failed" in outcome
        pos = drive.get_position()
        return {"moved": outcome == "done", **({} if outcome == "done" else {"reason": outcome}), "position": {"x": float(pos.x), "y": float(pos.y), "head": float(pos.head)}}

    def turn(self, degrees: float, speed: int) -> dict[str, Any]:
        drive = self._mods.get("doly_drive")
        if drive is None:
            raise RuntimeError("drive unavailable")
        degrees = max(-360.0, min(360.0, float(degrees)))
        speed = max(1, min(100, int(speed)))
        self._abort.clear()
        self.moving = True
        outcome = "halt failed"
        try:
            with self._sdk_lock:
                rc = drive.go_rotate(self._next_id(), degrees * TURN_SIGN, False, speed, True, True)
            if isinstance(rc, int) and rc < 0:
                raise RuntimeError(f"go_rotate rc={rc}")
            outcome = self._wait_drive(drive, abs(degrees) / 30.0 + 3.0)
        except Exception:
            outcome = "stopped" if self._halt_drive(drive) else "halt failed"
            raise
        finally:
            self.moving = "halt failed" in outcome
        pos = drive.get_position()
        return {"moved": outcome == "done", **({} if outcome == "done" else {"reason": outcome}), "position": {"x": float(pos.x), "y": float(pos.y), "head": float(pos.head)}}

    def _wait_drive(self, drive: Any, budget: float) -> str:
        """Block until the drive finishes. Returns 'done', 'stopped' (abort
        honoured) or 'timeout' (deadline hit while still running; wheels are
        halted before returning so the body never keeps rolling)."""
        running = _enum(drive.DriveState, "RUNNING")
        end = time.monotonic() + budget
        time.sleep(0.1)
        while time.monotonic() < end:
            if self._abort.is_set():
                return "stopped" if self._halt_drive(drive) else "halt failed; wheels may still be running"
            if drive.get_state() != running:
                return "stopped" if self._abort.is_set() else "done"
            time.sleep(0.05)
        return "timeout" if self._halt_drive(drive) else "timeout and halt failed; wheels may still be running"

    def _halt_drive(self, drive: Any) -> bool:
        """Stop the wheels. Tries the SDK abort AND zero free-drive on both
        sides, independently, then confirms the drive reports not-running.
        Returns False only when the wheels could not be confirmed stopped."""
        commanded = False
        try:
            abort = getattr(drive, "abort", None) or getattr(drive, "Abort", None)
            if callable(abort):
                abort()
                commanded = True
        except Exception as error:  # noqa: BLE001
            log.warning("drive abort: %s", error)
        try:
            drive.free_drive(0, False, True)
            drive.free_drive(0, True, True)
            commanded = True
        except Exception as error:  # noqa: BLE001
            log.warning("drive free_drive(0): %s", error)
        if not commanded:
            log.error("drive halt failed: no stop command reached the SDK")
            return False
        try:
            running = _enum(drive.DriveState, "RUNNING")
            end = time.monotonic() + 1.5
            while time.monotonic() < end:
                if drive.get_state() != running:
                    return True
                time.sleep(0.05)
            log.error("drive still reports RUNNING after halt")
            return False
        except Exception as error:  # noqa: BLE001
            log.warning("drive halt confirm: %s", error)
            return True

    def _halt_arms(self, arm: Any) -> bool:
        """Stop the arms. Prefers the SDK abort; otherwise re-targets each arm
        to where it is right now, which the servo controller treats as a stop.
        Returns False when neither worked."""
        both = _enum(arm.ArmSide, "BOTH")
        try:
            abort = getattr(arm, "abort", None) or getattr(arm, "Abort", None)
            if callable(abort):
                abort(both)
                return True
        except Exception as error:  # noqa: BLE001
            log.warning("arm abort: %s", error)
        try:
            with self._sdk_lock:
                for current in arm.get_current_angle(both):
                    arm.set_angle(self._next_id(), current.side, speed=100, angle=int(round(float(current.angle))), with_brake=True)
            return True
        except Exception as error:  # noqa: BLE001
            log.error("arm halt failed: %s", error)
            return False

    def arms(self, angle: float, speed: int, side: str) -> dict[str, Any]:
        arm = self._mods.get("doly_arm")
        if arm is None:
            raise RuntimeError("arms unavailable")
        angle = max(0.0, min(180.0, float(angle)))
        speed = max(1, min(100, int(speed)))
        arm_side = _enum(arm.ArmSide, side)
        self._abort.clear()
        self.moving = True
        moved = False
        try:
            with self._sdk_lock:
                rc = arm.set_angle(self._next_id(), arm_side, speed=speed, angle=int(angle), with_brake=False)
            if isinstance(rc, int) and rc < 0:
                raise RuntimeError(f"set_angle rc={rc}")
            completed = _enum(arm.ArmState, "COMPLETED")
            end = time.monotonic() + 8.0
            while time.monotonic() < end:
                if self._abort.is_set():
                    self._halt_arms(arm)
                    break
                if arm.get_state(arm_side) == completed:
                    moved = True
                    break
                time.sleep(0.05)
            else:
                self._halt_arms(arm)
        finally:
            self.moving = False
        angles = {_name(a.side).lower(): round(float(a.angle), 1) for a in arm.get_current_angle(_enum(arm.ArmSide, "BOTH"))}
        return {"moved": moved, **({} if moved else {"reason": "stopped" if self._abort.is_set() else "timeout"}), "arms": angles}

    def stop_motion(self) -> None:
        """Halt everything. Raises when a subsystem could not be commanded so a
        caller never reports a stop that did not happen."""
        self._abort.set()
        failed: list[str] = []
        drive = self._mods.get("doly_drive")
        if drive is not None and not self._halt_drive(drive):
            failed.append("wheels")
        arm = self._mods.get("doly_arm")
        if arm is not None and not self._halt_arms(arm):
            failed.append("arms")
        if failed:
            raise RuntimeError(f"could not confirm a stop for: {', '.join(failed)}")

    def _edge_triggered(self) -> bool:
        edge = self._mods.get("doly_edge")
        if edge is None:
            return False
        try:
            return any(_name(getattr(s, "state", "")).lower() not in ("", "low", "0", "off", "false", "none") for s in edge.get_sensors())
        except Exception:  # noqa: BLE001
            return False

    # ------------------------------------------------------------------- vision
    def snapshot(self, width: int) -> Snapshot | None:
        try:
            import cv2  # type: ignore
        except ImportError as error:
            raise RuntimeError(f"opencv missing: {error}") from error
        cam = self._camera
        if cam is None:
            camera_mod = self._import("doly_camera")
            if camera_mod is None:
                raise RuntimeError("camera SDK unavailable")
            cam = camera_mod.PiCamera()
            cam.options.photo_width = 1640
            cam.options.photo_height = 1232
            cam.options.verbose = False
            self._camera = cam
        with self._sdk_lock:
            if not cam.start_photo():
                raise RuntimeError("camera start failed")
            try:
                frame = cam.capture_photo()
            finally:
                cam.stop_photo()
        if frame is None:
            raise RuntimeError("camera returned no frame")
        h, w = frame.shape[:2]
        if w > width:
            scale = width / float(w)
            frame = cv2.resize(frame, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
            h, w = frame.shape[:2]
        ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
        if not ok:
            raise RuntimeError("jpeg encode failed")
        return Snapshot(buf.tobytes(), w, h)

    # -------------------------------------------------------------- voice hooks
    def voice_state(self, state: str) -> None:
        colours = {"connecting": ("WHITE", "SKY_BLUE", 600), "listening": ("SKY_BLUE", None, 0), "thinking": ("PURPLE", "MAGENTA", 900), "speaking": ("GOLD", None, 0), "idle": ("SKY_BLUE", "BLACK", 1500), "off": ("BLACK", None, 0)}
        choice = colours.get(state)
        if not choice:
            return
        try:
            self.set_leds(color=choice[0], fade_to=choice[1], fade_ms=choice[2], side="both")
        except Exception as error:  # noqa: BLE001
            log.debug("voice leds: %s", error)


def encode_jpeg(snapshot: Snapshot) -> str:
    return base64.b64encode(snapshot.jpeg).decode("ascii")
