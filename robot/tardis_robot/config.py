"""Environment-driven configuration. Reads a ``.env`` next to the working
directory (or ``TARDIS_ROBOT_ENV``) first so a systemd unit and a shell session
see the same values; real environment variables always win."""

from __future__ import annotations

import os
import socket
from dataclasses import dataclass, field
from pathlib import Path


def _load_dotenv(path: Path) -> None:
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def _flag(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _num(name: str, default: float, lo: float, hi: float) -> float:
    try:
        value = float(os.environ.get(name, "") or default)
    except ValueError:
        return default
    return min(hi, max(lo, value))


@dataclass
class Config:
    url: str
    name: str
    hardware: str = "auto"
    state_dir: Path = field(default_factory=lambda: Path.home() / ".config" / "tardis-robot")
    voice: str = "auto"
    wake_word: str = "hey_jarvis"
    wake_threshold: float = 0.5
    touch_summon: bool = True
    voice_idle_secs: float = 45.0
    voice_gate: bool = True
    voice_aec: bool = False
    audio_input: str | None = None
    audio_output: str | None = None
    volume: int = 70
    eye_color: str = "SKY_BLUE"
    eye_background: str = "BLACK"
    log_level: str = "INFO"
    status_interval_secs: float = 30.0

    @property
    def ws_url(self) -> str:
        base = self.url.rstrip("/")
        if base.startswith("https://"):
            return "wss://" + base[len("https://"):] + "/ws/device"
        if base.startswith("http://"):
            return "ws://" + base[len("http://"):] + "/ws/device"
        raise ValueError("TARDIS_URL must start with http:// or https://")

    @property
    def slug(self) -> str:
        keep = "".join(c if c.isalnum() else "-" for c in self.name.strip().lower())
        return "-".join(part for part in keep.split("-") if part) or "robot"

    @property
    def voice_identity(self) -> str:
        # The server keys the Jarvis thread on this identity: `jarvis-robot-<slug>`.
        return f"robot-{self.slug}"[:40]


def load_config() -> Config:
    env_file = os.environ.get("TARDIS_ROBOT_ENV")
    _load_dotenv(Path(env_file) if env_file else Path.cwd() / ".env")
    url = os.environ.get("TARDIS_URL", "").strip()
    if not url:
        raise SystemExit("TARDIS_URL is required (the ship's address, e.g. https://your-server.your-tailnet.ts.net)")
    state_dir = os.environ.get("TARDIS_ROBOT_STATE_DIR", "").strip()
    return Config(
        url=url,
        name=os.environ.get("TARDIS_ROBOT_NAME", "").strip() or socket.gethostname() or "Robot",
        hardware=os.environ.get("TARDIS_ROBOT_HARDWARE", "auto").strip().lower() or "auto",
        state_dir=Path(state_dir).expanduser() if state_dir else Path.home() / ".config" / "tardis-robot",
        voice=os.environ.get("TARDIS_VOICE", "auto").strip().lower() or "auto",
        wake_word=os.environ.get("TARDIS_WAKE_WORD", "hey_jarvis").strip() or "off",
        wake_threshold=_num("TARDIS_WAKE_THRESHOLD", 0.5, 0.05, 0.99),
        touch_summon=_flag("TARDIS_TOUCH_SUMMON", True),
        voice_idle_secs=_num("TARDIS_VOICE_IDLE_SECS", 45, 10, 600),
        voice_gate=_flag("TARDIS_VOICE_GATE", True),
        voice_aec=_flag("TARDIS_VOICE_AEC", False),
        audio_input=os.environ.get("TARDIS_AUDIO_INPUT", "").strip() or None,
        audio_output=os.environ.get("TARDIS_AUDIO_OUTPUT", "").strip() or None,
        volume=int(_num("TARDIS_ROBOT_VOLUME", 70, 0, 100)),
        eye_color=os.environ.get("TARDIS_EYE_COLOR", "SKY_BLUE").strip().upper() or "SKY_BLUE",
        eye_background=os.environ.get("TARDIS_EYE_BACKGROUND", "BLACK").strip().upper() or "BLACK",
        log_level=os.environ.get("TARDIS_LOG_LEVEL", "INFO").strip().upper() or "INFO",
    )
