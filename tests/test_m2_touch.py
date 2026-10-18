"""M2-02 v5.0.1 pinned scrcpy touch messages and same-session control gating."""
import importlib
import queue
import socket
import struct
import threading

import pytest
from fastapi.testclient import TestClient

from server.devices import DeviceManager
from server.store import DeviceStore
from server.m2_live import LiveRegistry, LiveVideo
from server.m2_touch import InvalidTouch, encode_touch

AUTH = {"X-EasyADB-Token": "local-test-token-123"}


def event(action, x=50, y=300, width=720, height=1600, session_id="session"):
    return {"type": "touch", "session_id": session_id, "action": action,
            "x": x, "y": y, "width": width, "height": height}


def test_pinned_scrcpy_v501_touch_protocol_32_bytes():
    pressed = False
    for action, motion_action, pressure, state in (
        ("down", 0, 65535, True), ("move", 2, 65535, True),
        ("up", 1, 0, False),
    ):
        data, pressed = encode_touch(event(action), (720, 1600), pressed)
        assert pressed is state and len(data) == 32
        unpacked = struct.unpack(">BBQiiHHHII", data)
        assert unpacked == (2, motion_action, 2**64 - 2, 50, 300,
                            720, 1600, pressure, 0, 0)
    data, state = encode_touch(event("down", 0, 0), (720, 1600), False)
    assert state and data[0:2] == b"\x02\x00"
    data, state = encode_touch(event("cancel", 719, 1599), (720, 1600), True)
    assert not state and data[0:2] == b"\x02\x03"


@pytest.mark.parametrize("changes", [
    {"x": -1}, {"x": 720}, {"y": 1600}, {"y": -1},
    {"x": True}, {"width": False}, {"width": 1440},
    {"height": 3200}, {"action": "keycode"}, {"action": []},
    {"type": "shell"}, {"extra": "adb shell input tap 1 1"},
])
def test_reject_untrusted_or_stale_touch(changes):
    payload = event("down")
    payload.update(changes)
    with pytest.raises(InvalidTouch):
        encode_touch(payload, (720, 1600), False)


def test_touch_sequence_cannot_begin_with_move_or_double_down():
    for action in ("move", "up", "cancel"):
        with pytest.raises(InvalidTouch):
            encode_touch(event(action), (720, 1600), False)
    with pytest.raises(InvalidTouch):
        encode_touch(event("down"), (720, 1600), True)


def test_live_touch_sends_only_its_own_control_socket():
    stream = LiveVideo("selected-only:5555", "baseline")
    left, right = socket.socketpair()
    try:
        with stream._touch_lock:
            stream.control_sock = left
            stream.touch_size = (720, 1600)
        stream.send_touch(event("down", session_id=stream.session_id))
        first = right.recv(32)
        assert len(first) == 32 and first[0:2] == b"\x02\x00"
        with pytest.raises(InvalidTouch):
            stream.send_touch(event("down", session_id=stream.session_id))
        with pytest.raises(InvalidTouch):
            stream.send_touch(event("move", session_id="other-session"))
        stream.release_touch()
        second = right.recv(32)
        assert second[0:2] == b"\x02\x03"
        assert not stream.touch_pressed
        stream.stop()
        with pytest.raises(InvalidTouch):
            stream.send_touch(event("down", session_id=stream.session_id))
    finally:
        right.close()
        left.close()


def test_same_websocket_must_opt_in_before_touch_and_reject_stale_size(monkeypatch, tmp_path):
    monkeypatch.setenv("EASYADB_TOKEN", "local-test-token-123")
    mod = importlib.import_module("server.app")
    mod.store = DeviceStore(str(tmp_path / "touch.sqlite3"))
    mod.manager = DeviceManager(mod.store, mod.adb)
    mod.live_registry = LiveRegistry()
    monkeypatch.setattr(mod, "is_connected", lambda serial: True)
    made = []

    class FakeStream:
        def __init__(self, serial, profile):
            self.serial, self.profile = serial, profile
            self.session_id = f"touch-session-{len(made)}"
            self.events = queue.Queue()
            self.finished = threading.Event()
            self.sent = []
            self.pressed = False
            self.released = 0
            made.append(self)

        def start(self):
            self.events.put(("init", {
                "width": 720, "height": 1600, "mime": 'video/mp4; codecs="avc1.640028"',
                "control_available": True,
            }))

        def diagnostics(self): return {"stage": "测试"}
        def send_touch(self, payload):
            packet, self.pressed = encode_touch(payload, (720, 1600), self.pressed)
            self.sent.append(packet)
        def release_touch(self):
            self.released += 1
            self.pressed = False
        def stop(self): self.finished.set()
        def join(self, timeout=20): self.finished.wait(timeout)

    monkeypatch.setattr(mod, "LiveVideo", FakeStream)
    with TestClient(mod.app) as client:
        d = client.post("/api/devices", headers=AUTH, json={
            "name": "Phone", "ip": "10.10.30.206", "port": 40455,
        }).json()
        mod.manager._set_state(d["id"], "connected", serial=d["selected_serial"], route="mesh")
        path = f"/api/devices/{d['id']}/m2/live"
        with client.websocket_connect(path, headers={"origin": "http://testserver"}) as ws:
            ws.send_json({"token": "local-test-token-123", "player": "mse",
                          "profile": "baseline", "selected_serial": d["selected_serial"]})
            while (msg := ws.receive_json())["type"] != "init":
                assert msg["type"] in ("starting", "diagnostic")
            sid = msg["session_id"]
            assert msg["control_available"] is True
            ws.send_json(event("down", session_id=sid))
            while (msg := ws.receive_json())["type"] != "touch_error":
                assert msg["type"] == "diagnostic"
            assert not made[0].sent
            ws.send_json({"type": "control_enable", "session_id": sid})
            while ws.receive_json()["type"] != "control_enabled": pass
            ws.send_json(event("down", session_id=sid, width=1440))
            while (msg := ws.receive_json())["type"] != "touch_error": pass
            assert not made[0].sent
            ws.send_json(event("down", session_id=sid))
            ws.send_json(event("up", session_id=sid))
            ws.send_json({"type": "control_disable", "session_id": sid})
            while ws.receive_json()["type"] != "control_disabled": pass
            assert len(made[0].sent) == 2
            assert made[0].sent[0][1] == 0 and made[0].sent[1][1] == 1
            assert made[0].released == 1
            ws.send_text("stop")
            for _ in range(12):
                if ws.receive_json()["type"] == "ended":
                    break
            else:
                pytest.fail("stop acknowledgment missing")
        assert not mod.live_registry.sessions


def test_touch_asset_served(monkeypatch):
    monkeypatch.setenv("EASYADB_TOKEN", "local-test-token-123")
    mod = importlib.import_module("server.app")
    with TestClient(mod.app) as client:
        r = client.get("/m2-touch.js")
        assert r.status_code == 200 and "EasyADBTouch" in r.text
        assert r.headers["cache-control"] == "no-store"
