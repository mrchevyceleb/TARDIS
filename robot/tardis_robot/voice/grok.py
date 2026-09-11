"""Spark's voice: a Grok realtime call over the ship's ``/ws/voice`` socket.

The robot is one more client of the same Grok voice stack the browser uses.
It streams the microphone up as 16 kHz mono PCM, plays the agent's 24 kHz reply
down, and reports call state so the body can drive its eyes. The call is bound
to a TARDIS agent (``agentId``), so Spark speaks with that agent's Grok voice
and persona.

No hardware AEC on this body, so while the agent is speaking the microphone is
gated: the robot must not hear itself and interrupt its own reply.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import threading
import time
import urllib.request
from typing import Any, Awaitable, Callable

log = logging.getLogger("tardis.voice")

MIC_RATE = 16000       # what /ws/voice expects upstream
SPEAKER_RATE = 24000   # what Grok streams downstream
MIC_BLOCK = 320        # 20 ms at 16 kHz
SPEAK_TAIL = 0.45      # keep gating the mic this long after the agent stops
FRAME_CAP = 8 * 1024 * 1024

StateCb = Callable[[str], Awaitable[None]]


def grok_voice_available() -> bool:
    try:
        import sounddevice  # noqa: F401
        import websockets  # noqa: F401
        return True
    except Exception:  # noqa: BLE001
        return False


class GrokVoiceSession:
    """One reconnecting-free voice call at a time. ``start`` opens the socket and
    the audio streams; ``stop`` tears everything down. ``active`` and ``state``
    mirror the browser client so the rest of the app is unchanged."""

    def __init__(
        self,
        *,
        voice_ws_url: str,
        http_url: str,
        agent_id: str,
        on_state: StateCb,
        idle_secs: float = 45.0,
        gate: bool = True,
        input_device: str | None = None,
        output_device: str | None = None,
    ) -> None:
        self.voice_ws_url = voice_ws_url
        self.http_url = http_url.rstrip("/")
        self.agent_id = agent_id
        self.on_state = on_state
        self.idle_secs = idle_secs
        self.gate = gate
        self.input_device = input_device
        self.output_device = output_device

        self.active = False
        self.state = "off"
        self._ws: Any = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._tasks: list[asyncio.Task[Any]] = []
        self._mic_queue: asyncio.Queue[bytes] | None = None
        self._in_stream: Any = None
        self._out_stream: Any = None
        self._play_buf = bytearray()
        self._play_lock = threading.Lock()
        self._speaking_until = 0.0
        self._last_user = 0.0
        self._stopping = False

    # ------------------------------------------------------------- capability
    async def server_enabled(self) -> bool:
        """True when the ship exposes the agent this body voices."""
        def probe() -> bool:
            try:
                with urllib.request.urlopen(f"{self.http_url}/api/agents", timeout=8) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
            except Exception as error:  # noqa: BLE001
                log.info("voice: could not reach /api/agents (%s)", error)
                return False
            agents = data if isinstance(data, list) else data.get("agents", [])
            ids = {str(a.get("id", "")).lower() for a in agents}
            if self.agent_id in ids:
                return True
            log.error("voice: no agent %r on the ship (have: %s)", self.agent_id, ", ".join(sorted(ids)) or "none")
            return False
        return await asyncio.to_thread(probe)

    # -------------------------------------------------------------------- call
    async def start(self) -> None:
        if self.active:
            return
        import sounddevice as sd
        import websockets

        self._loop = asyncio.get_running_loop()
        self._stopping = False
        self._mic_queue = asyncio.Queue(maxsize=200)
        self._play_buf = bytearray()
        self._speaking_until = 0.0
        self._last_user = time.monotonic()
        try:
            self._ws = await websockets.connect(self.voice_ws_url, open_timeout=12, max_size=FRAME_CAP)
            await asyncio.wait_for(self._ws.recv(), 8)  # {type:state,state:connecting}
            await self._ws.send(json.dumps({"type": "start", "agentId": self.agent_id}))

            def mic_cb(indata, _frames, _t, status):  # sounddevice thread
                if status:
                    log.debug("mic status: %s", status)
                if self._loop and self._mic_queue is not None:
                    self._loop.call_soon_threadsafe(self._push_mic, bytes(indata))

            def spk_cb(outdata, frames, _t, _status):  # sounddevice thread
                want = frames * 2
                with self._play_lock:
                    have = min(want, len(self._play_buf))
                    outdata[:have] = self._play_buf[:have]
                    del self._play_buf[:have]
                if have < want:
                    outdata[have:] = b"\x00" * (want - have)

            self._in_stream = sd.RawInputStream(samplerate=MIC_RATE, blocksize=MIC_BLOCK, dtype="int16", channels=1, device=self.input_device, callback=mic_cb)
            self._out_stream = sd.RawOutputStream(samplerate=SPEAKER_RATE, blocksize=0, dtype="int16", channels=1, device=self.output_device, callback=spk_cb)
            self._in_stream.start()
            self._out_stream.start()

            self.active = True
            self._tasks = [
                self._loop.create_task(self._recv_loop()),
                self._loop.create_task(self._mic_loop()),
                self._loop.create_task(self._idle_loop()),
            ]
            await self._set_state("connecting")
        except Exception:
            await self.stop("setup failed")
            raise

    def _push_mic(self, data: bytes) -> None:
        if self._mic_queue is None:
            return
        try:
            self._mic_queue.put_nowait(data)
        except asyncio.QueueFull:
            try:
                self._mic_queue.get_nowait()
                self._mic_queue.put_nowait(data)
            except Exception:  # noqa: BLE001
                pass

    async def _mic_loop(self) -> None:
        assert self._mic_queue is not None
        try:
            while self.active and self._ws is not None:
                data = await self._mic_queue.get()
                if self.gate and time.monotonic() < self._speaking_until:
                    continue  # the agent is talking; don't feed it its own voice
                try:
                    await self._ws.send(json.dumps({"type": "audio", "b64": base64.b64encode(data).decode("ascii")}))
                except Exception:  # noqa: BLE001
                    break
        except asyncio.CancelledError:
            raise

    async def _recv_loop(self) -> None:
        try:
            while self.active and self._ws is not None:
                raw = await self._ws.recv()
                msg = json.loads(raw)
                kind = msg.get("type")
                if kind == "audio":
                    pcm = base64.b64decode(msg.get("b64", ""))
                    with self._play_lock:
                        self._play_buf.extend(pcm)
                    self._speaking_until = time.monotonic() + (len(pcm) / 2 / SPEAKER_RATE) + SPEAK_TAIL
                elif kind == "state":
                    await self._set_state(str(msg.get("state", "")))
                elif kind == "interrupt":
                    # The agent was cut off: drop its queued audio and lift the
                    # mic gate so the person talking is heard right away.
                    with self._play_lock:
                        self._play_buf.clear()
                    self._speaking_until = 0.0
                elif kind == "transcript":
                    if msg.get("role") == "user" and str(msg.get("text", "")).strip():
                        self._last_user = time.monotonic()
                elif kind == "ended":
                    log.info("voice: call ended (%s)", msg.get("reason"))
                    break
                elif kind == "error":
                    log.error("voice: %s", msg.get("message"))
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001 - a closed socket ends the call
            log.info("voice: receive loop ended (%s)", error)
        finally:
            if not self._stopping:
                self._loop and self._loop.create_task(self.stop("closed"))

    async def _idle_loop(self) -> None:
        try:
            while self.active:
                await asyncio.sleep(1.0)
                if time.monotonic() - self._last_user > self.idle_secs and time.monotonic() > self._speaking_until:
                    log.info("voice: idle for %.0fs, hanging up", self.idle_secs)
                    self._loop and self._loop.create_task(self.stop("idle"))
                    return
        except asyncio.CancelledError:
            raise

    async def _set_state(self, state: str) -> None:
        if not state or state == self.state:
            return
        self.state = state
        if state == "speaking":
            self._speaking_until = max(self._speaking_until, time.monotonic() + SPEAK_TAIL)
        try:
            await self.on_state(state)
        except Exception as error:  # noqa: BLE001 - eyes are cosmetic
            log.debug("voice on_state failed: %s", error)

    async def stop(self, reason: str = "stop") -> None:
        if self._stopping:
            return
        self._stopping = True
        self.active = False
        ws = self._ws
        self._ws = None
        if ws is not None:
            try:
                await ws.send(json.dumps({"type": "stop"}))
            except Exception:  # noqa: BLE001
                pass
            try:
                await ws.close()
            except Exception:  # noqa: BLE001
                pass
        for task in self._tasks:
            task.cancel()
        self._tasks = []
        for stream in (self._in_stream, self._out_stream):
            try:
                if stream is not None:
                    stream.stop(); stream.close()
            except Exception:  # noqa: BLE001
                pass
        self._in_stream = self._out_stream = None
        with self._play_lock:
            self._play_buf = bytearray()
        self.state = "off"
        try:
            await self.on_state("off")
        except Exception:  # noqa: BLE001
            pass
        log.info("voice: stopped (%s)", reason)
