"""One Jarvis call from the robot. Mirrors the browser client in
src/jarvis/useJarvisSession.ts: fetch a token from the ship, join the LiveKit
room the ship dispatched the jarvis-agent into, stream mic in / agent audio
out, and follow the ``jarvis`` data topic for state, captions and closing.

Half-duplex by default: the mic is muted while the agent speaks (plus a short
tail) because the robot has no hardware echo cancellation. LiveKit's software
canceller can be layered on with TARDIS_VOICE_AEC=1.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import urllib.parse
import urllib.request
from typing import Any, Awaitable, Callable

import numpy as np

from .audio import AudioIO, FRAME_MS, SAMPLE_RATE

log = logging.getLogger("tardis.voice")

JARVIS_TOPIC = "jarvis"
SPEAKING_TAIL_SECS = 0.45
StateCallback = Callable[[str], Awaitable[None]]


def livekit_available() -> bool:
    try:
        from livekit import rtc  # noqa: F401
    except Exception:  # noqa: BLE001
        return False
    return True


def _get_json(url: str, timeout: float = 10.0) -> dict[str, Any]:
    with urllib.request.urlopen(url, timeout=timeout) as response:  # noqa: S310 - operator-configured ship URL
        return json.loads(response.read().decode("utf-8"))


class VoiceSession:
    def __init__(self, *, base_url: str, identity: str, audio: AudioIO, on_state: StateCallback, idle_secs: float, gate: bool, aec: bool) -> None:
        self.base_url = base_url.rstrip("/")
        self.identity = identity
        self.audio = audio
        self.on_state = on_state
        self.idle_secs = idle_secs
        self.gate = gate
        self.aec = aec
        self.state = "off"
        self._room: Any = None
        self._source: Any = None
        self._apm: Any = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._tasks: list[asyncio.Task[Any]] = []
        self._closed = asyncio.Event()
        self._last_activity = time.monotonic()
        self._agent_speaking_until = 0.0
        self._mic_queue: asyncio.Queue[np.ndarray] = asyncio.Queue(maxsize=200)

    @property
    def active(self) -> bool:
        return self.state not in ("off",)

    # ------------------------------------------------------------ availability
    async def server_enabled(self) -> bool:
        try:
            config = await asyncio.to_thread(_get_json, f"{self.base_url}/api/jarvis/config")
        except Exception as error:  # noqa: BLE001
            log.warning("jarvis config unavailable: %s", error)
            return False
        return bool(config.get("enabled"))

    # ------------------------------------------------------------------ control
    async def start(self) -> None:
        if self.active:
            return
        from livekit import rtc

        self._loop = asyncio.get_running_loop()
        self._closed = asyncio.Event()
        # Never carry a previous call's microphone backlog into a new room.
        self._mic_queue = asyncio.Queue(maxsize=200)
        self._agent_speaking_until = 0.0
        await self._set_state("connecting")
        query = urllib.parse.urlencode({"identity": self.identity})
        try:
            grant = await asyncio.to_thread(_get_json, f"{self.base_url}/api/jarvis/token?{query}")
        except Exception as error:  # noqa: BLE001
            await self._set_state("off")
            raise RuntimeError(f"voice token failed: {error}") from error

        room = rtc.Room(loop=self._loop)
        self._room = room
        room.on("data_received", self._on_data)
        room.on("track_subscribed", self._on_track)
        room.on("disconnected", lambda *_: self._loop and self._loop.create_task(self.stop("disconnected")) if not self._closed.is_set() else None)
        try:
            await room.connect(grant["url"], grant["token"], options=rtc.RoomOptions(auto_subscribe=True))
        except Exception as error:  # noqa: BLE001
            self._room = None
            await self._set_state("off")
            raise RuntimeError(f"voice room connect failed: {error}") from error
        log.info("joined voice room %s as %s", grant.get("room"), self.identity)

        # Anything that fails from here on must tear the room down again, or a
        # half-built session would sit in 'connecting' holding the microphone.
        try:
            if self.aec:
                try:
                    self._apm = rtc.AudioProcessingModule(echo_cancellation=True, noise_suppression=True, high_pass_filter=True, auto_gain_control=True)
                except Exception as error:  # noqa: BLE001
                    log.warning("software AEC unavailable: %s", error)
                    self._apm = None

            self._source = rtc.AudioSource(SAMPLE_RATE, 1)
            track = rtc.LocalAudioTrack.create_audio_track("robot-mic", self._source)
            options = rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
            await room.local_participant.publish_track(track, options)

            self._last_activity = time.monotonic()
            self.audio.start_output(SAMPLE_RATE)
            self.audio.start_input(self._mic_from_thread, SAMPLE_RATE)
            self._tasks = [
                self._loop.create_task(self._pump_mic()),
                self._loop.create_task(self._idle_watch()),
            ]
        except Exception as error:  # noqa: BLE001
            await self.stop("setup failed")
            raise RuntimeError(f"voice setup failed: {error}") from error
        await self._set_state("idle")

    async def stop(self, reason: str = "hangup") -> None:
        if self._closed.is_set():
            return
        self._closed.set()
        log.info("voice ending: %s", reason)
        room = self._room
        if room is not None and reason in ("hangup", "idle", "dismiss", "touch"):
            try:
                await room.local_participant.publish_data(json.dumps({"type": "dismiss"}).encode("utf-8"), reliable=True, topic=JARVIS_TOPIC)
            except Exception:  # noqa: BLE001
                pass
        for task in self._tasks:
            task.cancel()
        self._tasks = []
        self.audio.stop_input()
        self.audio.stop_output()
        self._mic_queue = asyncio.Queue(maxsize=200)
        self._room = None
        if room is not None:
            try:
                await room.disconnect()
            except Exception:  # noqa: BLE001
                pass
        self._source = None
        self._apm = None
        await self._set_state("off")

    async def _set_state(self, state: str) -> None:
        if state == self.state:
            return
        self.state = state
        try:
            await self.on_state(state)
        except Exception as error:  # noqa: BLE001
            log.debug("state callback failed: %s", error)

    # ------------------------------------------------------------ audio in/out
    def _mic_from_thread(self, frame: np.ndarray) -> None:
        loop = self._loop
        if loop is None or self._closed.is_set():
            return
        gated = self.gate and time.monotonic() < self._agent_speaking_until
        if gated:
            frame = np.zeros_like(frame)
        try:
            loop.call_soon_threadsafe(self._enqueue_mic, frame)
        except RuntimeError:
            pass

    def _enqueue_mic(self, frame: np.ndarray) -> None:
        try:
            self._mic_queue.put_nowait(frame)
        except asyncio.QueueFull:
            pass

    async def _pump_mic(self) -> None:
        from livekit import rtc

        samples = SAMPLE_RATE * FRAME_MS // 1000
        while not self._closed.is_set():
            frame = await self._mic_queue.get()
            source = self._source
            if source is None:
                continue
            if len(frame) != samples:
                frame = np.resize(frame, samples)
            audio_frame = rtc.AudioFrame(frame.tobytes(), SAMPLE_RATE, 1, samples)
            if self._apm is not None:
                try:
                    self._apm.process_stream(audio_frame)
                except Exception:  # noqa: BLE001
                    pass
            try:
                await source.capture_frame(audio_frame)
            except Exception as error:  # noqa: BLE001
                log.debug("capture_frame: %s", error)

    def _on_track(self, track: Any, publication: Any, participant: Any) -> None:
        from livekit import rtc

        if track.kind != rtc.TrackKind.KIND_AUDIO or self._loop is None:
            return
        self._tasks.append(self._loop.create_task(self._play_track(track)))

    async def _play_track(self, track: Any) -> None:
        from livekit import rtc

        stream = rtc.AudioStream(track, sample_rate=SAMPLE_RATE, num_channels=1)
        try:
            async for event in stream:
                frame = event.frame
                if self._apm is not None:
                    try:
                        self._apm.process_reverse_stream(frame)
                    except Exception:  # noqa: BLE001
                        pass
                pcm = np.frombuffer(frame.data, dtype=np.int16)
                if frame.num_channels > 1:
                    pcm = pcm.reshape(-1, frame.num_channels)[:, 0]
                if self.gate and np.abs(pcm).max(initial=0) > 200:
                    self._agent_speaking_until = time.monotonic() + SPEAKING_TAIL_SECS
                self.audio.write(pcm)
        except asyncio.CancelledError:
            pass
        finally:
            await stream.aclose()

    # ------------------------------------------------------------- data topic
    def _on_data(self, packet: Any, *rest: Any) -> None:
        topic = getattr(packet, "topic", None)
        data = getattr(packet, "data", None)
        if topic != JARVIS_TOPIC or data is None or self._loop is None:
            return
        try:
            msg = json.loads(bytes(data).decode("utf-8"))
        except ValueError:
            return
        self._loop.create_task(self._handle(msg))

    async def _handle(self, msg: dict[str, Any]) -> None:
        kind = msg.get("type")
        if kind == "state":
            agent_state = str(msg.get("agentState", "idle"))
            self._last_activity = time.monotonic()
            if agent_state == "speaking" and self.gate:
                self._agent_speaking_until = time.monotonic() + 1.0
            await self._set_state(agent_state if agent_state in ("idle", "listening", "thinking", "speaking") else "idle")
        elif kind == "caption":
            self._last_activity = time.monotonic()
            if msg.get("final"):
                log.info("%s: %s", msg.get("role"), msg.get("text"))
        elif kind == "tool":
            self._last_activity = time.monotonic()
            log.info("tool: %s", msg.get("name"))
        elif kind == "closing":
            await self.stop(f"agent closed ({msg.get('reason')})")
        elif kind == "status":
            log.info("status: %s", msg.get("message"))

    async def _idle_watch(self) -> None:
        while not self._closed.is_set():
            await asyncio.sleep(2.0)
            if self.state in ("thinking", "speaking"):
                self._last_activity = time.monotonic()
                continue
            if time.monotonic() - self._last_activity > self.idle_secs:
                await self.stop("idle")
                return
