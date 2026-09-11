"""On-device wake word with openWakeWord ("hey jarvis" ships with it). Runs
only while no call is active so the microphones are free for LiveKit during a
conversation. Optional: without the package the robot still answers a long
touch."""

from __future__ import annotations

import asyncio
import logging
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
        self._buffer = np.zeros(0, dtype=np.int16)
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
        self._buffer = np.zeros(0, dtype=np.int16)
        self.audio.start_input(self._on_audio, WAKE_RATE)

    def stop(self) -> None:
        if not self._listening:
            return
        self._listening = False
        self.audio.stop_input()

    def _on_audio(self, frame: np.ndarray) -> None:
        if self._model is None:
            return
        self._buffer = np.concatenate([self._buffer, frame])
        while len(self._buffer) >= CHUNK:
            chunk, self._buffer = self._buffer[:CHUNK], self._buffer[CHUNK:]
            try:
                scores = self._model.predict(chunk)
            except Exception as error:  # noqa: BLE001
                log.debug("wake predict: %s", error)
                return
            score = max((float(v) for k, v in scores.items() if self.model_name in k), default=0.0)
            if score >= self.threshold and time.monotonic() - self._last_fire > COOLDOWN_SECS:
                self._last_fire = time.monotonic()
                log.info("wake word heard (%.2f)", score)
                loop = self._loop
                if loop is not None:
                    loop.call_soon_threadsafe(lambda: loop.create_task(self.on_wake()))
