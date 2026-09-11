"""Hardware backends. ``select_hardware`` picks the Doly SDK when it is
importable (auto), otherwise a simulated body so the companion can be
developed and tested on any machine."""

from __future__ import annotations

import importlib.util
import logging

from .base import Hardware

log = logging.getLogger("tardis.hardware")


def doly_sdk_available() -> bool:
    return importlib.util.find_spec("doly_helper") is not None


def select_hardware(kind: str, *, eye_color: str, eye_background: str, volume: int) -> Hardware:
    choice = kind
    if choice == "auto":
        choice = "doly" if doly_sdk_available() else "mock"
    if choice == "doly":
        from .doly import DolyHardware

        return DolyHardware(eye_color=eye_color, eye_background=eye_background, volume=volume)
    if choice == "mock":
        from .mock import MockHardware

        return MockHardware(eye_color=eye_color, eye_background=eye_background, volume=volume)
    raise SystemExit(f"Unknown TARDIS_ROBOT_HARDWARE={kind!r} (auto, doly or mock)")
