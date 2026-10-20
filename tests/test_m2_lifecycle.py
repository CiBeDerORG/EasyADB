"""M2-04-A: unify video/touch/text/key session stop and release semantics."""
import importlib
import queue
import socket
import struct
import threading

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from server.devices import DeviceManager
from server.store import DeviceStore
from server.m2_live import LiveRegistry, LiveVideo
from server.m2_touch import InvalidTouch

AUTH = {"X-EasyADB-Token": "local-test-token-123"}


def touch(action, sid):
    return {"type": "touch", "session_id": sid, "action": action,
            "x": 10, "y": 20, "width": 720, "height": 1600}


def read_exact(sock, count):
    data = bytearray()
    while len(data) < count:
        data.extend(sock.recv(count - len(data)))
    return bytes(data)


def test_session_stop_cancels_held_finger_before_control_socket_close():
    stream = LiveVideo("manually-selected:5555", "baseline")
    left, right = socket.socketpair()
    right.settimeout(1)
    try:
        with stream._touch_lock:
            stream.control_sock = left
            stream.touch_size = (720, 1600)
        stream.send_touch(touch("down", stream.session_id))
        assert read_exact(right, 32)[:2] == b"\x02\x00"
        stream.stop()
        cancel = read_exact(right, 32)
        assert cancel[:2] == b"\x02\x03"
        assert struct.unpack(">H", cancel[22:24])[0] == 0  # pressure=0
        assert right.recv(1) == b""  # no dangling control socket
        assert stream.control_sock is None and not stream.touch_pressed
        stream.stop()  # idempotent: no additional cancel or device I/O
        with pytest.raises(InvalidTouch):
            stream.send_touch(touch("down", stream.session_id))
        with pytest.raises(InvalidTouch):
            stream.send_text({"type": "input_text", "session_id": stream.session_id, "text": "x"})
        with pytest.raises(InvalidTouch):
            stream.send_nav({"type": "nav_key", "session_id": stream.session_id, "key": "back"})
    finally:
        right.close()
        left.close()


def test_broken_control_cancel_does_not_prevent_video_and_process_stop():
    class BrokenControl:
        def sendall(self, payload): raise OSError("broken control channel")
        def shutdown(self, how): raise OSError("already closed")
        def close(self): raise OSError("close failed")
    class Video:
        closed = False
        def shutdown(self, how): pass
        def close(self): self.closed = True
    class Process:
        terminated = False
        def poll(self): return None
        def terminate(self): self.terminated = True

    stream = LiveVideo("manually-selected:5555", "baseline")
    video = Video()
    adb = Process()
    with stream._touch_lock:
        stream.control_sock = BrokenControl()
        stream.touch_size = (720, 1600)
        stream.touch_pressed = True
        stream.touch_point = (10, 20)
    with stream._resource_lock:
        stream.video_sock = video
        stream.adb_proc = adb
    stream.stop()
    assert video.closed and adb.terminated
    assert stream._close_failed and stream.control_sock is None
    assert stream.touch_point is None and not stream.touch_pressed


def test_registry_does_not_retire_terminal_but_incompletely_cleaned_worker():
    class Worker:
        def __init__(self, clean):
            self.finished = threading.Event()
            self.cleanup_complete = clean
    registry = LiveRegistry()
    old, new = Worker(False), Worker(True)
    assert registry.reserve("device", old)
    old.finished.set()
    assert not registry.is_cleaned(old)
    assert not registry.reserve("device", new)
    assert registry.sessions["device"] is old
    old.cleanup_complete = True
    assert registry.is_cleaned(old)
    assert registry.reserve("device", new)
    assert registry.sessions["device"] is new


def test_start_failure_rolls_back_reserved_session(monkeypatch, tmp_path):
    monkeypatch.setenv("EASYADB_TOKEN", "local-test-token-123")
    app = importlib.import_module("server.app")
    app.store = DeviceStore(str(tmp_path / "start.sqlite3"))
    app.manager = DeviceManager(app.store, app.adb)
    app.live_registry = LiveRegistry()
    monkeypatch.setattr(app, "is_connected", lambda serial: True)

    class FailedStart:
        def __init__(self, serial, profile):
            self.session_id = "unstarted"
            self.finished = threading.Event()
            self.cleanup_complete = True
            self.events = queue.Queue()
        def start(self): raise RuntimeError("cannot start worker")
        def stop(self): self.finished.set()
        def join(self, timeout=20): self.finished.wait(timeout)
        def diagnostics(self): return {"stage": "start-failed"}

    monkeypatch.setattr(app, "LiveVideo", FailedStart)
    with TestClient(app.app) as client:
        device = client.post("/api/devices", headers=AUTH, json={
            "name": "Phone", "ip": "10.10.30.206", "port": 40455,
        }).json()
        app.manager._set_state(device["id"], "connected",
                               serial=device["selected_serial"], route="mesh")
        with client.websocket_connect(
            f"/api/devices/{device['id']}/m2/live",
            headers={"origin": "http://testserver"}
        ) as ws:
            ws.send_json({"token": "local-test-token-123", "profile": "baseline",
                          "player": "webrtc", "selected_serial": device["selected_serial"]})
            for _ in range(12):
                msg = ws.receive_json()
                if msg["type"] == "error":
                    assert "未能启动" in msg["message"]
                    break
                assert msg["type"] in ("starting", "diagnostic")
            else:
                pytest.fail("WebRTC worker launch error was not reported")
            # Error is sent before the asynchronous worker/peer teardown.
            # Wait for the server close frame before asserting the slot freed.
            with pytest.raises(WebSocketDisconnect):
                ws.receive_json()
        assert not app.live_registry.sessions


def test_unverified_cleanup_fails_closed_and_never_reports_ended(monkeypatch, tmp_path):
    monkeypatch.setenv("EASYADB_TOKEN", "local-test-token-123")
    app = importlib.import_module("server.app")
    app.store = DeviceStore(str(tmp_path / "dirty.sqlite3"))
    app.manager = DeviceManager(app.store, app.adb)
    app.live_registry = LiveRegistry()
    monkeypatch.setattr(app, "is_connected", lambda serial: True)

    class DirtyStream:
        def __init__(self, serial, profile):
            self.session_id = "dirty-session"
            self.finished = threading.Event()
            self.cleanup_complete = False
            self.events = queue.Queue()
        def start(self):
            self.events.put(("init", {
                "width": 720, "height": 1600, "mime": 'video/mp4; codecs="avc1.640028"',
                "control_available": True,
            }))
        def diagnostics(self): return {"stage": "test"}
        def stop(self): self.finished.set()
        def join(self, timeout=20): pass

    monkeypatch.setattr(app, "LiveVideo", DirtyStream)
    with TestClient(app.app) as client:
        device = client.post("/api/devices", headers=AUTH, json={
            "name": "Phone", "ip": "10.10.30.206", "port": 40455,
        }).json()
        app.manager._set_state(device["id"], "connected",
                               serial=device["selected_serial"], route="mesh")
        path = f"/api/devices/{device['id']}/m2/live"
        auth = {"token": "local-test-token-123", "profile": "baseline",
                "player": "webrtc", "selected_serial": device["selected_serial"]}
        with client.websocket_connect(path, headers={"origin": "http://testserver"}) as ws:
            ws.send_json(auth)
            for _ in range(8):
                msg = ws.receive_json()
                if msg["type"] == "init": break
            else: pytest.fail("missing init")
            ws.send_text("stop")
            seen = []
            for _ in range(8):
                msg = ws.receive_json()
                seen.append(msg["type"])
                if msg["type"] == "error":
                    assert "尚未完全清理" in msg["message"]
                    break
            assert "ended" not in seen
        assert app.live_registry.sessions[device["id"]].cleanup_complete is False
        with client.websocket_connect(path, headers={"origin": "http://testserver"}) as other:
            other.send_json(auth)
            msg = other.receive_json()
            assert msg["type"] == "error" and "已有实时投屏" in msg["message"]
