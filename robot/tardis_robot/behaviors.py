"""Reflexes. Small, local reactions that make the body feel alive between
tool calls, plus the forwarding of sensor events to the ship. Companions get
the events and decide anything bigger; nothing here talks to a model."""

from __future__ import annotations

import asyncio
import logging
import random
import time
from typing import Any, Awaitable, Callable

from .hardware.base import Hardware

log = logging.getLogger("tardis.behaviors")

EventOut = Callable[[str, dict[str, Any]], Awaitable[None]]
StateOut = Callable[[], Awaitable[None]]
Summon = Callable[[], Awaitable[None]]

# Minimum gap between forwarded events of the same name, seconds.
THROTTLE = {"proximity": 2.0, "touch": 0.5, "imu": 5.0, "edge": 1.0, "gesture": 1.0, "log": 5.0}

VOICE_EYES = {
    "connecting": "WAKE WORD",
    "listening": "ATTENTION",
    "thinking": "THINK",
    "working": "THINK",
    "speaking": "CHEERFUL",
    "ended": "LOOK AHEAD",
    "idle": "LOOK AHEAD",
    "off": "LOOK AHEAD",
}

SUMMON_ACTIVITIES = {"long", "long_press", "hold", "longpress", "press_long"}
DISMISS_ACTIVITIES = {"double", "double_tap", "doubletap"}


class Behaviors:
    def __init__(self, hardware: Hardware, *, send_event: EventOut, send_state: StateOut, summon: Summon, dismiss: Summon, voice_active: Callable[[], bool], touch_summon: bool, status_interval: float) -> None:
        self.hw = hardware
        self.send_event = send_event
        self.send_state = send_state
        self.summon = summon
        self.dismiss = dismiss
        self.voice_active = voice_active
        self.touch_summon = touch_summon
        self.status_interval = status_interval
        self._last: dict[str, float] = {}
        self._loop: asyncio.AbstractEventLoop | None = None
        self._tasks: list[asyncio.Task[Any]] = []

    def attach(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop
        self.hw.set_event_sink(self._from_hardware_thread)
        self._tasks.append(loop.create_task(self._blink_loop()))
        self._tasks.append(loop.create_task(self._status_loop()))

    async def close(self) -> None:
        for task in self._tasks:
            task.cancel()

    # Hardware callbacks arrive on SDK threads; hop onto the loop first.
    def _from_hardware_thread(self, name: str, data: dict[str, Any]) -> None:
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        loop.call_soon_threadsafe(lambda: loop.create_task(self.on_event(name, data)))

    async def on_event(self, name: str, data: dict[str, Any]) -> None:
        now = time.monotonic()
        gap = THROTTLE.get(name, 0.0)
        if gap and now - self._last.get(name, 0.0) < gap:
            return
        self._last[name] = now
        try:
            await self._react(name, data)
        except Exception as error:  # noqa: BLE001 - a failed reflex must not lose the event
            log.debug("reflex %s failed: %s", name, error)
        await self.send_event(name, data)

    async def _react(self, name: str, data: dict[str, Any]) -> None:
        in_call = self.voice_active()
        if name == "touch" and str(data.get("state", "")).lower() in {"down", "pressed", "touched", "1", "true"} and not in_call:
            await asyncio.to_thread(self.hw.express, random.choice(["HAPPY", "DELIGHTED", "SPARKLING"]), False)
        elif name == "touch_activity":
            activity = str(data.get("activity", "")).lower()
            if activity in SUMMON_ACTIVITIES and self.touch_summon:
                if in_call:
                    await self.dismiss()
                else:
                    await self.summon()
            elif activity in DISMISS_ACTIVITIES and in_call:
                await self.dismiss()
        elif name == "edge":
            if data.get("triggered"):
                await asyncio.to_thread(self.hw.stop_motion)
                await asyncio.to_thread(self.hw.express, "CAUTIOUS DOWN", False)
        elif name == "obstacle":
            await asyncio.to_thread(self.hw.express, "CAUTIOUS", False)
        elif name == "imu_gesture":
            # Doly SDK gestures: Move, LongShake, ShortShake, Vibrate*, Shock*
            # with a direction (Up/Down/Left/Right/Front/Back). A Move going
            # Up is the robot being picked up.
            gesture = str(data.get("gesture", "")).lower()
            direction = str(data.get("direction", "")).lower()
            if (gesture == "move" and direction == "up") or any(key in gesture for key in ("pick", "lift", "fall", "drop")):
                await asyncio.to_thread(self.hw.stop_motion)
                await asyncio.to_thread(self.hw.express, "SHOCKED", False)
            elif "shake" in gesture:
                await asyncio.to_thread(self.hw.express, "DIZZY L", False)
            elif gesture.startswith("shock"):
                await asyncio.to_thread(self.hw.express, "BUMP", False)
        elif name == "battery_alarm":
            await asyncio.to_thread(self.hw.express, "BATTERY LOW", False)
        elif name == "gesture" and not in_call:
            left = str(data.get("left", "")).lower()
            right = str(data.get("right", "")).lower()
            if "left" in left or "left" in right:
                await asyncio.to_thread(self.hw.express, "ATTENTION LEFT", False)
            elif "right" in left or "right" in right:
                await asyncio.to_thread(self.hw.express, "ATTENTION RIGHT", False)

    async def on_voice_state(self, state: str) -> None:
        expression = VOICE_EYES.get(state)
        try:
            await asyncio.to_thread(self.hw.voice_state, state)
            if expression:
                await asyncio.to_thread(self.hw.express, expression, False)
        except Exception as error:  # noqa: BLE001
            log.debug("voice reflex failed: %s", error)
        await self.send_event("voice_state", {"state": state})
        await self.send_state()

    async def _blink_loop(self) -> None:
        while True:
            await asyncio.sleep(random.uniform(4.0, 9.0))
            if self.voice_active():
                continue
            status = await asyncio.to_thread(self.hw.status)
            if status.moving or (status.expression or "").upper() in {"SLEEP", "SLEEPY"}:
                continue
            try:
                await asyncio.to_thread(self.hw.express, "BLINK", False)
            except Exception:  # noqa: BLE001 - blink is best effort
                pass

    async def _status_loop(self) -> None:
        while True:
            await asyncio.sleep(self.status_interval)
            try:
                await self.send_state()
            except Exception:  # noqa: BLE001
                pass
