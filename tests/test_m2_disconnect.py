"""M2-04-B: active-browser receipts, half-open timeouts and WS shutdown."""
import asyncio
import importlib
import queue
import threading

import pytest
from fastapi import WebSocket
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from server.devices import DeviceManager
from server.store import DeviceStore
from server.m2_live import LiveRegistry

AUTH = {"X-EasyADB-Token": "local-test-token-123"}


def setup_live(monkeypatch, tmp_path):
    monkeypatch.setenv("EASYADB_TOKEN", "local-test-token-123")
    mod = importlib.import_module("server.app")
    mod.store = DeviceStore(str(tmp_path / "heartbeat.sqlite3"))
    mod.manager = DeviceManager(mod.store, mod.adb)
    mod.live_registry = LiveRegistry()
    monkeypatch.setattr(mod, "is_connected", lambda serial: True)
    monkeypatch.setattr(mod, "LIVE_HEARTBEAT_CHECK_INTERVAL", 0.02)
    made = []

    class FakeStream:
        def __init__(self, serial, profile):
            self.serial, self.profile = serial, profile
            self.session_id = f"heartbeat-session-{len(made)}"
            self.finished = threading.Event()
            self.cleanup_complete = False
            self.events = queue.Queue()
            self.stopped = 0
            made.append(self)

        def start(self):
            self.events.put(("init", {
                "width": 720, "height": 1600,
                "mime": 'video/mp4; codecs="avc1.640028"',
                "control_available": True,
            }))

        def diagnostics(self): return {"stage": "test"}
        def stop(self):
            self.stopped += 1
            self.cleanup_complete = True
            self.finished.set()
        def join(self, timeout=20): self.finished.wait(timeout)

    monkeypatch.setattr(mod, "LiveVideo", FakeStream)
    client = TestClient(mod.app)
    return mod, made, client


def register_device(mod, client):
    device = client.post("/api/devices", headers=AUTH, json={
        "name": "Phone", "ip": "10.10.30.206", "port": 40455,
    }).json()
    mod.manager._set_state(device["id"], "connected",
                           serial=device["selected_serial"], route="mesh")
    path = f"/api/devices/{device['id']}/m2/live"
    auth = {"token": "local-test-token-123", "player": "mse",
            "profile": "baseline", "selected_serial": device["selected_serial"]}
    return device, path, auth


def next_kind(ws, kind, limit=12):
    for _ in range(limit):
        msg = ws.receive_json()
        if msg["type"] == kind:
            return msg
        assert msg["type"] in ("starting", "init", "diagnostic", "stopping")
    pytest.fail(f"missing {kind}")


def test_unresponsive_half_open_browser_releases_its_session(monkeypatch, tmp_path):
    mod, made, client = setup_live(monkeypatch, tmp_path)
    monkeypatch.setattr(mod, "LIVE_HEARTBEAT_TIMEOUT", 0.12)
    with client:
        device, path, auth = register_device(mod, client)
        with client.websocket_connect(path, headers={"origin": "http://testserver"}) as ws:
            ws.send_json(auth)
            assert next_kind(ws, "starting")["session_id"] == made[0].session_id
            # Deliberately ignore diagnostic receipts; no text/control input.
            with pytest.raises(WebSocketDisconnect):
                for _ in range(12):
                    ws.receive_json()
        assert made[0].finished.is_set()
        assert made[0].cleanup_complete
        assert device["id"] not in mod.live_registry.sessions


def test_diagnostic_receipts_keep_a_quiet_screen_alive_then_manual_stop(monkeypatch, tmp_path):
    mod, made, client = setup_live(monkeypatch, tmp_path)
    monkeypatch.setattr(mod, "LIVE_HEARTBEAT_TIMEOUT", 2.5)
    with client:
        device, path, auth = register_device(mod, client)
        with client.websocket_connect(path, headers={"origin": "http://testserver"}) as ws:
            ws.send_json(auth)
            sid = next_kind(ws, "starting")["session_id"]
            receipts = 0
            # Diagnostics are every ~1 second; keep session active > timeout.
            while receipts < 4:
                msg = ws.receive_json()
                if msg["type"] == "diagnostic":
                    assert msg["session_id"] == sid
                    ws.send_json({"type": "heartbeat", "session_id": sid})
                    receipts += 1
                else:
                    assert msg["type"] == "init"
            assert not made[0].finished.is_set()
            ws.send_text("stop")
            assert next_kind(ws, "ended")["cleanup_complete"] is True
        assert device["id"] not in mod.live_registry.sessions


def test_old_or_malformed_heartbeat_cannot_keep_another_session_alive(monkeypatch, tmp_path):
    mod, made, client = setup_live(monkeypatch, tmp_path)
    with client:
        device, path, auth = register_device(mod, client)
        with client.websocket_connect(path, headers={"origin": "http://testserver"}) as ws:
            ws.send_json(auth)
            next_kind(ws, "starting")
            ws.send_json({"type": "heartbeat", "session_id": "stale-session"})
            with pytest.raises(WebSocketDisconnect):
                for _ in range(12):
                    ws.receive_json()
        assert made[0].finished.is_set()
        assert device["id"] not in mod.live_registry.sessions


def test_slow_video_websocket_write_does_not_pin_the_worker(monkeypatch, tmp_path):
    mod, made, client = setup_live(monkeypatch, tmp_path)
    monkeypatch.setattr(mod, "LIVE_HEARTBEAT_TIMEOUT", 10)
    monkeypatch.setattr(mod, "LIVE_WS_SEND_TIMEOUT", 0.08)

    def start_with_video(self):
        self.events.put(("init", {
            "width": 720, "height": 1600,
            "mime": 'video/mp4; codecs="avc1.640028"',
            "control_available": True,
        }))
        self.events.put(("bytes", b"test-mp4"))

    monkeypatch.setattr(mod.LiveVideo, "start", start_with_video)
    original = WebSocket.send_bytes

    async def stalled(self, data):
        if data == b"test-mp4":
            await asyncio.sleep(2)
        else:
            await original(self, data)

    monkeypatch.setattr(WebSocket, "send_bytes", stalled)
    with client:
        device, path, auth = register_device(mod, client)
        with client.websocket_connect(path, headers={"origin": "http://testserver"}) as ws:
            ws.send_json(auth)
            next_kind(ws, "starting")
            with pytest.raises(WebSocketDisconnect):
                for _ in range(12):
                    ws.receive_json()
        assert made[0].finished.is_set()
        assert device["id"] not in mod.live_registry.sessions


def test_page_replies_to_existing_diagnostics_without_independent_timer():
    from pathlib import Path
    page = (Path(__file__).resolve().parents[1] / "web" / "index.html").read_text()
    assert "type:'heartbeat',session_id:liveSessionId" in page
    assert "window.addEventListener('pagehide',stopLive)" in page
    assert "window.addEventListener('offline'" in page
    assert "setInterval(" not in page
