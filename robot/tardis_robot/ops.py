"""robot.* request handlers. Each returns a JSON-able dict or raises with a
message the companion can read. Motion is serialised and honours the server's
cancel; everything blocking runs in a worker thread so the link stays
responsive."""

from __future__ import annotations

import asyncio
import base64
import logging
import time
from typing import Any, Awaitable, Callable

from .hardware.base import Hardware

log = logging.getLogger("tardis.ops")

SpeakGuard = Callable[[], str | None]


class Ops:
    def __init__(self, hardware: Hardware, *, name: str, speak_guard: SpeakGuard, voice_state: Callable[[], str]) -> None:
        self.hw = hardware
        self.name = name
        self.speak_guard = speak_guard
        self.voice_state = voice_state
        self._motion = asyncio.Lock()
        self._started = time.monotonic()
        self._handlers: dict[str, Callable[[dict[str, Any], asyncio.Event], Awaitable[dict[str, Any]]]] = {
            "status": self.status,
            "sensors": self.sensors,
            "say": self.say,
            "express": self.express,
            "eyes": self.eyes,
            "leds": self.leds,
            "drive": self.drive,
            "turn": self.turn,
            "arms": self.arms,
            "stop": self.stop,
            "look": self.look,
            "volume": self.volume,
            "play": self.play,
            "sleep": self.sleep,
            "wake": self.wake,
        }

    async def handle(self, op: str, params: dict[str, Any], cancel: asyncio.Event) -> dict[str, Any]:
        if not op.startswith("robot."):
            raise RuntimeError("This is a robot body. It answers robot.* requests only.")
        handler = self._handlers.get(op[len("robot."):])
        if handler is None:
            raise RuntimeError(f"Unknown robot command {op}.")
        return await handler(params, cancel)

    # ----------------------------------------------------------------- queries
    async def status(self, params: dict[str, Any], cancel: asyncio.Event) -> dict[str, Any]:
        status = await asyncio.to_thread(self.hw.status)
        return {**status.as_dict(), "name": self.name, "voice": self.voice_state(), "uptimeSecs": int(time.monotonic() - self._started)}

    async def sensors(self, params: dict[str, Any], cancel: asyncio.Event) -> dict[str, Any]:
        return {"sensors": await asyncio.to_thread(self.hw.sensors)}

    # -------------------------------------------------------------- expression
    async def say(self, params: dict[str, Any], cancel: asyncio.Event) -> dict[str, Any]:
        text = str(params.get("text", "")).strip()
        if not text:
            raise RuntimeError("Nothing to say.")
        busy = self.speak_guard()
        if busy:
            raise RuntimeError(busy)
        expression = params.get("expression")
        if isinstance(expression, str) and expression:
            try:
                await asyncio.to_thread(self.hw.express, expression, False)
            except Exception as error:  # noqa: BLE001 - speech still matters
                log.warning("expression before speech failed: %s", error)
        seconds = await asyncio.to_thread(self.hw.say, text)
        return {"spoken": text, "seconds": round(seconds, 1)}

    async def express(self, params: dict[str, Any], cancel: asyncio.Event) -> dict[str, Any]:
        expression = str(params.get("expression", "")).strip()
        await asyncio.to_thread(self.hw.express, expression, bool(params.get("wait")))
        return {"expression": expression}

    async def eyes(self, params: dict[str, Any], cancel: asyncio.Event) -> dict[str, Any]:
        await asyncio.to_thread(self.hw.set_eyes, color=params.get("color"), background=params.get("background"), shape=params.get("shape"), side=str(params.get("side", "both")))
        return {"eyes": {k: params.get(k) for k in ("color", "background", "shape", "side") if params.get(k)}}

    async def leds(self, params: dict[str, Any], cancel: asyncio.Event) -> dict[str, Any]:
        await asyncio.to_thread(self.hw.set_leds, color=str(params.get("color", "WHITE")), fade_to=params.get("fadeTo"), fade_ms=int(params.get("fadeMs", 0) or 0), side=str(params.get("side", "both")))
        return {"leds": {k: params.get(k) for k in ("color", "fadeTo", "fadeMs", "side") if params.get(k) is not None}}

    async def sleep(self, params: dict[str, Any], cancel: asyncio.Event) -> dict[str, Any]:
        await asyncio.to_thread(self.hw.sleep)
        return {"asleep": True}

    async def wake(self, params: dict[str, Any], cancel: asyncio.Event) -> dict[str, Any]:
        await asyncio.to_thread(self.hw.wake)
        return {"asleep": False}

    # ------------------------------------------------------------------ motion
    async def _motion_call(self, cancel: asyncio.Event, fn: Callable[[], dict[str, Any]]) -> dict[str, Any]:
        if self._motion.locked():
            raise RuntimeError("The robot is already moving. Call robot_stop first or wait.")
        async with self._motion:
            task = asyncio.create_task(asyncio.to_thread(fn))
            watcher = asyncio.create_task(cancel.wait())
            done, _ = await asyncio.wait({task, watcher}, return_when=asyncio.FIRST_COMPLETED)
            if watcher in done and task not in done:
                await asyncio.to_thread(self.hw.stop_motion)
                try:
                    await asyncio.wait_for(task, timeout=5)
                except Exception:  # noqa: BLE001
                    pass
                raise asyncio.CancelledError()
            watcher.cancel()
            return await task

    async def drive(self, params: dict[str, Any], cancel: asyncio.Event) -> dict[str, Any]:
        distance = float(params.get("distanceMm", 0))
        speed = int(params.get("speed", 40))
        return await self._motion_call(cancel, lambda: self.hw.drive(distance, speed))

    async def turn(self, params: dict[str, Any], cancel: asyncio.Event) -> dict[str, Any]:
        degrees = float(params.get("degrees", 0))
        speed = int(params.get("speed", 40))
        return await self._motion_call(cancel, lambda: self.hw.turn(degrees, speed))

    async def arms(self, params: dict[str, Any], cancel: asyncio.Event) -> dict[str, Any]:
        angle = float(params.get("angle", 0))
        speed = int(params.get("speed", 30))
        side = str(params.get("side", "both"))
        return await self._motion_call(cancel, lambda: self.hw.arms(angle, speed, side))

    async def stop(self, params: dict[str, Any], cancel: asyncio.Event) -> dict[str, Any]:
        await asyncio.to_thread(self.hw.stop_motion)
        return {"stopped": True}

    # ------------------------------------------------------------------ vision
    async def look(self, params: dict[str, Any], cancel: asyncio.Event) -> dict[str, Any]:
        width = int(params.get("width", 960) or 960)
        snapshot = await asyncio.to_thread(self.hw.snapshot, width)
        if snapshot is None:
            raise RuntimeError("This body has no camera.")
        return {"image": base64.b64encode(snapshot.jpeg).decode("ascii"), "mimeType": "image/jpeg", "width": snapshot.width, "height": snapshot.height, "capturedAt": int(time.time() * 1000)}

    # ------------------------------------------------------------------- sound
    async def volume(self, params: dict[str, Any], cancel: asyncio.Event) -> dict[str, Any]:
        level = int(params.get("level", 70))
        await asyncio.to_thread(self.hw.set_volume, level)
        return {"volume": level}

    async def play(self, params: dict[str, Any], cancel: asyncio.Event) -> dict[str, Any]:
        sound = str(params.get("sound", ""))
        busy = self.speak_guard()
        if busy:
            raise RuntimeError(busy)
        await asyncio.to_thread(self.hw.play, sound)
        return {"played": sound}
