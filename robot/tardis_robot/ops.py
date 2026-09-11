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

# The robot is the last line of defence for its own body: these bounds hold
# no matter what the server (or a stale/compromised one) asks for.
MAX_DISTANCE_MM = 1000.0
MAX_TURN_DEG = 360.0
MAX_ARM_ANGLE = 180.0
MAX_SAY_CHARS = 600
MIN_LOOK_WIDTH, MAX_LOOK_WIDTH = 160, 1920
# Keep a reply comfortably under the link's 4 MiB frame after base64 growth.
MAX_IMAGE_B64_CHARS = 2_500_000


def _num(value: Any, name: str, lo: float, hi: float, default: float | None = None) -> float:
    if value is None or value == "":
        if default is None:
            raise RuntimeError(f"{name} is required")
        return default
    try:
        n = float(value)
    except (TypeError, ValueError) as error:
        raise RuntimeError(f"{name} must be a number") from error
    if n != n:  # NaN
        raise RuntimeError(f"{name} must be a number")
    return min(hi, max(lo, n))


def _side(value: Any) -> str:
    side = str(value or "both").strip().lower()
    return side if side in ("both", "left", "right") else "both"


class Ops:
    def __init__(self, hardware: Hardware, *, name: str, speak_guard: SpeakGuard, voice_state: Callable[[], str]) -> None:
        self.hw = hardware
        self.name = name
        self.speak_guard = speak_guard
        self.voice_state = voice_state
        self._motion = asyncio.Lock()
        self._stuck: asyncio.Task[Any] | None = None
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
        text = str(params.get("text", "")).strip()[:MAX_SAY_CHARS]
        if not text:
            raise RuntimeError("Nothing to say.")
        busy = self.speak_guard()
        if busy:
            raise RuntimeError(busy)
        expression = params.get("expression")
        if isinstance(expression, str) and expression.strip():
            try:
                await asyncio.to_thread(self.hw.express, expression.strip()[:40], False)
            except Exception as error:  # noqa: BLE001 - speech still matters
                log.warning("expression before speech failed: %s", error)
        seconds = await asyncio.to_thread(self.hw.say, text)
        return {"spoken": text, "seconds": round(seconds, 1)}

    async def express(self, params: dict[str, Any], cancel: asyncio.Event) -> dict[str, Any]:
        expression = str(params.get("expression", "")).strip()[:40]
        if not expression:
            raise RuntimeError("expression is required")
        await asyncio.to_thread(self.hw.express, expression, bool(params.get("wait")))
        return {"expression": expression}

    async def eyes(self, params: dict[str, Any], cancel: asyncio.Event) -> dict[str, Any]:
        pick = lambda key: (str(params[key]).strip()[:20] or None) if params.get(key) is not None else None  # noqa: E731
        await asyncio.to_thread(self.hw.set_eyes, color=pick("color"), background=pick("background"), shape=pick("shape"), side=_side(params.get("side")))
        return {"eyes": {k: params.get(k) for k in ("color", "background", "shape", "side") if params.get(k)}}

    async def leds(self, params: dict[str, Any], cancel: asyncio.Event) -> dict[str, Any]:
        fade_to = str(params["fadeTo"]).strip()[:20] if params.get("fadeTo") else None
        await asyncio.to_thread(self.hw.set_leds, color=str(params.get("color", "WHITE")).strip()[:20], fade_to=fade_to, fade_ms=int(_num(params.get("fadeMs"), "fadeMs", 0, 10_000, 0)), side=_side(params.get("side")))
        return {"leds": {k: params.get(k) for k in ("color", "fadeTo", "fadeMs", "side") if params.get(k) is not None}}

    async def sleep(self, params: dict[str, Any], cancel: asyncio.Event) -> dict[str, Any]:
        await asyncio.to_thread(self.hw.sleep)
        return {"asleep": True}

    async def wake(self, params: dict[str, Any], cancel: asyncio.Event) -> dict[str, Any]:
        await asyncio.to_thread(self.hw.wake)
        return {"asleep": False}

    # ------------------------------------------------------------------ motion
    async def _motion_call(self, cancel: asyncio.Event, fn: Callable[[], dict[str, Any]]) -> dict[str, Any]:
        """Run one motion on a worker thread. Any way out other than the motion
        finishing on its own (server cancel, link timeout, task cancellation)
        stops the hardware and waits for the worker before the lock is released,
        so nothing keeps rolling unattended."""
        stuck = self._stuck
        if stuck is not None and not stuck.done():
            raise RuntimeError("A previous motion is still running on the hardware and did not stop. Refusing new motion until it ends; call robot_stop.")
        self._stuck = None
        if self._motion.locked():
            raise RuntimeError("The robot is already moving. Call robot_stop first or wait.")
        async with self._motion:
            task = asyncio.create_task(asyncio.to_thread(fn))
            watcher = asyncio.create_task(cancel.wait())
            try:
                done, _ = await asyncio.wait({task, watcher}, return_when=asyncio.FIRST_COMPLETED)
                if task in done:
                    return task.result()
                raise asyncio.CancelledError()
            except asyncio.CancelledError:
                await self._quiesce(task)
                raise
            except BaseException:
                await self._quiesce(task)
                raise
            finally:
                watcher.cancel()

    async def _quiesce(self, task: asyncio.Task[Any]) -> None:
        """Stop the hardware and wait for the worker. A worker that will not
        return keeps the body faulted: no new motion is accepted until it does."""
        try:
            await asyncio.to_thread(self.hw.stop_motion)
        except Exception as error:  # noqa: BLE001
            log.warning("stop_motion during cancel failed: %s", error)
        # We are often here BECAUSE this coroutine is being cancelled (link
        # dropped, server cancel, timeout). A cancellation landing mid-wait must
        # not be mistaken for the worker refusing to stop: keep waiting out the
        # grace period, then re-raise the cancellation once.
        deadline = time.monotonic() + 8.0
        cancelled = False
        while not task.done() and time.monotonic() < deadline:
            try:
                await asyncio.wait_for(asyncio.shield(task), timeout=max(0.05, deadline - time.monotonic()))
            except asyncio.CancelledError:
                cancelled = True
            except Exception:  # noqa: BLE001 - the worker's own error surfaces to the caller elsewhere
                break
        if not task.done():
            log.error("motion worker did not stop within the grace period; refusing further motion until it exits")
            self._stuck = task
        if cancelled:
            raise asyncio.CancelledError()

    async def drive(self, params: dict[str, Any], cancel: asyncio.Event) -> dict[str, Any]:
        distance = _num(params.get("distanceMm"), "distanceMm", -MAX_DISTANCE_MM, MAX_DISTANCE_MM)
        speed = int(_num(params.get("speed"), "speed", 1, 100, 40))
        if distance == 0:
            return {"moved": False, "reason": "zero distance"}
        return await self._motion_call(cancel, lambda: self.hw.drive(distance, speed))

    async def turn(self, params: dict[str, Any], cancel: asyncio.Event) -> dict[str, Any]:
        degrees = _num(params.get("degrees"), "degrees", -MAX_TURN_DEG, MAX_TURN_DEG)
        speed = int(_num(params.get("speed"), "speed", 1, 100, 40))
        if degrees == 0:
            return {"moved": False, "reason": "zero rotation"}
        return await self._motion_call(cancel, lambda: self.hw.turn(degrees, speed))

    async def arms(self, params: dict[str, Any], cancel: asyncio.Event) -> dict[str, Any]:
        angle = _num(params.get("angle"), "angle", 0, MAX_ARM_ANGLE)
        speed = int(_num(params.get("speed"), "speed", 1, 100, 30))
        side = _side(params.get("side"))
        return await self._motion_call(cancel, lambda: self.hw.arms(angle, speed, side))

    async def stop(self, params: dict[str, Any], cancel: asyncio.Event) -> dict[str, Any]:
        # stop_motion raises when a subsystem could not be halted, so a false
        # "stopped" never reaches the agent.
        await asyncio.to_thread(self.hw.stop_motion)
        stuck = self._stuck
        if stuck is not None and not stuck.done():
            return {"stopped": True, "warning": "hardware halted, but the previous motion worker has not returned yet"}
        return {"stopped": True}

    # ------------------------------------------------------------------ vision
    async def look(self, params: dict[str, Any], cancel: asyncio.Event) -> dict[str, Any]:
        width = int(_num(params.get("width"), "width", MIN_LOOK_WIDTH, MAX_LOOK_WIDTH, 960))
        # Shrink until the encoded frame fits the link; a busy scene at full
        # width can otherwise exceed the frame cap and the reply would be lost.
        attempt = width
        while True:
            snapshot = await asyncio.to_thread(self.hw.snapshot, attempt)
            if snapshot is None:
                raise RuntimeError("This body has no camera.")
            image = base64.b64encode(snapshot.jpeg).decode("ascii")
            if len(image) <= MAX_IMAGE_B64_CHARS or attempt <= MIN_LOOK_WIDTH:
                break
            attempt = max(MIN_LOOK_WIDTH, int(attempt * 0.7))
        if len(image) > MAX_IMAGE_B64_CHARS:
            raise RuntimeError("The camera frame is too large to send even at the smallest size.")
        return {"image": image, "mimeType": "image/jpeg", "width": snapshot.width, "height": snapshot.height, "capturedAt": int(time.time() * 1000)}

    # ------------------------------------------------------------------- sound
    async def volume(self, params: dict[str, Any], cancel: asyncio.Event) -> dict[str, Any]:
        level = int(_num(params.get("level"), "level", 0, 100))
        await asyncio.to_thread(self.hw.set_volume, level)
        return {"volume": level}

    async def play(self, params: dict[str, Any], cancel: asyncio.Event) -> dict[str, Any]:
        sound = str(params.get("sound", "")).strip()
        if not sound or len(sound) > 40 or not all(c.isalnum() or c in "-_" for c in sound):
            raise RuntimeError("sound must be a short name (letters, digits, - and _)")
        busy = self.speak_guard()
        if busy:
            raise RuntimeError(busy)
        await asyncio.to_thread(self.hw.play, sound)
        return {"played": sound}
