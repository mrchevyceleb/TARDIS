"""DolyHardware against stub doly_* modules shaped like the SDK's pybind11
bindings (SDK/examples/python/*/source/bindings.cpp in DOLY-DIY). Guards the
call signatures and sensor polarity that cannot be checked without a robot."""

from __future__ import annotations

import enum
import os
import sys
import time
import types
import unittest
from typing import Any

os.environ.pop("TARDIS_TURN_SIGN", None)

CALLS: list[tuple[str, tuple[Any, ...], dict[str, Any]]] = []
CALLBACKS: dict[str, Any] = {}


def _record(module: str, name: str, result: Any = 0):
    def fn(*args: Any, **kwargs: Any) -> Any:
        CALLS.append((f"{module}.{name}", args, kwargs))
        return result
    return fn


def _callback_setter(key: str):
    def fn(cb: Any) -> None:
        CALLBACKS[key] = cb
    return fn


class _Obj:
    def __init__(self, **fields: Any) -> None:
        self.__dict__.update(fields)


def _module(name: str, **attrs: Any) -> types.ModuleType:
    mod = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(mod, key, value)
    sys.modules[name] = mod
    return mod


def install_stubs() -> dict[str, Any]:
    ColorCode = enum.Enum("ColorCode", "Black White Gray Salmon Red DarkRed Pink Orange Gold Yellow Purple Magenta Lime Green DarkGreen Cyan SkyBlue Blue DarkBlue Brown")

    class Color:
        def __init__(self, code: Any) -> None:
            self.code = code

        @staticmethod
        def from_code(code: Any) -> "Color":
            return Color(code)

    _module("doly_color", ColorCode=ColorCode, Color=Color)
    _module("doly_helper", stop_doly_service=_record("helper", "stop_doly_service", 0), read_settings=_record("helper", "read_settings", 0), get_imu_offsets=lambda: (0, 1, 2, 3, 4, 5, 6))

    EyeSide = enum.Enum("EyeSide", "Both Left Right")
    IrisShape = enum.Enum("IrisShape", "Classic Modern Space Orbit Glow Digi")
    expressions = types.SimpleNamespace(ATTENTION_LEFT="ATTENTION LEFT", HAPPY="HAPPY", SLEEP="SLEEP", AWAKE_L="AWAKE L")
    _module("doly_eye", EyeSide=EyeSide, IrisShape=IrisShape, expressions=expressions, init=_record("eye", "init", 0), set_animation=_record("eye", "set_animation", 0), set_iris=_record("eye", "set_iris", 0), set_background=_record("eye", "set_background", 0), is_animating=lambda: False, abort=_record("eye", "abort"), dispose=_record("eye", "dispose"), get_version=lambda: 0.1)

    LedSide = enum.Enum("LedSide", "Both Left Right")

    class LedActivity:
        mainColor = None
        fadeColor = None
        fade_time = 0

    _module("doly_led", LedSide=LedSide, LedActivity=LedActivity, init=_record("led", "init", 0), process_activity=_record("led", "process_activity"), abort=_record("led", "abort"), dispose=_record("led", "dispose", 0))

    SoundState = enum.Enum("SoundState", "Set Stop Play")
    _module("doly_sound", SoundState=SoundState, init=_record("sound", "init", 0), set_volume=_record("sound", "set_volume", 0), play=_record("sound", "play", 0), get_state=lambda: SoundState.Stop, abort=_record("sound", "abort"), dispose=_record("sound", "dispose", 0))
    VoiceModel = enum.Enum("VoiceModel", "Model1 Model2 Model3")
    _module("doly_tts", VoiceModel=VoiceModel, init=_record("tts", "init", 0), produce=_record("tts", "produce", 0), dispose=_record("tts", "dispose", 0))

    TouchSide = enum.Enum("TouchSide", "Both Left Right")
    TouchState = enum.Enum("TouchState", "Up Down")
    TouchActivity = enum.Enum("TouchActivity", "Patting Disturb")
    _module("doly_touch", TouchSide=TouchSide, TouchState=TouchState, TouchActivity=TouchActivity, init=_record("touch", "init", 0), on_touch=_callback_setter("touch"), on_touch_activity=_callback_setter("touch_activity"), is_touched=lambda side: False, dispose=_record("touch", "dispose", 0))

    TofSide = enum.Enum("TofSide", "Left Right")
    TofGestureType = enum.Enum("TofGestureType", "Undefined ObjectComing ObjectGoing Scrubing ToLeft ToRight")
    _module("doly_tof", TofSide=TofSide, TofGestureType=TofGestureType, init=_record("tof", "init", 0), setup_continuous=_record("tof", "setup_continuous", 0), on_proximity_gesture=_callback_setter("tof_gesture"), on_proximity_threshold=_callback_setter("tof_threshold"), get_sensors_data=lambda: [_Obj(side=TofSide.Left, range_mm=200, error=0), _Obj(side=TofSide.Right, range_mm=210, error=0)], dispose=_record("tof", "dispose", 0))

    GpioState = enum.Enum("GpioState", "Low High")
    SensorId = enum.Enum("SensorId", "Back_Left Back_Right Front_Left Front_Right")
    GapDirection = enum.Enum("GapDirection", "Front Front_Left Front_Right Back Back_Left Back_Right Left Right Cross_Left Cross_Right All")
    edge_low: list[Any] = []
    _module("doly_edge", GpioState=GpioState, SensorId=SensorId, GapDirection=GapDirection, init=_record("edge", "init", 0), on_change=_callback_setter("edge_change"), on_gap_detect=_callback_setter("edge_gap"), get_sensors=lambda state: [_Obj(id=i, state=GpioState.Low) for i in edge_low] if state == GpioState.Low else [], dispose=_record("edge", "dispose", 0))

    ImuGesture = enum.Enum("ImuGesture", "Undefined Move LongShake ShortShake Vibrate VibrateExtreme ShockLight ShockMedium ShockHard ShockExtreme")
    GestureDirection = enum.Enum("GestureDirection", "Left Right Up Down Front Back")
    _module("doly_imu", ImuGesture=ImuGesture, GestureDirection=GestureDirection, init=_record("imu", "init", 0), on_gesture=_callback_setter("imu_gesture"), get_imu_data=lambda: _Obj(ypr=_Obj(yaw=1.0, pitch=2.0, roll=3.0)), dispose=_record("imu", "dispose", 0))
    _module("doly_battery", init=_record("battery", "init", 0), on_alarm=_callback_setter("battery_alarm"), set_alarm_threshold=_record("battery", "set_alarm_threshold", 0), get_capacity=lambda: 77, dispose=_record("battery", "dispose", 0))

    ArmSide = enum.Enum("ArmSide", "Both Left Right")
    ArmState = enum.Enum("ArmState", "Running Completed Error")
    _module("doly_arm", ArmSide=ArmSide, ArmState=ArmState, init=_record("arm", "init", 0), set_angle=_record("arm", "set_angle", 0), get_state=lambda side: ArmState.Completed, get_current_angle=lambda side: [_Obj(side=ArmSide.Left, angle=90.0), _Obj(side=ArmSide.Right, angle=90.0)], abort=_record("arm", "abort"), get_max_angle=lambda: 180, dispose=_record("arm", "dispose", 0))

    DriveState = enum.Enum("DriveState", "Running Completed Error")
    _module("doly_drive", DriveState=DriveState, init=_record("drive", "init", 0), on_error=_callback_setter("drive_error"), go_distance=_record("drive", "go_distance", True), go_rotate=_record("drive", "go_rotate", True), free_drive=_record("drive", "free_drive", True), abort=_record("drive", "abort"), get_state=lambda: DriveState.Completed, get_position=lambda: _Obj(x=1.0, y=2.0, head=3.0), dispose=_record("drive", "dispose", 0))
    return {"edge_low": edge_low, "GpioState": GpioState, "SensorId": SensorId, "GapDirection": GapDirection, "TouchSide": TouchSide, "TouchState": TouchState, "ArmSide": ArmSide}


STUBS = install_stubs()

from tardis_robot.hardware.doly import DolyHardware  # noqa: E402


def calls(name: str) -> list[tuple[tuple[Any, ...], dict[str, Any]]]:
    return [(args, kwargs) for called, args, kwargs in CALLS if called == name]


class DolyBackendTests(unittest.TestCase):
    def setUp(self) -> None:
        CALLS.clear()
        CALLBACKS.clear()
        STUBS["edge_low"].clear()
        self.events: list[tuple[str, dict[str, Any]]] = []
        self.hw = DolyHardware(eye_color="SKY_BLUE", eye_background="BLACK", volume=60)
        self.hw.set_event_sink(lambda name, data: self.events.append((name, data)))
        self.hw.start()

    def test_start_brings_every_subsystem_up_with_calibrated_offsets(self) -> None:
        self.assertEqual(self.hw.errors, [])
        for capability in ("drive", "turn", "arms", "edge", "touch", "imu", "battery", "say", "leds", "express"):
            self.assertIn(capability, self.hw.capabilities)
        self.assertEqual(calls("drive.init")[0][0], (1, 2, 3, 4, 5, 6))
        self.assertEqual(calls("imu.init")[0][0], (1, 1, 2, 3, 4, 5, 6))
        self.assertEqual(self.hw.status().battery, 77)

    def test_drive_sends_positive_distance_and_direction_flag(self) -> None:
        self.hw.drive(-120, 40)
        args, _ = calls("drive.go_distance")[0]
        self.assertEqual(args[1:], (120, 40, False, True))
        self.hw.drive(80.4, 55)
        args, _ = calls("drive.go_distance")[1]
        self.assertEqual(args[1:], (80, 55, True, True))

    def test_turn_spins_in_place_counter_clockwise_for_positive_degrees(self) -> None:
        result = self.hw.turn(90, 40)
        args, _ = calls("drive.go_rotate")[0]
        self.assertEqual(args[1:], (-90.0, True, 40, True, True))
        self.assertTrue(result["moved"])

    def test_arms_use_documented_argument_order(self) -> None:
        self.hw.arms(45, 30, "left")
        args, kwargs = calls("arm.set_angle")[0]
        self.assertEqual(args[1], STUBS["ArmSide"].Left)
        self.assertEqual((kwargs["speed"], kwargs["angle"], kwargs["with_brake"]), (30, 45, False))

    def test_express_maps_spaced_names_to_sdk_expression_strings(self) -> None:
        self.hw.express("ATTENTION LEFT")
        self.assertEqual(calls("eye.set_animation")[0][0][1], "ATTENTION LEFT")

    def test_edge_low_means_no_ground(self) -> None:
        STUBS["edge_low"].append(STUBS["SensorId"].Front_Left)
        self.assertEqual(self.hw.drive(200, 40)["reason"], "edge detected; refusing to drive")
        self.assertEqual(calls("drive.go_distance"), [])
        self.assertEqual(self.hw.sensors()["edge"], {"noGround": ["front_left"]})
        CALLBACKS["edge_change"]([_Obj(id=STUBS["SensorId"].Front_Left, state=STUBS["GpioState"].Low), _Obj(id=STUBS["SensorId"].Back_Right, state=STUBS["GpioState"].High)])
        self.assertEqual(self.events[-1], ("edge", {"sensors": [("front_left", "low"), ("back_right", "high")], "triggered": ["front_left"]}))
        CALLBACKS["edge_gap"](STUBS["GapDirection"].Front_Right)
        self.assertEqual(self.events[-1], ("edge", {"gap": "front_right", "triggered": ["front_right"]}))

    def test_touch_derives_long_press_and_double_tap(self) -> None:
        self.hw.LONG_PRESS_SECS = 0.05
        self.hw.DOUBLE_TAP_SECS = 0.5
        left, down, up = STUBS["TouchSide"].Left, STUBS["TouchState"].Down, STUBS["TouchState"].Up
        CALLBACKS["touch"](left, down)
        time.sleep(0.08)
        CALLBACKS["touch"](left, up)
        self.assertIn(("touch_activity", {"side": "left", "activity": "long"}), self.events)
        for _ in range(2):
            CALLBACKS["touch"](left, down)
            CALLBACKS["touch"](left, up)
        self.assertIn(("touch_activity", {"side": "left", "activity": "double_tap"}), self.events)

    def test_stop_motion_aborts_wheels_and_arms(self) -> None:
        self.hw.stop_motion()
        self.assertEqual(len(calls("drive.abort")), 1)
        self.assertEqual([a for a, _ in calls("drive.free_drive")], [(0, False, True), (0, True, True)])
        self.assertEqual(calls("arm.abort")[0][0], (STUBS["ArmSide"].Both,))


if __name__ == "__main__":
    unittest.main()
