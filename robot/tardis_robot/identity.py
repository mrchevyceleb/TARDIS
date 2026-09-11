"""Stable device identity. The server pins the registration key on first
contact (trust on first use), so a stranger who learns the public device id
still cannot replace this robot. Keep the file private."""

from __future__ import annotations

import json
import os
import secrets
import uuid
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Identity:
    device_id: str
    registration_key: str


def load_identity(state_dir: Path) -> Identity:
    state_dir.mkdir(parents=True, exist_ok=True)
    path = state_dir / "identity.json"
    if path.is_file():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            device_id = str(data.get("id", "")).strip()
            key = str(data.get("key", "")).strip()
            if device_id and len(key) == 64:
                return Identity(device_id, key)
        except (ValueError, OSError):
            pass
    identity = Identity(str(uuid.uuid4()), secrets.token_hex(32))
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps({"id": identity.device_id, "key": identity.registration_key}), encoding="utf-8")
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    tmp.replace(path)
    return identity
