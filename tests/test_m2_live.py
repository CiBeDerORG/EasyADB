"""M2-00-E: fMP4 init, no-WebCodecs UI, one-shot WebSocket authorization."""
import importlib
import queue
import socket
import struct
import subprocess
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from server.devices import DeviceManager
from server.store import DeviceStore
from server.m2_live import (
    LiveRegistry, LiveVideo, StreamStopped, _socket_read, parse_init_segments,
)

AUTH = {"X-EasyADB-Token": "local-test-token-123"}


def box(kind, payload):
    return struct.pack(">I4s", len(payload) + 8, kind) + payload


def test_h264_mp4_init_segment_mime_and_incremental_fragments():
    ftyp = box(b"ftyp", b"isom\x00\x00\x02\x00isom")
    avcc = box(b"avcC", b"\x01\x64\x00\x28\xff\xe1")
    moov = box(b"moov", box(b"trak", avcc))
    fragment = box(b"moof", box(b"traf", b"")) + box(b"mdat", b"\0\0\0\1")
    assert parse_init_segments(ftyp[:7]) is None
    assert parse_init_segments(ftyp + moov[:6]) is None
    result = parse_init_segments(ftyp + moov + fragment)
    assert result is not None
    size, init, mime = result
    assert init == ftyp + moov
    assert size == len(ftyp + moov)
    assert mime == 'video/mp4; codecs="avc1.640028"'
    assert (ftyp + moov + fragment)[size:] == fragment


@pytest.mark.parametrize("data", [
    box(b"free", b"abc") + box(b"moov", box(b"avcC", b"\x01\x64\x00\x28")),
    box(b"ftyp", b"isom") + box(b"moov", b"missing avcc"),
    struct.pack(">I4s", 0xFFFFFFFF, b"ftyp"),
    box(b"ftyp", b"isom") + box(b"moov", box(b"avcC", b"\x02\x64\x00\x28")),
])
def test_reject_invalid_or_oversize_mp4_init(data):
    with pytest.raises(Exception):
        parse_init_segments(data)


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


def test_http_nas_player_has_only_mse_not_webcodecs():
    html = (Path(__file__).resolve().parents[1] / "web" / "index.html").read_text()
    assert 'id="liveVideo"' in html and 'id="liveStart"' in html
    assert 'id="liveStop"' in html and "new MediaSource()" in html
    assert "MediaSource.isTypeSupported(mime)" in html
    assert "new WebSocket(" in html and "ws.send(JSON.stringify({token:" in html
    assert "new VideoDecoder" not in html
    assert "window.addEventListener('beforeunload',stopLive)" in html


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
