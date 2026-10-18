"""M2-00-E: fMP4 init, no-WebCodecs UI, one-shot WebSocket authorization."""
import importlib
import queue
import shutil
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
    FFMPEG_MSE_ARGS, Fmp4FragmentAssembler, LiveRegistry, LiveVideo, StreamStopped,
    VideoProbeError, _socket_read, parse_init_segments,
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


def test_live_diagnostics_are_session_local_and_need_no_adb(tmp_path):
    live = LiveVideo("selected-only:5555", "baseline", server_file=tmp_path / "absent.jar")
    before = live.diagnostics()
    assert before["stage"] == "等待启动"
    assert before["phone_packets"] == 0 and before["phone_idle_ms"] is None
    assert before["mux_chunks"] == 0 and before["mux_idle_ms"] is None
    assert before["init_ready_ms"] is None
    live._phase_set("等待 FFmpeg 初始化段")
    live._record_phone_packet()
    live._record_mux_chunk()
    after = live.diagnostics()
    assert after["stage"] == "等待 FFmpeg 初始化段"
    assert after["phone_packets"] == 1 and after["mux_chunks"] == 1
    assert 0 <= after["phone_idle_ms"] < 1000
    assert 0 <= after["mux_idle_ms"] < 1000
    assert after["elapsed_ms"] >= before["elapsed_ms"]



def test_fmp4_fragmenter_coalesces_split_boxes_without_extra_frame_wait():
    frag1 = box(b"moof", b"frag1") + box(b"mdat", b"media1")
    frag2 = box(b"moof", b"frag2") + box(b"mdat", b"media2")
    assembler = Fmp4FragmentAssembler()
    emitted = []
    for byte in frag1 + frag2:
        emitted.extend(assembler.feed(bytes((byte,))))
    assert emitted == [frag1, frag2]
    assert assembler.feed(b"") == []


def test_fmp4_fragmenter_optional_prefix_and_malformed_boxes():
    assembler = Fmp4FragmentAssembler()
    prefix = box(b"styp", b"isom")
    media = box(b"moof", b"head") + box(b"mdat", b"data")
    assert assembler.feed(prefix + media) == [prefix + media]
    assert assembler.feed(box(b"mfra", b"index")) == []
    for bad in (
        box(b"mdat", b"orphan"), box(b"junk", b"unknown"),
        struct.pack(">I4s", 0, b"moof"),
        struct.pack(">I4s", 0x7FFFFFFF, b"moof"),
        box(b"moof", b"one") + box(b"moof", b"two"),
    ):
        with pytest.raises(VideoProbeError):
            Fmp4FragmentAssembler().feed(bad)


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


def test_http_nas_player_uses_mse_adapter_and_reserves_webcodecs_interface():
    root = Path(__file__).resolve().parents[1]
    html = (root / "web" / "index.html").read_text()
    adapter = (root / "web" / "m2-player.js").read_text()
    assert 'id="liveVideo"' in html and 'id="liveStart"' in html
    assert 'id="liveStop"' in html and '<script src="/m2-player.js"></script>' in html
    assert "EasyADBPlayers.create(playerMode,video" in html
    assert 'id="m2LiveDiag"' in html
    assert "else if(msg.type==='diagnostic'){liveDiagnostic(msg);}" in html
    assert "requestVideoFrameCallback" in html
    assert "adb_check_ms" in html
    assert "new MediaSource()" in adapter
    assert "MediaSource.isTypeSupported(mime)" in adapter
    assert "new WebSocket(" in html and "player:playerMode" in html
    assert "new VideoDecoder" not in adapter and "new VideoDecoder" not in html
    assert "WebCodecsPlayer.implemented" in adapter
    assert "format!=='fmp4'" in adapter
    assert "window.addEventListener('beforeunload',stopLive)" in html


def test_js_adapter_is_served_as_javascript_without_auth(monkeypatch, tmp_path):
    monkeypatch.setenv("EASYADB_TOKEN", "local-test-token-123")
    mod = importlib.import_module("server.app")
    mod.store = DeviceStore(str(tmp_path / "db.sqlite3"))
    mod.manager = DeviceManager(mod.store, mod.adb)
    with TestClient(mod.app) as client:
        response = client.get("/m2-player.js")
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("application/javascript")
        assert "EasyADBPlayers" in response.text
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


def test_real_ffmpeg_copy_remux_produces_mse_init_and_media_fragments():
    """Runs the same -c:v copy command as production on short synthetic H.264."""
    if not shutil.which("ffmpeg"):
        pytest.skip("FFmpeg not installed on this local development environment")
    encoded = subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
        "-f", "lavfi", "-i", "testsrc2=size=160x96:rate=30",
        "-frames:v", "12", "-c:v", "libx264", "-preset", "ultrafast",
        "-pix_fmt", "yuv420p", "-f", "h264", "pipe:1",
    ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20, check=True).stdout
    assert encoded.startswith(bytes((0, 0, 0, 1))) or encoded.startswith(bytes((0, 0, 1)))
    fragmented = subprocess.run(
        ["ffmpeg", *FFMPEG_MSE_ARGS], input=encoded,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        timeout=20, check=True,
    ).stdout
    parsed = parse_init_segments(fragmented)
    assert parsed is not None
    end, initialization, mime = parsed
    assert b"ftyp" in initialization[:16]
    assert b"moov" in initialization
    assert mime.startswith('video/mp4; codecs="avc1.')
    assert b"moof" in fragmented[end:]
    assert b"mdat" in fragmented[end:]
    # The real pipe is arbitrarily chunked, including splitting a box header.
    # Transport exactly one complete moof+mdat group per encoded frame.
    assembler = Fmp4FragmentAssembler()
    media = fragmented[end:]
    chunks = []
    for offset in range(0, len(media), 37):
        chunks.extend(assembler.feed(media[offset:offset + 37]))
    assert len(chunks) == 12
    assert all(b"moof" in chunk and b"mdat" in chunk for chunk in chunks)
    packed = b"".join(chunks)
    assert media.startswith(packed)
    trailing = media[len(packed):]
    assert not trailing or trailing[4:8] == b"mfra"


def test_sparse_scrcpy_like_input_keeps_real_timeline_in_fragmented_mp4(tmp_path):
    """Old '-r 30' mapped 12 frames/1.2 wall seconds into only 0.4s.

    scrcpy repeats unchanged display frames about every 100ms; MP4 timestamps
    must span approximately their arrival time rather than nominal 30fps.
    """
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        pytest.skip("FFmpeg/ffprobe unavailable")
    encoded = subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
        "-f", "lavfi", "-i", "testsrc2=size=160x96:rate=30",
        "-frames:v", "12", "-c:v", "libx264", "-preset", "ultrafast",
        "-x264-params", "aud=1:keyint=30:scenecut=0",
        "-pix_fmt", "yuv420p", "-f", "h264", "pipe:1",
    ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20, check=True).stdout
    aud = bytes((0, 0, 0, 1, 9))
    starts = []
    offset = 0
    while (found := encoded.find(aud, offset)) >= 0:
        starts.append(found)
        offset = found + len(aud)
    assert len(starts) == 12
    # Preserve SPS/PPS prefix in the first access unit.
    packets = [encoded[:starts[1]]] + [
        encoded[starts[i]:starts[i + 1]] for i in range(1, len(starts) - 1)
    ] + [encoded[starts[-1]:]]
    assert len(packets) == 12
    output_path = tmp_path / "sparse-idle.mp4"
    with output_path.open("wb") as output:
        process = subprocess.Popen(
            ["ffmpeg", *FFMPEG_MSE_ARGS],
            stdin=subprocess.PIPE, stdout=output, stderr=subprocess.PIPE,
        )
        try:
            for packet in packets:
                process.stdin.write(packet)
                process.stdin.flush()
                time.sleep(0.10)
            process.stdin.close()
            error = process.stderr.read()
            assert process.wait(timeout=10) == 0, error.decode("utf-8", "replace")
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
    reported = subprocess.run([
        "ffprobe", "-v", "error", "-show_entries", "packet=pts_time",
        "-select_streams", "v:0", "-of", "csv=p=0", str(output_path),
    ], capture_output=True, text=True, timeout=10, check=True)
    pts = [float(v) for v in reported.stdout.splitlines() if v.strip()]
    assert len(pts) == 12
    assert pts[-1] - pts[0] >= 0.75, (
        f"Sparse source time compressed: first={pts[0]}, last={pts[-1]}"
    )
    assert b"moof" in output_path.read_bytes()
