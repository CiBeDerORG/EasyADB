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
