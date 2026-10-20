"""V2-07: no FFmpeg/MSE runtime can be re-enabled accidentally."""
import importlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from server.core.config import load_settings


ROOT = Path(__file__).resolve().parents[1]


def test_v2_has_no_ffmpeg_mse_server_or_browser_pipeline():
    worker = (ROOT / "server" / "m2_live.py").read_text()
    page = (ROOT / "web" / "index.html").read_text()
    multi = (ROOT / "web" / "m2-multi.js").read_text()
    docker = (ROOT / "Dockerfile").read_text()
    assert "FFMPEG_MSE_ARGS" not in worker
    assert "ffmpeg" not in worker.lower()
    assert "Fmp4FragmentAssembler" not in worker
    assert "MediaSource" not in multi
    assert "EasyADBPlayers" not in multi
    assert "m2-player.js" not in page
    assert not (ROOT / "web" / "m2-player.js").exists()
    assert " ffmpeg" not in docker
    assert "EasyADBWebRTC.create(video" in multi


def test_mse_is_invalid_config_and_old_script_is_not_served(monkeypatch, tmp_path):
    env = {"EASYADB_TOKEN": "local-test-token-123"}
    with pytest.raises(RuntimeError, match="mse removed"):
        load_settings({**env, "EASYADB_VIDEO_ENGINE": "mse"})
    monkeypatch.setenv("EASYADB_TOKEN", env["EASYADB_TOKEN"])
    mod = importlib.import_module("server.app")
    with TestClient(mod.app) as client:
        assert client.get("/m2-player.js").status_code == 404
        response = client.get("/api/m2/video-engine")
        assert response.status_code == 200
        assert response.json()["engine"] == "webrtc"
        assert response.json()["implemented"] is True
        assert 1 <= response.json()["max_starting"] <= 20



def test_v2_retired_mse_diagnostics_and_ws_binary_video_cannot_return():
    worker = (ROOT / "server" / "m2_live.py").read_text()
    handler = (ROOT / "server" / "api" / "live_handler.py").read_text()
    player = (ROOT / "web" / "m2-webrtc.js").read_text()
    metrics = (ROOT / "web" / "m2-metrics.js").read_text()
    multi = (ROOT / "web" / "m2-multi.js").read_text()
    documentation = (ROOT / "docs" / "M2-WEBRTC.md").read_text()
    for legacy in ("_mux_chunks", "_mux_last", "_media_fragments",
                   "mux_idle_ms", "_record_mux_chunk", "_record_media_fragments"):
        assert legacy not in worker
    for legacy in ('elif kind == "bytes"', "websocket.send_bytes(payload)",
                   "ws_video_bytes", "ws_video_chunks"):
        assert legacy not in handler
    assert "append(){" not in player
    for legacy in ("sourceBufferReady", "sourceRanges", "queueChunks",
                   "queueBytes", "appendCalls", "completedUpdates", "rangeEnd"):
        assert legacy not in player
    for legacy in ("bufferAhead", "queueBytes", "avgBufferSeconds",
                   "maxQueueBytes", "待追加", "缓冲余量"):
        assert legacy not in metrics
    assert "queueBytes:pd.queueBytes" not in multi
    assert "ws.binaryType='arraybuffer'" not in multi
    assert "EASYADB_VIDEO_ENGINE=mse" not in documentation
    assert "20" in documentation
