"""V2: WebRTC-only app and WebSocket compatibility tests."""
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
    live._phase_set("等待 WebRTC 关键帧")
    live._record_phone_packet()
    after = live.diagnostics()
    assert after["stage"] == "等待 WebRTC 关键帧"
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



def test_page_uses_webrtc_only_and_reserves_webcodecs():
    root = Path(__file__).resolve().parents[1]
    html = (root / "web" / "index.html").read_text()
    multi = (root / "web" / "m2-multi.js").read_text()
    player = (root / "web" / "m2-webrtc.js").read_text()
    assert '<script src="/m2-webrtc.js"></script>' in html
    assert '<script src="/m2-player.js"></script>' not in html
    assert "root.EasyADBWebRTC.create(video" in "".join(multi.split())
    assert "EasyADBPlayers" not in multi
    assert "new RTCPeerConnection(" in player
    assert "new WebSocket(" in multi
    assert "webcodecs" in multi
    assert "WebCodecs 尚未实现" not in player


def test_webrtc_script_is_served_as_javascript_without_auth(monkeypatch, tmp_path):
    monkeypatch.setenv("EASYADB_TOKEN", "local-test-token-123")
    mod = importlib.import_module("server.app")
    mod.store = DeviceStore(str(tmp_path / "db.sqlite3"))
    mod.manager = DeviceManager(mod.store, mod.adb)
    with TestClient(mod.app) as client:
        response = client.get("/m2-webrtc.js")
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("application/javascript")
        assert "EasyADBWebRTC" in response.text
        assert response.headers["cache-control"] == "no-store"


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


def test_manual_device_ip_switch_requires_verified_session_cleanup(monkeypatch, tmp_path):
    monkeypatch.setenv("EASYADB_TOKEN", "local-test-token-123")
    mod = importlib.import_module("server.app")
    mod.store = DeviceStore(str(tmp_path / "devices.sqlite3"))
    mod.manager = DeviceManager(mod.store, mod.adb)
    mod.live_registry = LiveRegistry()

    class DummyStream:
        def __init__(self):
            self.stopped = False
            self.finished = threading.Event()
            self.cleanup_complete = False
            self.peer_cleanup_complete = False
        def stop(self): self.stopped = True
    running = DummyStream()
    with TestClient(mod.app) as client:
        assert client.post("/api/groups", headers=AUTH, json={
            "name": "Home", "ip_prefix": "192.168.1.*"
        }).status_code == 201
        device = client.post("/api/devices", headers=AUTH, json={
            "name": "Phone", "ip": "10.10.30.206", "port": 40455, "group_name": "Home"
        }).json()
        assert mod.live_registry.reserve(device["id"], running)
        result = client.put(f"/api/devices/{device['id']}/route", headers=AUTH,
                            json={"route": "lan"})
        assert result.status_code == 409
        assert mod.store.get(device["id"])["selected_route"] == "mesh"
        assert not running.stopped
        assert mod.live_registry.sessions[device["id"]] is running
        running.finished.set()
        running.cleanup_complete = running.peer_cleanup_complete = True
        result = client.put(f"/api/devices/{device['id']}/route", headers=AUTH,
                            json={"route": "lan"})
        assert result.status_code == 200
        assert result.json()["selected_serial"] == "192.168.1.206:40455"
        assert running.stopped
        mod.live_registry.release(device["id"], running)





