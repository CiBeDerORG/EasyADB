"""M2-00 transport: real v5 packet parser and bounded cleanup (no device/network)."""
import importlib
import socket
import struct
import subprocess
import time

import pytest
from fastapi.testclient import TestClient

from server.devices import DeviceManager
from server.store import DeviceStore
from server import m2_video_probe as video

AUTH = {"X-EasyADB-Token": "local-test-token-123"}


def sample_packets(frames=3, codec=b"h264"):
    data = b"\0" + b"Test Android".ljust(64, b"\0") + codec
    data += struct.pack(">III", 0x80000000, 1440, 3200)
    # H.264 codec config and 3 media packets with key/PTS flags.
    data += struct.pack(">QI", 1 << 62, 5) + b"\0\0\0\1g"
    for i in range(frames):
        pts = (i + 1) * 33333
        flags = (1 << 61) if i == 0 else 0
        data += struct.pack(">QI", flags | pts, 5) + b"\0\0\0\1e"
    return data


def sock_with_data(data):
    client, peer = socket.socketpair()
    peer.sendall(data)
    peer.close()
    return client


def test_scrcpy_v5_1_frame_parser_receives_actual_media_packets():
    with sock_with_data(sample_packets()) as sock:
        result = video.read_scrcpy_sample(sock, time.monotonic() + 2)
    assert result["device_name"] == "Test Android"
    assert result["codec"] == "h264"
    assert (result["encoded_width"], result["encoded_height"]) == (1440, 3200)
    assert result["media_packets"] == 3
    assert result["key_frames"] == 1
    assert result["configuration_packets"] == 1
    assert result["sample_pts_span_us"] == 66666
    assert result["stream_received"] is True
    assert result["continuous_frames"] is True
    assert result["web_decode_verified"] is False
    assert not any("payload" in key or "frame_data" in key for key in result)


@pytest.mark.parametrize("data", [
    b"\1" + sample_packets()[1:],
    sample_packets(codec=b"h265"),
    b"\0" + b"Name".ljust(64, b"\0") + b"h264" + struct.pack(">III", 0x80000000, 0, 3200),
    b"\0" + b"Name".ljust(64, b"\0") + b"h264" +
      struct.pack(">III", 0x80000000, 1440, 3200) +
      struct.pack(">QI", 1, video.MAX_PACKET_BYTES + 1),
])
def test_reject_unexpected_handshake_codec_dimensions_and_packet_size(data):
    with sock_with_data(data) as sock, pytest.raises(video.VideoProbeError):
        video.read_scrcpy_sample(sock, time.monotonic() + 2)


class FakeChild:
    def __init__(self):
        self.terminated = False
    def poll(self):
        return 0 if self.terminated else None
    def terminate(self):
        self.terminated = True
    def wait(self, timeout):
        return 0
    def kill(self):
        self.terminated = True


@pytest.mark.parametrize("good_stream", [True, False])
def test_one_shot_video_experiment_always_cleans_its_adb_resources(monkeypatch, tmp_path, good_stream):
    server = tmp_path / "scrcpy-server"
    server.write_bytes(b"scrcpy binary placeholder for isolated mocked test")
    calls = []
    child = FakeChild()
    def fake_adb(serial, *args, timeout=12):
        calls.append((serial, *args))
        if args[:2] == ("forward", "tcp:0"):
            return "47001"
        return ""
    monkeypatch.setattr(video, "_run_adb", fake_adb)
    monkeypatch.setattr(video.subprocess, "Popen", lambda *a, **kw: child)
    def make_socket(port, proc, deadline):
        assert port == 47001 and proc is child
        return sock_with_data(sample_packets() if good_stream else b"\xff")
    monkeypatch.setattr(video, "_connect_forwarded", make_socket)
    if good_stream:
        result = video.probe_video("10.10.30.206:40455", profile="native", server_file=server)
        assert result["requested"]["max_size"] == 0
        assert result["requested"]["video_bit_rate"] == 16_000_000
        assert result["selected_serial"] == "10.10.30.206:40455"
        assert result["stream_received"] is True
        assert result["web_decode_verified"] is False
    else:
        with pytest.raises(video.VideoProbeError):
            video.probe_video("10.10.30.206:40455", server_file=server)
    assert child.terminated
    assert any(c[1:4] == ("forward", "--remove", "tcp:47001") for c in calls)
    assert any(c[1:4] == ("shell", "rm", "-f") for c in calls)
    assert not any("connect" in c or "disconnect" in c for c in calls)


def test_video_probe_endpoint_uses_only_persisted_selected_serial(monkeypatch, tmp_path):
    monkeypatch.setenv("EASYADB_TOKEN", "local-test-token-123")
    mod = importlib.import_module("server.app")
    mod.store = DeviceStore(str(tmp_path / "db.sqlite3"))
    mod.manager = DeviceManager(mod.store, mod.adb)
    captured = []
    def fake_probe(serial, profile):
        captured.append((serial, profile))
        return {"stream_received": True, "web_decode_verified": False, "selected_serial": serial}
    monkeypatch.setattr(mod, "probe_video", fake_probe)
    def fake_adb(*args, **kw):
        return subprocess.CompletedProcess(args, 0, "device\n", "")
    monkeypatch.setattr(mod, "adb", fake_adb)
    with TestClient(mod.app) as client:
        client.post("/api/groups", headers=AUTH, json={"name": "Home", "ip_prefix": "192.168.10.*"})
        d = client.post("/api/devices", headers=AUTH, json={"name": "Test", "group_name": "Home", "ip": "10.10.30.206", "port": 40455}).json()
        endpoint = f"/api/devices/{d['id']}/m2/video-probe"
        assert client.post(endpoint, json={"profile": "baseline"}).status_code == 401
        assert client.post(endpoint, headers=AUTH, json={"profile": "unknown"}).status_code == 422
        assert client.post(endpoint, headers=AUTH, json={"profile": "baseline"}).status_code == 409
        assert captured == []
        mod.manager._set_state(d["id"], "connected", serial="10.10.30.206:40455", route="mesh")
        assert client.post(endpoint, headers=AUTH, json={"profile": "native"}).json()["stream_received"] is True
        assert captured == [("10.10.30.206:40455", "native")]
        client.put(f"/api/devices/{d['id']}/route", headers=AUTH, json={"route": "lan"})
        assert client.post(endpoint, headers=AUTH, json={"profile": "baseline"}).status_code == 409
        assert captured == [("10.10.30.206:40455", "native")]
