"""The /ws/device link. Mirrors the desktop companion: connect OUT, say hello
with the pairing key, answer requests, pong pings, reconnect forever. Robots
also push ``event`` and ``robot-state`` messages the server never has to ask
for.

Wire protocol (JSON):
  robot  -> server  {type:'hello', deviceId, registrationKey, name, platform, version,
                     kind:'robot', capabilities:[...], robot:{...status}}
                    {type:'reply', id, ok, result|error}
                    {type:'pong'}
                    {type:'robot-state', robot:{...status}}
                    {type:'event', event:{name, data}}
  server -> robot   {type:'ready'} {type:'request', id, op, params} {type:'ping'} {type:'cancel', id}
"""

from __future__ import annotations

import asyncio
import json
import logging
import platform
from typing import Any, Awaitable, Callable

import websockets

from . import PROTOCOL_VERSION
from .identity import Identity

log = logging.getLogger("tardis.link")

Handler = Callable[[str, dict[str, Any], asyncio.Event], Awaitable[Any]]
StatusFn = Callable[[], dict[str, Any]]

MAX_PAYLOAD = 4 * 1024 * 1024
RECONNECT_MIN = 2.0
RECONNECT_MAX = 30.0


class DeviceLink:
    def __init__(
        self,
        *,
        ws_url: str,
        identity: Identity,
        name: str,
        capabilities: list[str],
        status: StatusFn,
        handler: Handler,
        on_ready: Callable[[], Awaitable[None]] | None = None,
        on_drop: Callable[[], Awaitable[None]] | None = None,
    ) -> None:
        self.ws_url = ws_url
        self.identity = identity
        self.name = name
        self.capabilities = capabilities
        self.status = status
        self.handler = handler
        self.on_ready = on_ready
        self.on_drop = on_drop
        self._ws: websockets.WebSocketClientProtocol | None = None
        self._ready = False
        self._closing = False
        self._inflight: dict[str, tuple[asyncio.Task[Any], asyncio.Event]] = {}
        self._send_lock = asyncio.Lock()

    @property
    def connected(self) -> bool:
        return self._ready and self._ws is not None

    async def run(self) -> None:
        delay = RECONNECT_MIN
        while not self._closing:
            try:
                await self._session()
                delay = RECONNECT_MIN
            except asyncio.CancelledError:
                raise
            except Exception as error:  # noqa: BLE001 - keep the link alive whatever happens
                log.warning("link lost: %s", error)
            if self._closing:
                break
            await asyncio.sleep(delay)
            delay = min(RECONNECT_MAX, delay * 1.7)

    async def close(self) -> None:
        self._closing = True
        await self._cancel_all("robot shutting down")
        if self._ws is not None:
            await self._ws.close()

    async def _session(self) -> None:
        log.info("connecting to %s", self.ws_url)
        async with websockets.connect(self.ws_url, max_size=MAX_PAYLOAD, ping_interval=None, open_timeout=15) as ws:
            self._ws = ws
            await self._send({
                "type": "hello",
                "deviceId": self.identity.device_id,
                "registrationKey": self.identity.registration_key,
                "name": self.name,
                "platform": platform.system().lower() or "linux",
                "version": PROTOCOL_VERSION,
                "kind": "robot",
                "capabilities": self.capabilities,
                "robot": self.status(),
            })
            try:
                async for raw in ws:
                    await self._on_message(raw)
            finally:
                self._ws = None
                was_ready = self._ready
                self._ready = False
                await self._cancel_all("link dropped")
                if was_ready and self.on_drop:
                    await self.on_drop()

    async def _on_message(self, raw: str | bytes) -> None:
        try:
            msg = json.loads(raw)
        except ValueError:
            return
        kind = msg.get("type")
        if kind == "ready":
            self._ready = True
            log.info("linked as %s (%s)", self.name, self.identity.device_id)
            if self.on_ready:
                await self.on_ready()
        elif kind == "ping":
            await self._send({"type": "pong"})
        elif kind == "request":
            request_id = msg.get("id")
            op = msg.get("op")
            if not isinstance(request_id, str) or not isinstance(op, str):
                return
            params = msg.get("params") if isinstance(msg.get("params"), dict) else {}
            cancel = asyncio.Event()
            task = asyncio.create_task(self._run_request(request_id, op, params, cancel))
            self._inflight[request_id] = (task, cancel)
        elif kind == "cancel":
            request_id = str(msg.get("id", ""))
            entry = self._inflight.get(request_id)
            if entry:
                entry[1].set()
            await self._send({"type": "cancelled", "id": request_id})
        elif kind == "error":
            log.error("server: %s", msg.get("message"))

    async def _run_request(self, request_id: str, op: str, params: dict[str, Any], cancel: asyncio.Event) -> None:
        try:
            timeout_ms = params.get("timeoutMs")
            budget = max(1.0, float(timeout_ms) / 1000) if isinstance(timeout_ms, (int, float)) else 60.0
            result = await asyncio.wait_for(self.handler(op, params, cancel), timeout=budget)
            reply: dict[str, Any] = {"type": "reply", "id": request_id, "ok": True, "result": result}
        except asyncio.TimeoutError:
            reply = {"type": "reply", "id": request_id, "ok": False, "error": f"{op} did not finish in time on the robot."}
        except asyncio.CancelledError:
            reply = {"type": "reply", "id": request_id, "ok": False, "error": f"{op} was cancelled."}
        except RuntimeError as error:
            # Expected refusals (unknown command, body busy, no camera): one line, no traceback.
            log.warning("op %s refused: %s", op, error)
            reply = {"type": "reply", "id": request_id, "ok": False, "error": str(error)}
        except Exception as error:  # noqa: BLE001 - every failure becomes a reply the agent can read
            log.exception("op %s failed", op)
            reply = {"type": "reply", "id": request_id, "ok": False, "error": str(error) or error.__class__.__name__}
        finally:
            self._inflight.pop(request_id, None)
        if cancel.is_set():
            return
        # A reply the link cannot carry must still be answered, or the server
        # waits for its timeout with nothing to tell the agent.
        if len(json.dumps(reply, separators=(",", ":"))) > MAX_PAYLOAD:
            reply = {"type": "reply", "id": request_id, "ok": False, "error": f"{op} produced a result too large for the link; ask for a smaller size."}
        await self._send(reply)

    async def _cancel_all(self, reason: str) -> None:
        for request_id, (task, cancel) in list(self._inflight.items()):
            cancel.set()
            task.cancel()
            self._inflight.pop(request_id, None)
        if reason:
            log.debug("cancelled in-flight requests: %s", reason)

    async def send_event(self, name: str, data: dict[str, Any] | None = None) -> None:
        if not self.connected:
            return
        await self._send({"type": "event", "event": {"name": name, "data": data or {}}})

    async def send_state(self) -> None:
        if not self.connected:
            return
        await self._send({"type": "robot-state", "robot": self.status()})

    async def _send(self, payload: dict[str, Any]) -> None:
        ws = self._ws
        if ws is None:
            return
        text = json.dumps(payload, separators=(",", ":"))
        if len(text) > MAX_PAYLOAD:
            log.warning("dropping oversized %s message", payload.get("type"))
            return
        async with self._send_lock:
            try:
                await ws.send(text)
            except websockets.ConnectionClosed:
                pass
