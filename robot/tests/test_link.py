"""The link against a fake ship: hello carries the robot identity, requests
get answered through the real ops layer on the mock body, and events flow up.
Run: python -m unittest discover -s robot/tests"""

from __future__ import annotations

import asyncio
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import websockets  # noqa: E402

from tardis_robot.hardware.mock import MockHardware  # noqa: E402
from tardis_robot.identity import Identity  # noqa: E402
from tardis_robot.link import DeviceLink  # noqa: E402
from tardis_robot.ops import Ops  # noqa: E402


class FakeShip:
    def __init__(self) -> None:
        self.hello: dict | None = None
        self.replies: asyncio.Queue[dict] = asyncio.Queue()
        self.events: asyncio.Queue[dict] = asyncio.Queue()
        self.socket = None
        self.ready = asyncio.Event()

    async def handler(self, ws) -> None:  # noqa: ANN001
        self.socket = ws
        async for raw in ws:
            msg = json.loads(raw)
            if msg["type"] == "hello":
                self.hello = msg
                await ws.send(json.dumps({"type": "ready"}))
                self.ready.set()
            elif msg["type"] == "reply":
                await self.replies.put(msg)
            elif msg["type"] == "event":
                await self.events.put(msg["event"])
            elif msg["type"] == "pong":
                await self.replies.put(msg)

    async def request(self, request_id: str, op: str, params: dict) -> None:
        await self.socket.send(json.dumps({"type": "request", "id": request_id, "op": op, "params": {**params, "timeoutMs": 5000}}))


class LinkTest(unittest.IsolatedAsyncioTestCase):
    async def test_hello_requests_and_events(self) -> None:
        ship = FakeShip()
        async with websockets.serve(ship.handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            hw = MockHardware(eye_color="BLUE", eye_background="BLACK", volume=50)
            hw.start()
            events: list[tuple[str, dict]] = []
            ops = Ops(hw, name="TestBot", speak_guard=lambda: None, voice_state=lambda: "off")
            link = DeviceLink(
                ws_url=f"ws://127.0.0.1:{port}/ws/device",
                identity=Identity("robot-unit-test", "ab" * 32),
                name="TestBot",
                capabilities=hw.capabilities,
                status=lambda: hw.status().as_dict(),
                handler=ops.handle,
            )
            hw.set_event_sink(lambda name, data: events.append((name, data)))
            runner = asyncio.create_task(link.run())
            try:
                await asyncio.wait_for(ship.ready.wait(), 5)
                assert ship.hello is not None
                self.assertEqual(ship.hello["kind"], "robot")
                self.assertEqual(ship.hello["deviceId"], "robot-unit-test")
                self.assertEqual(ship.hello["registrationKey"], "ab" * 32)
                self.assertIn("express", ship.hello["capabilities"])
                self.assertEqual(ship.hello["robot"]["hardware"], "mock")

                await ship.request("r1", "robot.express", {"expression": "HAPPY"})
                reply = await asyncio.wait_for(ship.replies.get(), 5)
                self.assertEqual(reply, {"type": "reply", "id": "r1", "ok": True, "result": {"expression": "HAPPY"}})
                self.assertEqual(hw.expression, "HAPPY")

                await ship.request("r2", "robot.look", {"width": 320})
                reply = await asyncio.wait_for(ship.replies.get(), 5)
                self.assertTrue(reply["ok"])
                self.assertEqual(reply["result"]["mimeType"], "image/jpeg")
                self.assertTrue(reply["result"]["image"])

                await ship.request("r3", "robot.dance", {})
                reply = await asyncio.wait_for(ship.replies.get(), 5)
                self.assertFalse(reply["ok"])
                self.assertIn("Unknown robot command", reply["error"])

                await ship.request("r4", "exec", {"command": "rm -rf /"})
                reply = await asyncio.wait_for(ship.replies.get(), 5)
                self.assertFalse(reply["ok"])
                self.assertIn("robot body", reply["error"])

                await ship.socket.send(json.dumps({"type": "ping"}))
                pong = await asyncio.wait_for(ship.replies.get(), 5)
                self.assertEqual(pong["type"], "pong")

                await link.send_event("touch", {"side": "left", "state": "down"})
                event = await asyncio.wait_for(ship.events.get(), 5)
                self.assertEqual(event, {"name": "touch", "data": {"side": "left", "state": "down"}})
            finally:
                await link.close()
                runner.cancel()
                hw.stop()

    async def test_cancel_stops_motion(self) -> None:
        ship = FakeShip()
        async with websockets.serve(ship.handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            hw = MockHardware(eye_color="BLUE", eye_background="BLACK", volume=50)
            ops = Ops(hw, name="TestBot", speak_guard=lambda: None, voice_state=lambda: "off")
            link = DeviceLink(ws_url=f"ws://127.0.0.1:{port}/ws/device", identity=Identity("robot-unit-test-2", "cd" * 32), name="TestBot", capabilities=[], status=lambda: {}, handler=ops.handle)
            runner = asyncio.create_task(link.run())
            try:
                await asyncio.wait_for(ship.ready.wait(), 5)
                await ship.request("m1", "robot.drive", {"distanceMm": 600, "speed": 20})
                await asyncio.sleep(0.3)
                self.assertTrue(hw.moving)
                await ship.socket.send(json.dumps({"type": "cancel", "id": "m1"}))
                await asyncio.sleep(0.5)
                self.assertFalse(hw.moving)
            finally:
                await link.close()
                runner.cancel()


if __name__ == "__main__":
    unittest.main()
