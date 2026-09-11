"""What a robot body must offer. Methods are synchronous and may block for the
duration of a motion; the app calls them from worker threads. Events flow the
other way through ``set_event_sink`` and may be raised from any thread."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

EventSink = Callable[[str, dict[str, Any]], None]

SIDES = ("both", "left", "right")


@dataclass
class Snapshot:
    jpeg: bytes
    width: int
    height: int


@dataclass
class HardwareStatus:
    battery: int | None = None
    charging: bool | None = None
    expression: str | None = None
    moving: bool = False
    hardware: str = "unknown"
    sdk: str | None = None
    errors: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"hardware": self.hardware, "moving": self.moving}
        if self.battery is not None:
            out["battery"] = self.battery
        if self.charging is not None:
            out["charging"] = self.charging
        if self.expression:
            out["expression"] = self.expression
        if self.sdk:
            out["sdk"] = self.sdk
        if self.errors:
            out["errors"] = list(self.errors)
        return out


class Hardware:
    """Base class. Every method has a safe default so a partial backend still
    links; override what the body can actually do and list it in
    ``capabilities``."""

    name = "base"
    capabilities: list[str] = []

    def __init__(self) -> None:
        self._sink: EventSink | None = None

    # --- lifecycle -----------------------------------------------------------
    def start(self) -> None: ...
    def stop(self) -> None: ...

    def set_event_sink(self, sink: EventSink) -> None:
        self._sink = sink

    def emit(self, name: str, data: dict[str, Any] | None = None) -> None:
        if self._sink:
            self._sink(name, data or {})

    # --- state ---------------------------------------------------------------
    def status(self) -> HardwareStatus:
        return HardwareStatus(hardware=self.name)

    def sensors(self) -> dict[str, Any]:
        return {}

    # --- expression ----------------------------------------------------------
    def express(self, expression: str, wait: bool = False) -> None: ...
    def set_eyes(self, *, color: str | None, background: str | None, shape: str | None, side: str) -> None: ...
    def set_leds(self, *, color: str, fade_to: str | None, fade_ms: int, side: str) -> None: ...
    def sleep(self) -> None: ...
    def wake(self) -> None: ...

    # --- sound ---------------------------------------------------------------
    def say(self, text: str) -> float:
        """Speak with the on-board voice. Returns seconds spoken."""
        return 0.0

    def play(self, sound: str) -> None: ...
    def set_volume(self, level: int) -> None: ...

    # --- motion --------------------------------------------------------------
    def drive(self, distance_mm: float, speed: int) -> dict[str, Any]:
        return {"moved": False, "reason": "no drive on this body"}

    def turn(self, degrees: float, speed: int) -> dict[str, Any]:
        return {"moved": False, "reason": "no drive on this body"}

    def arms(self, angle: float, speed: int, side: str) -> dict[str, Any]:
        return {"moved": False, "reason": "no arms on this body"}

    def stop_motion(self) -> None: ...

    # --- vision --------------------------------------------------------------
    def snapshot(self, width: int) -> Snapshot | None:
        return None

    # --- voice hooks ---------------------------------------------------------
    def voice_state(self, state: str) -> None:
        """Called as the Jarvis call moves through connecting/listening/thinking/speaking/off."""
