"""Pinned scrcpy v5.0.1 control messages for explicit text and Android keys.

Types 0/1: big-endian inject-keycode (14 bytes), inject-text (5+N).
Only printable ASCII and explicitly allowlisted navigation keys; no clipboard,
arbitrary keycodes, shell, IME composition, or hidden keyboard capture.
See v5.0.1 app/src/control_msg.c and server ControlMessageReader.java.
"""
import struct

from .m2_touch import InvalidTouch

MAX_TEXT_BYTES = 300
ANDROID_KEYS = {
    "back": 4, "home": 3, "recents": 187, "enter": 66, "backspace": 67,
}


def encode_text(payload):
    if not isinstance(payload, dict) or set(payload) != {"type", "session_id", "text"}:
        raise InvalidTouch("文字输入字段无效")
    if payload["type"] != "input_text":
        raise InvalidTouch("只允许明确提交文字")
    value = payload["text"]
    if type(value) is not str or not value or len(value) > MAX_TEXT_BYTES or any(
        ord(c) < 32 or ord(c) > 126 for c in value
    ):
        raise InvalidTouch("首版只支持 1–300 字节可打印英文、数字及 ASCII 符号；不支持中文或换行")
    data = value.encode("ascii")
    return struct.pack(">BI", 1, len(data)) + data


def encode_key(payload):
    if not isinstance(payload, dict) or set(payload) != {"type", "session_id", "key"}:
        raise InvalidTouch("按键字段无效")
    if payload["type"] != "nav_key" or type(payload["key"]) is not str or payload["key"] not in ANDROID_KEYS:
        raise InvalidTouch("不支持的 Android 导航键")
    keycode = ANDROID_KEYS[payload["key"]]
    # Inject DOWN then UP together, without holding a key indefinitely.
    return struct.pack(">BBIII", 0, 0, keycode, 0, 0) + struct.pack(">BBIII", 0, 1, keycode, 0, 0)
