"""A simulated body. Logs every action, keeps a plausible status, and can be
poked from the outside (``inject_event``) so the whole link can be exercised
without a robot. Motions take a little real time so cancellation and timeouts
behave like the real thing."""

from __future__ import annotations

import io
import logging
import math
import threading
import time
from typing import Any

from .base import Hardware, HardwareStatus, Snapshot

log = logging.getLogger("tardis.hardware.mock")


class MockHardware(Hardware):
    name = "mock"
    capabilities = ["say", "express", "eyes", "leds", "drive", "turn", "arms", "look", "sensors", "touch", "tof", "edge", "imu", "battery", "volume", "play"]

    def __init__(self, *, eye_color: str, eye_background: str, volume: int) -> None:
        super().__init__()
        self.eye_color = eye_color
        self.eye_background = eye_background
        self.volume = volume
        self.expression: str | None = None
        self.moving = False
        self.position = {"x": 0.0, "y": 0.0, "head": 0.0}
        self.arm_angle = {"left": 0.0, "right": 0.0}
        self.battery = 92
        self.charging = False
        self.leds = {"left": "BLACK", "right": "BLACK"}
        self.asleep = False
        self._abort = threading.Event()
        self._started = time.monotonic()

    def start(self) -> None:
        log.info("mock body up (eyes %s on %s, volume %s)", self.eye_color, self.eye_background, self.volume)

    def stop(self) -> None:
        log.info("mock body down")

    def status(self) -> HardwareStatus:
        drain = int((time.monotonic() - self._started) / 600)
        return HardwareStatus(battery=max(5, self.battery - drain), charging=self.charging, expression=self.expression, moving=self.moving, hardware=self.name, sdk="mock")

    def sensors(self) -> dict[str, Any]:
        return {
            "touch": {"left": False, "right": False},
            "tof": {"left": {"range_mm": 420, "error": 0}, "right": {"range_mm": 385, "error": 0}},
            "edge": {"sensors": [0, 0, 0, 0]},
            "imu": {"yaw": self.position["head"], "pitch": 0.0, "roll": 0.0},
            "battery": self.status().battery,
            "arms": dict(self.arm_angle),
            "position": dict(self.position),
        }

    def express(self, expression: str, wait: bool = False) -> None:
        self.expression = expression
        log.info("eyes: %s", expression)
        if wait:
            time.sleep(0.6)

    def set_eyes(self, *, color, background, shape, side) -> None:
        if color:
            self.eye_color = color
        if background:
            self.eye_background = background
        log.info("eyes set: color=%s background=%s shape=%s side=%s", color, background, shape, side)

    def set_leds(self, *, color, fade_to, fade_ms, side) -> None:
        for s in (("left", "right") if side == "both" else (side,)):
            self.leds[s] = fade_to or color
        log.info("leds: %s -> %s over %sms (%s)", color, fade_to, fade_ms, side)

    def sleep(self) -> None:
        self.asleep = True
        self.expression = "SLEEP"
        log.info("sleeping")

    def wake(self) -> None:
        self.asleep = False
        self.expression = "AWAKE L"
        log.info("awake")

    def say(self, text: str) -> float:
        seconds = min(20.0, 0.25 + len(text.split()) * 0.32)
        log.info("say (%.1fs): %s", seconds, text)
        self._wait(seconds)
        return seconds

    def play(self, sound: str) -> None:
        log.info("play sound %s", sound)
        self._wait(0.5)

    def set_volume(self, level: int) -> None:
        self.volume = level
        log.info("volume %s", level)

    def drive(self, distance_mm: float, speed: int) -> dict[str, Any]:
        seconds = abs(distance_mm) / max(20.0, speed * 3.0)
        log.info("drive %smm at %s%% (%.1fs)", distance_mm, speed, seconds)
        done = self._motion(seconds)
        moved = distance_mm if done else distance_mm * 0.5
        rad = math.radians(self.position["head"])
        self.position["x"] += moved * math.cos(rad)
        self.position["y"] += moved * math.sin(rad)
        return {"moved": done, "distanceMm": moved, "position": dict(self.position)}

    def turn(self, degrees: float, speed: int) -> dict[str, Any]:
        seconds = abs(degrees) / max(30.0, speed * 2.0)
        log.info("turn %s° at %s%% (%.1fs)", degrees, speed, seconds)
        done = self._motion(seconds)
        turned = degrees if done else degrees * 0.5
        self.position["head"] = (self.position["head"] + turned) % 360
        return {"moved": done, "degrees": turned, "position": dict(self.position)}

    def arms(self, angle: float, speed: int, side: str) -> dict[str, Any]:
        log.info("arms %s -> %s° at %s%%", side, angle, speed)
        done = self._motion(0.4)
        for s in (("left", "right") if side == "both" else (side,)):
            # A stopped arm ends part way, like the real servo would.
            self.arm_angle[s] = angle if done else (self.arm_angle[s] + angle) / 2
        return {"moved": done, **({} if done else {"reason": "stopped"}), "arms": dict(self.arm_angle)}

    def stop_motion(self) -> None:
        self._abort.set()
        log.info("stop motion")

    def snapshot(self, width: int) -> Snapshot | None:
        # A tiny valid JPEG (a flat grey frame) so the image path is exercised
        # end to end without a camera.
        try:
            import numpy as np
            import cv2  # type: ignore

            height = max(2, int(width * 3 / 4))
            frame = np.full((height, width, 3), 96, dtype=np.uint8)
            cv2.putText(frame, "mock camera", (10, height // 2), cv2.FONT_HERSHEY_SIMPLEX, max(0.4, width / 800), (230, 230, 230), 1)
            ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 70])
            if ok:
                return Snapshot(buf.tobytes(), width, height)
        except Exception:  # noqa: BLE001 - fall through to the baked frame
            pass
        return Snapshot(_TINY_JPEG, 1, 1)

    def voice_state(self, state: str) -> None:
        log.info("voice: %s", state)

    # --- test helpers ----------------------------------------------------------
    def inject_event(self, name: str, data: dict[str, Any] | None = None) -> None:
        self.emit(name, data)

    def _wait(self, seconds: float) -> None:
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            time.sleep(0.05)

    def _motion(self, seconds: float) -> bool:
        # A Stop that lands while the command is being issued must not be
        # erased: the flag is armed before motion begins and honoured
        # throughout, never cleared once we are moving.
        self._abort.clear()
        self.moving = True
        try:
            end = time.monotonic() + seconds
            while time.monotonic() < end:
                if self._abort.is_set():
                    return False
                time.sleep(0.05)
            return True
        finally:
            self.moving = False


# 1x1 grey JPEG.
_TINY_JPEG = bytes.fromhex(
    "ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f14"
    "1d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100"
    "ffc40014000100000000000000000000000000000009ffc40014100100000000000000000000000000000000ffda0008010100"
    "003f00548a7fffd9"
)
