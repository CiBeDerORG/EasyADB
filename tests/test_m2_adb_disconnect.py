"""M2-04-C: event-driven disconnect confirmation, no ADB polling/reconnect."""
import asyncio
import importlib
import queue
import socket
import threading

import pytest
from fastapi import HTTPException, WebSocketDisconnect
from fastapi.testclient import TestClient

from server.devices import DeviceManager
from server.store import DeviceStore
from server.m2_live import LiveRegistry, StreamStopped, VideoProbeError, _socket_read

AUTH = {"X-EasyADB-Token": "local-test-token-123"}


def setup(monkeypatch, tmp_path):
    monkeypatch.setenv("EASYADB_TOKEN", "local-test-token-123")
    mod = importlib.import_module("server.app")
    mod.store = DeviceStore(str(tmp_path / "adb-loss.sqlite3"))
    mod.manager = DeviceManager(mod.store, mod.adb)
    mod.live_registry = LiveRegistry()
    client = TestClient(mod.app)
    return mod, client


def add_connected(mod, client):
    device = client.post("/api/devices", headers=AUTH, json={
        "name": "Phone", "ip": "10.10.30.206", "port": 40455,
    }).json()
    serial = device["selected_serial"]
    mod.manager._set_state(device["id"], "connected", serial=serial, route="mesh")
    return device, serial


def test_socket_eof_is_a_transport_error_but_manual_stop_is_not():
    local, remote = socket.socketpair()
    try:
        remote.close()
        with pytest.raises(VideoProbeError, match="socket 已关闭"):
            _socket_read(local, 12, threading.Event(), timeout=0.03)
        stopped = threading.Event()
        stopped.set()
        with pytest.raises(StreamStopped):
            _socket_read(local, 12, stopped, timeout=0.03)
    finally:
        local.close()


def test_existing_adb_child_exit_aborts_a_quiet_socket_without_adb_polling():
    class ExitedChild:
        def __init__(self): self.calls = 0
        def poll(self):
            self.calls += 1
            return 1
    local, remote = socket.socketpair()
    child = ExitedChild()
    try:
        # The peer is still open, so recv() alone would wait forever.
        with pytest.raises(VideoProbeError, match="ADB/scrcpy 视频进程已退出"):
            _socket_read(local, 12, threading.Event(), timeout=0.03, adb_proc=child)
        assert child.calls == 1
        stopped = threading.Event()
        stopped.set()
        with pytest.raises(StreamStopped):
            _socket_read(local, 12, stopped, timeout=0.03, adb_proc=child)
        assert child.calls == 1  # deliberate stop wins, no false disconnect
    finally:
        local.close()
        remote.close()


def test_confirmed_adb_loss_updates_only_current_selected_serial(monkeypatch, tmp_path):
    mod, client = setup(monkeypatch, tmp_path)
    checks = []
    monkeypatch.setattr(mod, "is_connected", lambda serial: checks.append(serial) or False)
    with client:
        device, serial = add_connected(mod, client)
        assert asyncio.run(mod.confirm_live_adb_loss(device["id"], serial)) is True
        snapshot = mod.manager.snapshot(mod.store.get(device["id"]))
        assert snapshot["status"] == "disconnected"
        assert snapshot["active_serial"] is None
        assert snapshot["selected_serial"] == serial  # no automatic IP switching
        assert checks == [serial]
        # A stale failure must not overwrite a later manual connection change.
        mod.manager.clear(device["id"])
        assert asyncio.run(mod.confirm_live_adb_loss(device["id"], serial)) is True
        assert mod.manager.snapshot(mod.store.get(device["id"]))["status"] == "idle"


def test_encoder_failure_while_adb_online_does_not_falsely_mark_offline(monkeypatch, tmp_path):
    mod, client = setup(monkeypatch, tmp_path)
    checks = []
    monkeypatch.setattr(mod, "is_connected", lambda serial: checks.append(serial) or True)
    with client:
        device, serial = add_connected(mod, client)
        assert asyncio.run(mod.confirm_live_adb_loss(device["id"], serial)) is False
        assert mod.manager.serial_for(mod.store.get(device["id"])) == serial
        assert checks == [serial]


def test_unknown_adb_status_does_not_assert_confirmed_disconnect(monkeypatch, tmp_path):
    mod, client = setup(monkeypatch, tmp_path)
    def unknown(serial):
        raise HTTPException(504, "ADB timeout")
    monkeypatch.setattr(mod, "is_connected", unknown)
    with client:
        device, serial = add_connected(mod, client)
        assert asyncio.run(mod.confirm_live_adb_loss(device["id"], serial)) is False
        assert mod.manager.serial_for(mod.store.get(device["id"])) == serial


@pytest.mark.parametrize("disconnect", [True, False])
def test_running_media_error_checks_adb_once_and_never_reconnects(monkeypatch, tmp_path, disconnect):
    mod, client = setup(monkeypatch, tmp_path)
    calls = []
    def get_state(serial):
        calls.append(serial)
        return len(calls) == 1 or not disconnect
    monkeypatch.setattr(mod, "is_connected", get_state)
    made = []

    class FakeStream:
        def __init__(self, serial, profile):
            self.serial, self.profile = serial, profile
            self.session_id = "loss-session"
            self.finished = threading.Event()
            self.cleanup_complete = False
            self.events = queue.Queue()
            made.append(self)
        def start(self):
            self.events.put(("init", {
                "width": 720, "height": 1600,
                "mime": 'video/mp4; codecs="avc1.640028"',
                "control_available": True,
            }))
            self.events.put(("error", "手机端视频 socket 已关闭"))
        def diagnostics(self): return {"stage": "test"}
        def stop(self):
            self.cleanup_complete = True
            self.finished.set()
        def join(self, timeout=20): self.finished.wait(timeout)

    monkeypatch.setattr(mod, "LiveVideo", FakeStream)
    with client:
        device, serial = add_connected(mod, client)
        path = f"/api/devices/{device['id']}/m2/live"
        with client.websocket_connect(path, headers={"origin": "http://testserver"}) as ws:
            ws.send_json({"token": "local-test-token-123", "profile": "baseline",
                          "player": "mse", "selected_serial": serial})
            result = None
            for _ in range(12):
                msg = ws.receive_json()
                if msg["type"] == "error":
                    result = msg
                    break
                assert msg["type"] in ("starting", "diagnostic", "init")
            assert result is not None
            assert result["session_id"] == made[0].session_id
            if disconnect:
                assert result["code"] == "adb_disconnected"
                assert "手动重新连接" in result["message"]
            else:
                assert result["code"] == "stream_failed"
                assert "socket 已关闭" in result["message"]
            # The error event is sent BEFORE the WS handler's finally block.
            # Wait for its server close frame, emitted AFTER cleanup/release,
            # rather than racing the handler by exiting the client context.
            with pytest.raises(WebSocketDisconnect):
                ws.receive_json()
        assert made[0].finished.is_set() and made[0].cleanup_complete
        assert device["id"] not in mod.live_registry.sessions
        assert len(calls) == 2  # one at explicit start, one only ON failure
        snapshot = mod.manager.snapshot(mod.store.get(device["id"]))
        assert snapshot["status"] == ("disconnected" if disconnect else "connected")


def test_manual_stop_never_triggers_an_extra_adb_connection_check(monkeypatch, tmp_path):
    mod, client = setup(monkeypatch, tmp_path)
    calls = []
    monkeypatch.setattr(mod, "is_connected", lambda serial: calls.append(serial) or True)

    class QuietStream:
        def __init__(self, serial, profile):
            self.session_id = "quiet-manual-session"
            self.finished = threading.Event()
            self.cleanup_complete = False
            self.events = queue.Queue()
        def start(self):
            self.events.put(("init", {
                "width": 720, "height": 1600,
                "mime": 'video/mp4; codecs="avc1.640028"',
                "control_available": True,
            }))
        def diagnostics(self): return {"stage": "quiet"}
        def stop(self):
            self.cleanup_complete = True
            self.finished.set()
        def join(self, timeout=20): self.finished.wait(timeout)

    monkeypatch.setattr(mod, "LiveVideo", QuietStream)
    with client:
        device, serial = add_connected(mod, client)
        with client.websocket_connect(
            f"/api/devices/{device['id']}/m2/live",
            headers={"origin": "http://testserver"}
        ) as ws:
            ws.send_json({"token": "local-test-token-123", "profile": "baseline",
                          "player": "mse", "selected_serial": serial})
            for _ in range(12):
                if ws.receive_json()["type"] == "init":
                    break
            else:
                pytest.fail("missing init")
            ws.send_text("stop")
            for _ in range(12):
                msg = ws.receive_json()
                if msg["type"] == "ended":
                    assert msg["cleanup_complete"] is True
                    break
            else:
                pytest.fail("missing manual cleanup acknowledgment")
        assert calls == [serial]  # only the explicit initial start check
        assert mod.manager.serial_for(mod.store.get(device["id"])) == serial
        assert device["id"] not in mod.live_registry.sessions



def test_browser_refreshes_saved_status_only_for_confirmed_adb_loss():
    from pathlib import Path
    root = Path(__file__).resolve().parents[1] / "web"
    page = (root / "index.html").read_text()
    multi = (root / "m2-multi.js").read_text()
    assert "onDeviceDisconnected:()=>load(true)" in page
    assert "if(m.code==='adb_disconnected')" in multi
    assert "this.onDeviceDisconnected?.(card.id)" in multi
    assert "/connect" not in multi  # no auto-connect API call in the per-card controller

