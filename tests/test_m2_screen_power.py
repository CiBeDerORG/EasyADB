"""M2 physical-panel off, early WAKEUP and strict single-session control."""
import importlib
import queue
import socket
import threading
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from server.devices import DeviceManager
from server.m2_live import LiveRegistry, LiveVideo
from server.m2_touch import InvalidTouch
from server.store import DeviceStore

AUTH = {"X-EasyADB-Token": "local-test-token-123"}
ORIGIN = {"origin": "http://testserver"}


def test_scrcpy_v501_display_power_packets_and_startup_wake_cancel(monkeypatch):
    import server.m2_live as live_module
    adb_calls = []
    monkeypatch.setattr(live_module, "_run_adb", lambda serial, *args, **kwargs:
                        adb_calls.append((serial, args)))
    stream = LiveVideo("only-device:5555", "baseline", screen_off=True)
    assert stream.screen_off
    # Wake is permitted before the control socket/video metadata becomes ready.
    stream.wake_display()
    assert stream._wake_requested
    assert adb_calls == [("only-device:5555", ("shell", "input", "keyevent", "224"))]
    assert stream.set_display_power(False, skip_if_wake=True) is False

    left, right = socket.socketpair()
    right.settimeout(1)
    try:
        stream.control_sock = left
        stream.touch_size = (720, 1600)
        assert stream.set_display_power(True) is True
        assert right.recv(2) == bytes((10, 1))
        stream.wake_display()
        assert right.recv(2) == bytes((10, 1))
        assert adb_calls[-1][0] == "only-device:5555"
        assert stream.set_display_power(False) is True
        assert right.recv(2) == bytes((10, 0))
        with pytest.raises(InvalidTouch):
            stream.set_display_power("off")
        stream.stop()
        with pytest.raises(InvalidTouch):
            stream.wake_display()
    finally:
        left.close()
        right.close()
    # Never send a main-physical-display power command for virtual/other sources.
    virtual = LiveVideo("only-device:5555", "baseline", screen_off=True,
                        display_source={"mode": "new"})
    assert not virtual.screen_off
    with pytest.raises(InvalidTouch):
        virtual.wake_display()


def test_ws_screen_off_is_boolean_and_wake_requires_same_session(monkeypatch, tmp_path):
    monkeypatch.setenv("EASYADB_TOKEN", "local-test-token-123")
    mod = importlib.import_module("server.app")
    mod.store = DeviceStore(str(tmp_path / "screen.sqlite3"))
    mod.manager = DeviceManager(mod.store, mod.adb)
    mod.live_registry = LiveRegistry()
    monkeypatch.setattr(mod, "is_connected", lambda serial: True)
    created = []

    class FakeStream:
        def __init__(self, serial, profile, screen_off=False):
            self.serial, self.profile, self.screen_off = serial, profile, screen_off
            self.session_id = "wake-" + str(len(created))
            self.events = queue.Queue()
            self.finished = threading.Event()
            self.cleanup_complete = True
            self.stop_event = threading.Event()
            self.woken = 0
            created.append(self)
        def start(self): pass
        def wake_display(self): self.woken += 1
        def stop(self): self.stop_event.set(); self.finished.set()
        def join(self, timeout=20): pass
        def diagnostics(self): return {"stage": "waiting"}

    monkeypatch.setattr(mod, "LiveVideo", FakeStream)
    with TestClient(mod.app) as client:
        d = client.post("/api/devices", headers=AUTH,
                        json={"name": "Mate30", "ip": "10.10.10.2", "port": 5555}).json()
        mod.manager._set_state(d["id"], "connected", serial=d["selected_serial"], route="mesh")
        path = "/api/devices/" + d["id"] + "/m2/live"
        initial = {"token": "local-test-token-123", "player": "mse", "profile": "baseline",
                   "selected_serial": d["selected_serial"]}
        # Reject malformed settings before any stream or additional ADB work.
        with client.websocket_connect(path, headers=ORIGIN) as ws:
            ws.send_json({**initial, "screen_off": "true"})
            assert ws.receive_json()["type"] == "error"
        with client.websocket_connect(path, headers=ORIGIN) as ws:
            ws.send_json({**initial, "screen_off": True})
            first = ws.receive_json()
            assert first["type"] == "starting"
            assert created[0].screen_off is True
            ws.send_json({"type": "wake", "session_id": "stale"})
            # A stale/cross-session command terminates this WS; cannot wake the phone.
            for _ in range(5):
                try:
                    ws.receive_json()
                except Exception:
                    break
            assert created[0].woken == 0
        with client.websocket_connect(path, headers=ORIGIN) as ws:
            ws.send_json(initial)
            starting = ws.receive_json()
            assert starting["type"] == "starting"
            assert created[-1].screen_off is False
            # Wake works before init/control_enable and cannot inject arbitrary ADB arguments.
            ws.send_json({"type": "wake", "session_id": starting["session_id"]})
            seen = None
            for _ in range(8):
                msg = ws.receive_json()
                if msg["type"] == "wake_accepted":
                    seen = msg
                    break
            assert seen is not None
            assert created[-1].woken == 1
            ws.send_text("stop")
            for _ in range(8):
                if ws.receive_json()["type"] == "ended":
                    break
