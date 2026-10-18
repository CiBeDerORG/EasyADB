"""M2-03: pinned scrcpy text/key format and same-session opt-in input tests."""
import importlib
import queue
import socket
import struct
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server.devices import DeviceManager
from server.store import DeviceStore
from server.m2_live import LiveRegistry, LiveVideo
from server.m2_keys import ANDROID_KEYS, encode_key, encode_text
from server.m2_touch import InvalidTouch

AUTH = {"X-EasyADB-Token": "local-test-token-123"}


def text_event(value="Hello 123", session_id="session"):
    return {"type": "input_text", "session_id": session_id, "text": value}


def nav_event(key="home", session_id="session"):
    return {"type": "nav_key", "session_id": session_id, "key": key}


def test_scrcpy_v501_ascii_text_has_four_byte_big_endian_length():
    packet = encode_text(text_event("Hello 123 !"))
    assert packet == b"\\x01" + struct.pack(">I", 11) + b"Hello 123 !"
    assert len(encode_text(text_event("A" * 300))) == 305


@pytest.mark.parametrize("value", ["", "A" * 301, "中文", "hi\\n", "\\x00", "é"])
def test_reject_unsupported_text_before_socket(value):
    with pytest.raises(InvalidTouch):
        encode_text(text_event(value))


@pytest.mark.parametrize("changes", [
    {"text": 123}, {"text": None}, {"extra": "adb shell"},
    {"type": "touch"}, {"text": ["text"]},
])
def test_reject_invalid_text_schema(changes):
    payload = text_event()
    payload.update(changes)
    with pytest.raises(InvalidTouch):
        encode_text(payload)


@pytest.mark.parametrize("key,code", sorted(ANDROID_KEYS.items()))
def test_scrcpy_v501_keycode_press_and_release_are_allowlisted(key, code):
    packet = encode_key(nav_event(key))
    assert len(packet) == 28
    assert packet == struct.pack(">BBIII", 0, 0, code, 0, 0) + struct.pack(">BBIII", 0, 1, code, 0, 0)


@pytest.mark.parametrize("changes", [
    {"key": "power"}, {"key": "volume_up"}, {"key": 4},
    {"key": None}, {"type": "shell"}, {"keycode": 26},
])
def test_no_arbitrary_keycodes_or_shell(changes):
    payload = nav_event()
    payload.update(changes)
    with pytest.raises(InvalidTouch):
        encode_key(payload)


def test_input_writes_only_pinned_control_socket_and_rejects_old_session():
    stream = LiveVideo("selected-only:5555", "baseline")
    left, right = socket.socketpair()
    right.settimeout(1)
    try:
        with stream._touch_lock:
            stream.control_sock = left
            stream.touch_size = (720, 1600)
        stream.send_text(text_event("ABC", stream.session_id))
        assert right.recv(8) == b"\\x01\\x00\\x00\\x00\\x03ABC"
        stream.send_nav(nav_event("back", stream.session_id))
        assert right.recv(28) == (struct.pack(">BBIII", 0, 0, 4, 0, 0)
                                  + struct.pack(">BBIII", 0, 1, 4, 0, 0))
        with pytest.raises(InvalidTouch):
            stream.send_text(text_event("old", "different-session"))
        with pytest.raises(InvalidTouch):
            stream.send_nav(nav_event("power", stream.session_id))
        stream.stop()
        with pytest.raises(InvalidTouch):
            stream.send_text(text_event("after stop", stream.session_id))
    finally:
        left.close()
        right.close()


def test_live_ws_requires_opt_in_and_acknowledges_only_valid_input(monkeypatch, tmp_path):
    monkeypatch.setenv("EASYADB_TOKEN", "local-test-token-123")
    mod = importlib.import_module("server.app")
    mod.store = DeviceStore(str(tmp_path / "keyboard.sqlite3"))
    mod.manager = DeviceManager(mod.store, mod.adb)
    mod.live_registry = LiveRegistry()
    monkeypatch.setattr(mod, "is_connected", lambda serial: True)
    made = []

    class FakeStream:
        def __init__(self, serial, profile):
            self.serial, self.profile = serial, profile
            self.session_id = f"keyboard-session-{len(made)}"
            self.events = queue.Queue()
            self.finished = threading.Event()
            self.sent = []
            made.append(self)

        def start(self):
            self.events.put(("init", {
                "width": 720, "height": 1600, "mime": 'video/mp4; codecs="avc1.640028"',
                "control_available": True,
            }))

        def diagnostics(self): return {"stage": "键盘测试"}
        def send_text(self, payload): self.sent.append(encode_text(payload))
        def send_nav(self, payload): self.sent.append(encode_key(payload))
        def release_touch(self): pass
        def stop(self): self.finished.set()
        def join(self, timeout=20): self.finished.wait(timeout)

    def receive_kind(ws, expected):
        for _ in range(20):
            message = ws.receive_json()
            if message["type"] == expected:
                return message
            assert message["type"] in ("diagnostic", "starting", "stopping")
        pytest.fail(f"no expected {expected} message")

    monkeypatch.setattr(mod, "LiveVideo", FakeStream)
    with TestClient(mod.app) as client:
        device = client.post("/api/devices", headers=AUTH, json={
            "name": "Phone", "ip": "10.10.30.206", "port": 40455,
        }).json()
        mod.manager._set_state(device["id"], "connected",
                               serial=device["selected_serial"], route="mesh")
        with client.websocket_connect(
            f"/api/devices/{device['id']}/m2/live",
            headers={"origin": "http://testserver"}
        ) as ws:
            ws.send_json({"token": "local-test-token-123", "player": "mse",
                          "profile": "baseline", "selected_serial": device["selected_serial"]})
            init = receive_kind(ws, "init")
            sid = init["session_id"]
            ws.send_json(text_event("NOT ALLOWED YET", sid))
            assert receive_kind(ws, "input_error")["session_id"] == sid
            assert made[0].sent == []
            ws.send_json({"type": "control_enable", "session_id": sid})
            assert receive_kind(ws, "control_enabled")["session_id"] == sid
            ws.send_json(text_event("中文", sid))
            assert receive_kind(ws, "input_error")["session_id"] == sid
            assert made[0].sent == []
            ws.send_json(text_event("Hello 123", sid))
            accepted = receive_kind(ws, "input_accepted")
            assert accepted == {"type": "input_accepted", "session_id": sid, "kind": "input_text"}
            assert len(made[0].sent) == 1 and made[0].sent[0].startswith(b"\\x01")
            assert "Hello 123" not in str(accepted)  # never echo typed content
            time.sleep(0.12)  # this UI limits deliberate input to at most 10 commands/sec
            ws.send_json(nav_event("home", sid))
            accepted = receive_kind(ws, "input_accepted")
            assert accepted["kind"] == "nav_key" and len(made[0].sent) == 2
            ws.send_json({"type": "control_disable", "session_id": sid})
            assert receive_kind(ws, "control_disabled")["session_id"] == sid
            ws.send_json(nav_event("back", sid))
            assert receive_kind(ws, "input_error")["session_id"] == sid
            assert len(made[0].sent) == 2
            ws.send_text("stop")
            assert receive_kind(ws, "ended")["cleanup_complete"] is True
        assert not mod.live_registry.sessions


def test_keyboard_ui_is_explicit_and_never_global_key_capture():
    root = Path(__file__).resolve().parents[1]
    html = (root / "web" / "index.html").read_text()
    assert 'id="liveTextForm"' in html and 'id="liveTextInput"' in html
    assert 'id="liveTextSend"' in html
    assert 'id="liveNavButtons"' in html and 'data-nav="recents"' in html
    assert 'id="m2KeyInfo"' in html and "input_accepted" in html
    assert "sendLiveInput('input_text',{text})" in html
    assert "sendLiveInput('nav_key',{key:button.dataset.nav})" in html
    assert "document.addEventListener('keydown'" not in html
    assert "window.addEventListener('keydown'" not in html
