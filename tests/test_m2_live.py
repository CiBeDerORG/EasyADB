"""V2 WebRTC-only live session, browser assets and one-shot authentication."""
import importlib
import queue
import socket
import threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from server.devices import DeviceManager
from server.store import DeviceStore
from server.m2_live import LiveRegistry, LiveVideo, StreamStopped, _socket_read

AUTH = {"X-EasyADB-Token": "local-test-token-123"}


def test_live_diagnostics_are_session_local_and_need_no_adb(tmp_path):
    live = LiveVideo("selected-only:5555", "baseline", server_file=tmp_path / "absent.jar")
    before = live.diagnostics()
    assert before["stage"] == "等待启动"
    assert before["phone_packets"] == 0 and before["phone_idle_ms"] is None
    assert before["init_ready_ms"] is None
    live._phase_set("等待 WebRTC H.264 关键帧")
    live._record_phone_packet()
    after = live.diagnostics()
    assert after["stage"] == "等待 WebRTC H.264 关键帧"
    assert after["phone_packets"] == 1
    assert 0 <= after["phone_idle_ms"] < 1000
    assert after["elapsed_ms"] >= before["elapsed_ms"]



def test_live_registry_reserves_exclusively_and_stops_only_the_correct_session():
    registry = LiveRegistry()
    class Dummy:
        def __init__(self): self.stopped = False; self.joined = False
        def stop(self): self.stopped = True
        def join(self, timeout): self.joined = True
    one, two = Dummy(), Dummy()
    assert registry.reserve("device-A", one)
    assert not registry.reserve("device-A", two)
    registry.release("device-A", two)
    assert not registry.reserve("device-A", two)
    registry.stop_for("device-A")
    assert one.stopped and not two.stopped
    registry.release("device-A", one)
    assert registry.reserve("device-A", two)
    registry.stop_all()
    assert two.stopped and two.joined


def test_finished_old_worker_may_be_retired_but_active_worker_stays_exclusive():
    registry = LiveRegistry()
    old = LiveVideo("selected-only:5555", "baseline")
    new = LiveVideo("selected-only:5555", "baseline")
    assert old.session_id != new.session_id
    assert registry.reserve("device-A", old)
    assert not registry.reserve("device-A", new)
    old.finished.set()
    # A terminated worker is not reusable until all owned resources are clean.
    assert not registry.reserve("device-A", new)
    old.cleanup_complete = True
    assert registry.reserve("device-A", new)
    registry.release("device-A", old)
    assert registry.sessions["device-A"] is new
    registry.release("device-A", new)


def test_m2_01_manual_stop_waits_for_server_cleanup_before_new_start(monkeypatch, tmp_path):
    monkeypatch.setenv("EASYADB_TOKEN", "local-test-token-123")
    mod = importlib.import_module("server.app")
    mod.store = DeviceStore(str(tmp_path / "sessions.sqlite3"))
    mod.manager = DeviceManager(mod.store, mod.adb)
    mod.live_registry = LiveRegistry()
    monkeypatch.setattr(mod, "is_connected", lambda serial: True)
    created = []

    class FakeStream:
        def __init__(self, serial, profile):
            self.session_id = f"test-session-{len(created)}"
            self.serial, self.profile = serial, profile
            self.finished = threading.Event()
            self.events = queue.Queue()
            self.started = False
            self.start_event = threading.Event()
            self.joined = False
            created.append(self)

        def start(self): self.started = True; self.start_event.set()
        def stop(self): self.finished.set()
        def join(self, timeout=20):
            self.joined = True
            self.finished.wait(timeout)
        def diagnostics(self): return {"stage": "等待媒体流"}

    monkeypatch.setattr(mod, "LiveVideo", FakeStream)
    with TestClient(mod.app) as client:
        d = client.post("/api/devices", headers=AUTH, json={
            "name": "Phone", "ip": "10.10.30.206", "port": 40455,
        }).json()
        mod.manager._set_state(d["id"], "connected",
                               serial=d["selected_serial"], route="mesh")
        path = f"/api/devices/{d['id']}/m2/live"
        origin = {"origin": "http://testserver"}
        auth = {"token": "local-test-token-123", "player": "webrtc",
                "profile": "baseline", "selected_serial": d["selected_serial"]}
        with client.websocket_connect(path, headers=origin) as ws:
            ws.send_json(auth)
            starting = ws.receive_json()
            assert starting["type"] == "starting"
            assert starting["session_id"] == created[0].session_id
            assert created[0].start_event.wait(2), "WebRTC starts only after SDP answer"
            # A second browser cannot silently replace the active session.
            with client.websocket_connect(path, headers=origin) as other:
                other.send_json(auth)
                assert "已有实时投屏" in other.receive_json()["message"]
            ws.send_text("stop")
            lifecycle = []
            for _ in range(8):
                message = ws.receive_json()
                lifecycle.append(message["type"])
                if message["type"] == "ended":
                    assert message["cleanup_complete"] is True
                    assert message["reason"] == "manual"
                    assert message["session_id"] == starting["session_id"]
                    break
            assert "stopping" in lifecycle and lifecycle[-1] == "ended"
            assert created[0].joined
            assert d["id"] not in mod.live_registry.sessions
        # Restart becomes possible only after the first worker was released.
        with client.websocket_connect(path, headers=origin) as again:
            again.send_json(auth)
            assert again.receive_json()["type"] == "starting"
            assert created[2].start_event.wait(2)
            again.send_text("stop")
            for _ in range(8):
                if again.receive_json()["type"] == "ended":
                    break
            else:
                pytest.fail("second session did not acknowledge cleanup")
        assert not created[1].started and not created[1].joined  # rejected candidate
        assert len(created) == 3
        assert created[2].started and created[2].joined
        assert d["id"] not in mod.live_registry.sessions


def test_socket_read_is_stoppable_without_a_background_reconnect():
    local, remote = socket.socketpair()
    stop = threading.Event()
    stop.set()
    try:
        with pytest.raises(StreamStopped):
            _socket_read(local, 12, stop)
    finally:
        local.close()
        remote.close()



def test_v2_browser_has_only_webrtc_and_no_mse_asset():
    root = Path(__file__).resolve().parents[1]
    html = (root / "web" / "index.html").read_text()
    multi = (root / "web" / "m2-multi.js").read_text()
    rtc = (root / "web" / "m2-webrtc.js").read_text()
    assert '<script src="/m2-webrtc.js"></script>' in html
    assert "/m2-player.js" not in html
    assert not (root / "web" / "m2-player.js").exists()
    assert "root.EasyADBWebRTC.create" in multi
    assert "EasyADBPlayers" not in multi
    assert "WebRTCPlayer" in rtc
    assert "m.type==='diagnostic'" in multi and "m.type==='ended'" in multi
    assert "root.EasyADBTraffic.Meter" in multi
    assert "root.EasyADBTouch.create(video" in multi
    assert "window.addEventListener('beforeunload'" in html
    assert "multiView.closeAll()" in html


def test_retired_mse_asset_is_not_served(monkeypatch):
    monkeypatch.setenv("EASYADB_TOKEN", "local-test-token-123")
    mod = importlib.import_module("server.app")
    with TestClient(mod.app) as client:
        assert client.get("/m2-player.js").status_code == 404


def test_web_rtc_adapter_route_matches_page_script_and_is_not_cached(monkeypatch, tmp_path):
    monkeypatch.setenv("EASYADB_TOKEN", "local-test-token-123")
    mod = importlib.import_module("server.app")
    with TestClient(mod.app) as client:
        page = client.get("/")
        assert page.status_code == 200
        assert '<script src="/m2-webrtc.js"></script>' in page.text
        response = client.get("/m2-webrtc.js")
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("application/javascript")
        assert response.headers["cache-control"] == "no-store"
        assert "EasyADBWebRTC" in response.text
        assert "RTCPeerConnection" in response.text


def test_session_traffic_meter_script_is_served_without_auth(monkeypatch, tmp_path):
    monkeypatch.setenv("EASYADB_TOKEN", "local-test-token-123")
    mod = importlib.import_module("server.app")
    with TestClient(mod.app) as client:
        response = client.get("/m2-traffic.js")
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("application/javascript")
        assert "EasyADBTraffic" in response.text
        assert response.headers["cache-control"] == "no-store"


def test_websocket_fails_closed_for_reserved_player_before_opening_adb(monkeypatch, tmp_path):
    monkeypatch.setenv("EASYADB_TOKEN", "local-test-token-123")
    mod = importlib.import_module("server.app")
    mod.store = DeviceStore(str(tmp_path / "db.sqlite3"))
    mod.manager = DeviceManager(mod.store, mod.adb)
    mod.live_registry = LiveRegistry()
    monkeypatch.setattr(mod, "is_connected", lambda serial: (_ for _ in ()).throw(
        AssertionError("must reject unfinished player before ADB")))
    with TestClient(mod.app) as client:
        d = client.post("/api/devices", headers=AUTH, json={
            "name": "Phone", "ip": "10.10.30.206", "port": 40455
        }).json()
        path = f"/api/devices/{d['id']}/m2/live"
        with client.websocket_connect(path, headers={"origin": "http://testserver"}) as ws:
            ws.send_json({"token": "local-test-token-123", "profile": "baseline",
                          "selected_serial": d["selected_serial"], "player": "webcodecs"})
            response = ws.receive_json()
            assert response["type"] == "error"
            assert "WebCodecs" in response["message"]
        assert not mod.live_registry.sessions


def test_live_websocket_rejects_auth_and_stale_selected_address(monkeypatch, tmp_path):
    monkeypatch.setenv("EASYADB_TOKEN", "local-test-token-123")
    mod = importlib.import_module("server.app")
    mod.store = DeviceStore(str(tmp_path / "devices.sqlite3"))
    mod.manager = DeviceManager(mod.store, mod.adb)
    mod.live_registry = LiveRegistry()
    monkeypatch.setattr(mod, "is_connected", lambda serial: True)
    with TestClient(mod.app) as client:
        d = client.post("/api/devices", headers=AUTH, json={
            "name": "Phone", "ip": "10.10.30.206", "port": 40455
        }).json()
        path = f"/api/devices/{d['id']}/m2/live"
        headers = {"origin": "http://testserver"}
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(path, headers={"origin": "http://untrusted.invalid"}):
                pass
        with client.websocket_connect(path, headers=headers) as ws:
            ws.send_json({"token": "not-valid", "profile": "baseline",
                          "selected_serial": d["selected_serial"]})
            with pytest.raises(WebSocketDisconnect):
                ws.receive_json()
        with client.websocket_connect(path, headers=headers) as ws:
            ws.send_json({"token": "local-test-token-123", "profile": "baseline",
                          "selected_serial": d["selected_serial"]})
            assert ws.receive_json()["type"] == "error"  # not manually connected
        mod.manager._set_state(d["id"], "connected", serial=d["selected_serial"], route="mesh")
        with client.websocket_connect(path, headers=headers) as ws:
            ws.send_json({"token": "local-test-token-123", "profile": "baseline",
                          "selected_serial": "10.10.30.207:40455"})
            assert ws.receive_json()["type"] == "error"


def test_manual_device_ip_switch_interrupts_live_session(monkeypatch, tmp_path):
    monkeypatch.setenv("EASYADB_TOKEN", "local-test-token-123")
    mod = importlib.import_module("server.app")
    mod.store = DeviceStore(str(tmp_path / "devices.sqlite3"))
    mod.manager = DeviceManager(mod.store, mod.adb)
    mod.live_registry = LiveRegistry()

    class DummyStream:
        def __init__(self):
            self.stopped = False
        def stop(self): self.stopped = True
    running = DummyStream()
    with TestClient(mod.app) as client:
        device = client.post("/api/devices", headers=AUTH, json={
            "name": "Phone", "ip": "10.10.30.206", "port": 40455
        }).json()
        assert mod.live_registry.reserve(device["id"], running)
        result = client.put(f"/api/devices/{device['id']}/route", headers=AUTH,
                            json={"route": "mesh"})
        assert result.status_code == 200
        assert running.stopped
        mod.live_registry.release(device["id"], running)


