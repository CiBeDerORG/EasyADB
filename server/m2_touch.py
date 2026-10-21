"""Pinned scrcpy v5.0.1 touch wire format: type=2, 32-byte big-endian.

Only single-finger down/move/up/cancel for an explicitly enabled live session.
No arbitrary ADB commands, mouse-key/keyboard/clipboard or device selection.
Source: scrcpy v5.0.1 app/src/control_msg.c, server/control/ControlMessageReader.java.
"""
import struct

TOUCH_TYPE = 2
POINTER_ID_FINGER = 0xFFFFFFFFFFFFFFFE  # scrcpy generic finger (-2)
ACTIONS = {"down": 0, "up": 1, "move": 2, "cancel": 3}


class InvalidTouch(ValueError):
    pass


def encode_touch(payload, expected_size, pressed):
    """Return (bytes, next_pressed); validate before touching a socket."""
    if not isinstance(payload, dict) or set(payload) != {
        "type", "session_id", "action", "x", "y", "width", "height"
    }:
        raise InvalidTouch("触摸字段无效")
    if payload["type"] != "touch":
        raise InvalidTouch("只允许发送本轮触摸事件")
    action = payload["action"]
    if type(action) is not str or action not in ACTIONS:
        raise InvalidTouch("不支持的触摸动作")
    width, height = expected_size
    if not 0 < width <= 8192 or not 0 < height <= 8192:
        raise InvalidTouch("当前视频尺寸不可用于触摸")
    if type(payload["width"]) is not int or type(payload["height"]) is not int or (
        payload["width"], payload["height"]
    ) != expected_size:
        raise InvalidTouch("视频尺寸正在同步，请等待画面稳定后重新操作")
    x, y = payload["x"], payload["y"]
    if type(x) is not int or type(y) is not int or not (0 <= x < width and 0 <= y < height):
        raise InvalidTouch("触摸坐标必须在实际视频画面内")
    if action == "down" and pressed:
        raise InvalidTouch("上一轮触摸尚未释放")
    if action != "down" and not pressed:
        raise InvalidTouch("未按下时不能发送拖动或释放")
    # 0=DOWN, 1=UP, 2=MOVE, 3=CANCEL. Pressure is u16 fixed point.
    pressure = 0 if action in ("up", "cancel") else 0xFFFF
    encoded = struct.pack(">BBQiiHHHII", TOUCH_TYPE, ACTIONS[action],
                          POINTER_ID_FINGER, x, y, width, height, pressure, 0, 0)
    assert len(encoded) == 32
    return encoded, action in ("down", "move")
