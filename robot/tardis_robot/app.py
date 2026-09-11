"""Wires the body, the link, the reflexes and the voice together."""

from __future__ import annotations

import asyncio
import logging
import signal
from typing import Any

from .behaviors import Behaviors
from .config import Config
from .hardware import select_hardware
from .identity import load_identity
from .link import DeviceLink
from .ops import Ops
from .voice.audio import make_audio
from .voice.session import VoiceSession, livekit_available
from .voice.wake import WakeListener, openwakeword_available

log = logging.getLogger("tardis.robot")


class RobotApp:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.identity = load_identity(config.state_dir)
        self.voice_identity = config.voice_identity(self.identity.device_id)
        self.hw = select_hardware(config.hardware, eye_color=config.eye_color, eye_background=config.eye_background, volume=config.volume)
        self.audio = make_audio(input_device=config.audio_input, output_device=config.audio_output)
        self.voice: VoiceSession | None = None
        self.wake: WakeListener | None = None
        self.ops = Ops(self.hw, name=config.name, speak_guard=self._speak_guard, voice_state=lambda: self.voice.state if self.voice else "off")
        self.behaviors = Behaviors(
            self.hw,
            send_event=self._send_event,
            send_state=self._send_state,
            summon=self.summon,
            dismiss=self.dismiss,
            voice_active=lambda: bool(self.voice and self.voice.active),
            touch_summon=config.touch_summon,
            status_interval=config.status_interval_secs,
        )
        self.link = DeviceLink(
            ws_url=config.ws_url,
            identity=self.identity,
            name=config.name,
            capabilities=list(self.hw.capabilities),
            status=self._status,
            handler=self.ops.handle,
            on_ready=self._on_ready,
            on_drop=self._on_drop,
        )
        self._stopping = asyncio.Event()

    # ------------------------------------------------------------------ status
    def _status(self) -> dict[str, Any]:
        try:
            status = self.hw.status().as_dict()
        except Exception as error:  # noqa: BLE001
            status = {"hardware": self.hw.name, "errors": [str(error)]}
        status["voice"] = self.voice.state if self.voice else "off"
        return status

    def _speak_guard(self) -> str | None:
        if self.voice and self.voice.active:
            return "A live voice call is running on the robot: your spoken reply already plays there. Use robot_express instead."
        return None

    async def _send_event(self, name: str, data: dict[str, Any]) -> None:
        await self.link.send_event(name, data)

    async def _send_state(self) -> None:
        await self.link.send_state()

    async def _on_ready(self) -> None:
        await self.link.send_state()
        try:
            await asyncio.to_thread(self.hw.express, "DISCOVER", False)
        except Exception:  # noqa: BLE001
            pass

    async def _on_drop(self) -> None:
        # Never keep rolling on a dead link.
        await asyncio.to_thread(self.hw.stop_motion)

    # ------------------------------------------------------------------- voice
    async def _setup_voice(self) -> None:
        if self.config.voice == "off":
            log.info("voice off by configuration")
            return
        if not livekit_available():
            if self.config.voice == "on":
                log.error("TARDIS_VOICE=on but the livekit package is missing (pip install 'tardis-robot[voice]')")
            else:
                log.info("livekit not installed; voice off")
            return
        # A real body with no working audio must not advertise a voice it
        # cannot hear or speak with. The mock body may join with silent audio
        # for development.
        if self.audio.name == "null" and self.hw.name != "mock":
            if self.config.voice == "on":
                log.error("TARDIS_VOICE=on but no audio device is available (install sounddevice/libportaudio2 and check TARDIS_AUDIO_INPUT/OUTPUT)")
            else:
                log.info("no audio device available; voice off")
            return
        session = VoiceSession(
            base_url=self.config.url,
            identity=self.voice_identity,
            audio=self.audio,
            on_state=self.behaviors.on_voice_state,
            idle_secs=self.config.voice_idle_secs,
            gate=self.config.voice_gate,
            aec=self.config.voice_aec,
        )
        if not await session.server_enabled():
            if self.config.voice == "on":
                log.error("the ship has no LiveKit configured; voice cannot start")
            else:
                log.info("the ship has no LiveKit configured; voice off")
            return
        self.voice = session
        log.info("voice ready as %s (idle %.0fs, gate %s, aec %s)", self.voice_identity, self.config.voice_idle_secs, self.config.voice_gate, self.config.voice_aec)
        if self.config.wake_word.lower() != "off" and openwakeword_available():
            wake = WakeListener(audio=self.audio, model=self.config.wake_word, threshold=self.config.wake_threshold, on_wake=self.summon)
            if await asyncio.to_thread(wake.load):
                try:
                    wake.start(asyncio.get_running_loop())
                    self.wake = wake
                except Exception as error:  # noqa: BLE001 - an optional feature must never take the link down
                    log.error("wake word disabled: microphone could not be opened (%s)", error)

    async def summon(self) -> None:
        if self.voice is None:
            log.info("summon ignored: voice unavailable")
            try:
                await asyncio.to_thread(self.hw.express, "PUZZLED", False)
            except Exception:  # noqa: BLE001
                pass
            return
        if self.voice.active:
            return
        if self.wake:
            self.wake.stop()
        await self.link.send_event("voice_summon", {"identity": self.voice_identity})
        try:
            await self.voice.start()
        except Exception as error:  # noqa: BLE001
            log.error("voice start failed: %s", error)
            await self.link.send_event("log", {"level": "error", "message": f"voice start failed: {error}"})
            try:
                await asyncio.to_thread(self.hw.express, "CONFUSED", False)
            except Exception:  # noqa: BLE001
                pass
            if self.wake:
                self.wake.start(asyncio.get_running_loop())
            return
        asyncio.get_running_loop().create_task(self._after_call())

    async def _after_call(self) -> None:
        voice = self.voice
        if voice is None:
            return
        while voice.active:
            await asyncio.sleep(0.5)
        if self.wake and not self._stopping.is_set():
            try:
                self.wake.start(asyncio.get_running_loop())
            except Exception as error:  # noqa: BLE001
                log.error("wake word could not resume after the call: %s", error)

    async def dismiss(self) -> None:
        if self.voice and self.voice.active:
            await self.voice.stop("touch")

    # --------------------------------------------------------------------- run
    async def run(self) -> None:
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, self._stopping.set)
            except NotImplementedError:  # Windows
                pass
        log.info("starting %s body for %s", self.hw.name, self.config.name)
        await asyncio.to_thread(self.hw.start)
        # The body only knows what actually came up after start(); advertise that.
        self.link.capabilities = list(self.hw.capabilities)
        self.behaviors.attach(loop)
        await self._setup_voice()
        link_task = loop.create_task(self.link.run())
        try:
            await self._stopping.wait()
        finally:
            log.info("shutting down")
            if self.voice and self.voice.active:
                await self.voice.stop("shutdown")
            if self.wake:
                self.wake.stop()
            await self.behaviors.close()
            await self.link.close()
            link_task.cancel()
            await asyncio.to_thread(self.hw.stop)
