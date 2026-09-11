"""On-device wake word with Vosk. A small offline recognizer listens only for
the wake phrases (a grammar-restricted decode, so it hears "hey spark" reliably
instead of drowning it in the full dictionary) and summons the voice. Runs only
while no call is active, so the microphone is free for the call itself.

Vosk needs no training and no numpy>=1.26, so it coexists with the preinstalled
OpenCV the camera uses. The audio callback only enqueues frames; decoding runs
on its own thread so real-time capture is never blocked."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import queue
import threading
import time
from typing import Any, Awaitable, Callable

log = logging.getLogger("tardis.wake")

WAKE_RATE = 16_000
COOLDOWN_SECS = 3.0
DEFAULT_MODEL = "/opt/tardis-robot/models/vosk-model-small-en-us-0.15"


def vosk_available() -> bool:
    try:
        import vosk  # noqa: F401
        import sounddevice  # noqa: F401
        return True
    except Exception:  # noqa: BLE001
        return False


def wake_phrases(spec: str) -> list[str]:
    """From a phrase like "hey spark", the phrases to trigger on: the phrase
    itself and, when it is "hey <name>", the bare name too."""
    spec = " ".join(spec.strip().lower().split())
    if not spec or spec == "off":
        return []
    phrases = [spec]
    parts = spec.split()
    if len(parts) > 1 and parts[0] in ("hey", "ok", "okay", "hi", "yo"):
        tail = " ".join(parts[1:])
        if tail and tail not in phrases:
            phrases.append(tail)
    return phrases


class WakeListener:
    def __init__(self, *, model_dir: str, phrases: list[str], on_wake: Callable[[], Awaitable[None]], device: str | None = None, cooldown: float = COOLDOWN_SECS) -> None:
        self.model_dir = model_dir or DEFAULT_MODEL
        self.phrases = [p for p in phrases if p]
        self.on_wake = on_wake
        self.device = device
        self.cooldown = cooldown
        self._model: Any = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._queue: queue.Queue[bytes] = queue.Queue(maxsize=100)
        self._worker: threading.Thread | None = None
        self._stream: Any = None
        self._stop = threading.Event()
        self._last_fire = 0.0
        self._listening = False

    def load(self) -> bool:
        if not self.phrases:
            log.info("wake word off (no phrase)")
            return False
        if not os.path.isdir(self.model_dir):
            log.warning("wake model not found at %s; wake word off", self.model_dir)
            return False
        try:
            from vosk import Model, SetLogLevel
            SetLogLevel(-1)
            self._model = Model(self.model_dir)
        except Exception as error:  # noqa: BLE001
            log.warning("vosk model unavailable: %s; wake word off", error)
            return False
        log.info("wake word ready: %s", " / ".join(self.phrases))
        return True

    def _recognizer(self) -> Any:
        from vosk import KaldiRecognizer
        grammar = json.dumps(self.phrases + ["[unk]"])
        return KaldiRecognizer(self._model, WAKE_RATE, grammar)

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        if self._model is None or self._listening:
            return
        import sounddevice as sd
        self._loop = loop
        self._listening = True
        self._stop.clear()
        with self._queue.mutex:
            self._queue.queue.clear()

        def cb(indata, _frames, _t, _status):
            try:
                self._queue.put_nowait(bytes(indata))
            except queue.Full:
                pass

        self._worker = threading.Thread(target=self._run, name="wake-word", daemon=True)
        self._worker.start()
        try:
            self._stream = sd.RawInputStream(samplerate=WAKE_RATE, blocksize=4000, dtype="int16", channels=1, device=self.device, callback=cb)
            self._stream.start()
        except Exception:
            self._listening = False
            self._stop.set()
            self._worker = None
            raise

    def stop(self) -> None:
        if not self._listening:
            return
        self._listening = False
        self._stop.set()
        stream, self._stream = self._stream, None
        if stream is not None:
            try:
                stream.stop(); stream.close()
            except Exception:  # noqa: BLE001
                pass
        worker, self._worker = self._worker, None
        if worker is not None:
            worker.join(timeout=2.0)

    def _matches(self, text: str) -> bool:
        text = text.strip()
        if not text:
            return False
        return any(p in text for p in self.phrases)

    def _fire(self) -> None:
        now = time.monotonic()
        if now - self._last_fire < self.cooldown:
            return
        self._last_fire = now
        log.info("wake word heard")
        loop = self._loop
        if loop is not None and not loop.is_closed():
            loop.call_soon_threadsafe(lambda: loop.create_task(self.on_wake()))

    def _run(self) -> None:
        try:
            rec = self._recognizer()
        except Exception as error:  # noqa: BLE001
            log.warning("wake recognizer failed: %s", error)
            return
        while not self._stop.is_set():
            try:
                data = self._queue.get(timeout=0.25)
            except queue.Empty:
                continue
            try:
                if rec.AcceptWaveform(data):
                    if self._matches(json.loads(rec.Result()).get("text", "")):
                        self._fire()
                else:
                    if self._matches(json.loads(rec.PartialResult()).get("partial", "")):
                        self._fire()
            except Exception as error:  # noqa: BLE001
                log.debug("wake decode: %s", error)
