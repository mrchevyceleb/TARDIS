"""On-device wake word with openWakeWord ("hey jarvis" ships with it). Runs
only while no call is active so the microphones are free for LiveKit during a
conversation. Optional: without the package the robot still answers a long
touch.

The audio callback only hands frames to a queue; buffering and inference run
on their own thread so the real-time capture thread is never blocked."""

from __future__ import annotations

import asyncio
import logging
import queue
import threading
import time
from typing import Any, Awaitable, Callable

import numpy as np

from .audio import AudioIO

log = logging.getLogger("tardis.wake")

WAKE_RATE = 16_000
CHUNK = 1280  # 80 ms, openWakeWord's native step
COOLDOWN_SECS = 3.0


def openwakeword_available() -> bool:
    try:
        import openwakeword  # noqa: F401
    except Exception:  # noqa: BLE001
        return False
    return True


class WakeListener:
    def __init__(self, *, audio: AudioIO, model: str, threshold: float, on_wake: Callable[[], Awaitable[None]]) -> None:
        self.audio = audio
        self.model_name = model
        self.threshold = threshold
        self.on_wake = on_wake
        self._model: Any = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._frames: queue.Queue[np.ndarray] = queue.Queue(maxsize=200)
        self._worker: threading.Thread | None = None
        self._stop = threading.Event()
        self._last_fire = 0.0
        self._listening = False

    def load(self) -> bool:
        try:
            from openwakeword.model import Model
        except Exception as error:  # noqa: BLE001
            log.info("openwakeword not installed (%s); wake word off", error)
            return False
        try:
            self._model = Model(wakeword_models=[self.model_name], inference_framework="onnx")
        except Exception as error:  # noqa: BLE001
            try:
                from openwakeword.utils import download_models

                download_models([self.model_name])
                from openwakeword.model import Model as Model2

                self._model = Model2(wakeword_models=[self.model_name], inference_framework="onnx")
            except Exception as error2:  # noqa: BLE001
                log.warning("wake model %s unavailable: %s / %s", self.model_name, error, error2)
                return False
        log.info("wake word ready: %s (threshold %.2f)", self.model_name, self.threshold)
        return True

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        if self._model is None or self._listening:
            return
        self._loop = loop
        self._listening = True
        self._stop.clear()
        with self._frames.mutex:
            self._frames.queue.clear()
        self._worker = threading.Thread(target=self._run, name="wake-word", daemon=True)
        self._worker.start()
        try:
            self.audio.start_input(self._on_audio, WAKE_RATE)
        except Exception:
            # Microphone unavailable: roll back so a retry (or stop) is clean.
            self._listening = False
            self._stop.set()
            self._worker = None
            raise

    def stop(self) -> None:
        if not self._listening:
            return
        self._listening = False
        self.audio.stop_input()
        self._stop.set()
        worker, self._worker = self._worker, None
        if worker is not None:
            worker.join(timeout=2.0)

    # Real-time capture thread: enqueue and return immediately.
    def _on_audio(self, frame: np.ndarray) -> None:
        try:
            self._frames.put_nowait(frame)
        except queue.Full:
            pass

    # Worker thread: buffer to 80 ms chunks and run the model.
    def _run(self) -> None:
        model = self._model
        if model is None:
            return
        try:
            model.reset()
        except Exception:  # noqa: BLE001
            pass
        buffer = np.zeros(0, dtype=np.int16)
        while not self._stop.is_set():
            try:
                frame = self._frames.get(timeout=0.25)
            except queue.Empty:
                continue
            buffer = np.concatenate([buffer, frame])
            while len(buffer) >= CHUNK and not self._stop.is_set():
                chunk, buffer = buffer[:CHUNK], buffer[CHUNK:]
                try:
                    scores = model.predict(chunk)
                except Exception as error:  # noqa: BLE001
                    log.debug("wake predict: %s", error)
                    continue
                score = max((float(v) for k, v in scores.items() if self.model_name in k), default=0.0)
                if score >= self.threshold and time.monotonic() - self._last_fire > COOLDOWN_SECS:
                    self._last_fire = time.monotonic()
                    log.info("wake word heard (%.2f)", score)
                    loop = self._loop
                    if loop is not None and not loop.is_closed():
                        loop.call_soon_threadsafe(lambda: loop.create_task(self.on_wake()))
