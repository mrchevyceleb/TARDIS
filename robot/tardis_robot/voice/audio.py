"""Local audio I/O. sounddevice (PortAudio) when installed; a silent
stand-in otherwise so the rest of the voice path can be exercised on a
machine without a microphone."""

from __future__ import annotations

import logging
import queue
import threading
from typing import Callable

import numpy as np

log = logging.getLogger("tardis.audio")

SAMPLE_RATE = 48_000
CHANNELS = 1
FRAME_MS = 10
FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS // 1000

InputCallback = Callable[[np.ndarray], None]


def sounddevice_available() -> bool:
    try:
        import sounddevice  # noqa: F401
    except Exception:  # noqa: BLE001 - missing PortAudio raises OSError, not ImportError
        return False
    return True


def _device(value: str | None) -> int | str | None:
    if value is None:
        return None
    return int(value) if value.isdigit() else value


class AudioIO:
    """Base: no sound in, sound out discarded."""

    name = "null"

    def __init__(self, *, input_device: str | None = None, output_device: str | None = None) -> None:
        self.input_device = input_device
        self.output_device = output_device
        self._input_cb: InputCallback | None = None
        self._silence = threading.Event()
        self._silence_thread: threading.Thread | None = None

    def start_input(self, callback: InputCallback, sample_rate: int = SAMPLE_RATE) -> None:
        self._input_cb = callback
        self._silence.clear()
        self._silence_thread = threading.Thread(target=self._silence_loop, args=(sample_rate,), daemon=True)
        self._silence_thread.start()

    def _silence_loop(self, sample_rate: int) -> None:
        frame = np.zeros(sample_rate * FRAME_MS // 1000, dtype=np.int16)
        while not self._silence.wait(FRAME_MS / 1000):
            cb = self._input_cb
            if cb:
                cb(frame)

    def stop_input(self) -> None:
        self._silence.set()
        self._input_cb = None

    def start_output(self, sample_rate: int = SAMPLE_RATE) -> None: ...
    def write(self, frame: np.ndarray) -> None: ...
    def stop_output(self) -> None: ...


class SoundDeviceIO(AudioIO):
    name = "sounddevice"

    def __init__(self, *, input_device: str | None = None, output_device: str | None = None) -> None:
        super().__init__(input_device=input_device, output_device=output_device)
        import sounddevice as sd

        self._sd = sd
        self._in: object | None = None
        self._out: object | None = None
        self._out_queue: queue.Queue[np.ndarray] = queue.Queue(maxsize=400)
        self._carry = np.zeros(0, dtype=np.int16)

    def start_input(self, callback: InputCallback, sample_rate: int = SAMPLE_RATE) -> None:
        self.stop_input()
        self._input_cb = callback
        block = sample_rate * FRAME_MS // 1000

        def on_audio(indata, frames, time_info, status) -> None:  # noqa: ANN001
            if status:
                log.debug("input status: %s", status)
            cb = self._input_cb
            if cb is not None:
                cb(np.ascontiguousarray(indata[:, 0]).astype(np.int16, copy=False))

        self._in = self._sd.InputStream(samplerate=sample_rate, channels=CHANNELS, dtype="int16", blocksize=block, device=_device(self.input_device), callback=on_audio)
        self._in.start()  # type: ignore[attr-defined]

    def stop_input(self) -> None:
        self._input_cb = None
        stream, self._in = self._in, None
        if stream is not None:
            try:
                stream.stop(); stream.close()  # type: ignore[attr-defined]
            except Exception:  # noqa: BLE001
                pass

    def start_output(self, sample_rate: int = SAMPLE_RATE) -> None:
        self.stop_output()
        block = sample_rate * FRAME_MS // 1000

        def on_need(outdata, frames, time_info, status) -> None:  # noqa: ANN001
            chunk = self._carry
            while len(chunk) < frames:
                try:
                    chunk = np.concatenate([chunk, self._out_queue.get_nowait()])
                except queue.Empty:
                    break
            if len(chunk) >= frames:
                outdata[:, 0] = chunk[:frames]
                self._carry = chunk[frames:]
            else:
                outdata[:len(chunk), 0] = chunk
                outdata[len(chunk):, 0] = 0
                self._carry = np.zeros(0, dtype=np.int16)

        self._out = self._sd.OutputStream(samplerate=sample_rate, channels=CHANNELS, dtype="int16", blocksize=block, device=_device(self.output_device), callback=on_need)
        self._out.start()  # type: ignore[attr-defined]

    def write(self, frame: np.ndarray) -> None:
        try:
            self._out_queue.put_nowait(frame.astype(np.int16, copy=False))
        except queue.Full:
            # Better to drop late audio than to drift seconds behind.
            try:
                self._out_queue.get_nowait()
                self._out_queue.put_nowait(frame)
            except queue.Empty:
                pass

    def stop_output(self) -> None:
        stream, self._out = self._out, None
        if stream is not None:
            try:
                stream.stop(); stream.close()  # type: ignore[attr-defined]
            except Exception:  # noqa: BLE001
                pass
        with self._out_queue.mutex:
            self._out_queue.queue.clear()
        self._carry = np.zeros(0, dtype=np.int16)


def make_audio(*, input_device: str | None, output_device: str | None, prefer_null: bool = False) -> AudioIO:
    if not prefer_null and sounddevice_available():
        try:
            return SoundDeviceIO(input_device=input_device, output_device=output_device)
        except Exception as error:  # noqa: BLE001
            log.warning("sounddevice unavailable (%s); using silent audio", error)
    return AudioIO(input_device=input_device, output_device=output_device)
