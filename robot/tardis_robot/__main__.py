"""``tardis-robot`` / ``python -m tardis_robot``."""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys

from . import __version__
from .config import load_config


def main() -> int:
    parser = argparse.ArgumentParser(prog="tardis-robot", description="TARDIS robot companion")
    parser.add_argument("--url", help="ship address (overrides TARDIS_URL)")
    parser.add_argument("--name", help="robot name (overrides TARDIS_ROBOT_NAME)")
    parser.add_argument("--hardware", choices=["auto", "doly", "mock"], help="body backend (overrides TARDIS_ROBOT_HARDWARE)")
    parser.add_argument("--voice", choices=["auto", "on", "off"], help="voice through Jarvis (overrides TARDIS_VOICE)")
    parser.add_argument("--check", action="store_true", help="print the resolved configuration and exit")
    parser.add_argument("--version", action="version", version=__version__)
    args = parser.parse_args()
    if args.url:
        os.environ["TARDIS_URL"] = args.url
    if args.name:
        os.environ["TARDIS_ROBOT_NAME"] = args.name
    if args.hardware:
        os.environ["TARDIS_ROBOT_HARDWARE"] = args.hardware
    if args.voice:
        os.environ["TARDIS_VOICE"] = args.voice

    config = load_config()
    logging.basicConfig(level=getattr(logging, config.log_level, logging.INFO), format="%(asctime)s %(levelname)s %(name)s: %(message)s", stream=sys.stdout)
    if args.check:
        from .hardware import doly_sdk_available
        from .voice.audio import sounddevice_available
        from .voice.session import livekit_available
        from .voice.wake import openwakeword_available

        print(f"tardis-robot {__version__}")
        print(f"ship: {config.url}  ->  {config.ws_url}")
        print(f"name: {config.name}  (voice identity {config.voice_identity})")
        print(f"hardware: {config.hardware}  (doly sdk {'found' if doly_sdk_available() else 'not found'})")
        print(f"voice: {config.voice}  livekit={'yes' if livekit_available() else 'no'}  sounddevice={'yes' if sounddevice_available() else 'no'}  openwakeword={'yes' if openwakeword_available() else 'no'}")
        print(f"wake word: {config.wake_word} @ {config.wake_threshold}  touch summon: {config.touch_summon}")
        print(f"state dir: {config.state_dir}")
        return 0

    from .app import RobotApp

    app = RobotApp(config)
    try:
        asyncio.run(app.run())
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
