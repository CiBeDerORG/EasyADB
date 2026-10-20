"""V2-00 must not regain the retired FFmpeg/MSE runtime or browser player."""
from pathlib import Path

import pytest
from server.core.config import load_settings

ROOT = Path(__file__).resolve().parents[1]


def test_webrtc_only_runtime_and_assets():
    docker = (ROOT / "Dockerfile").read_text().lower()
    live = (ROOT / "server/m2_live.py").read_text().lower()
    web = (ROOT / "web/index.html").read_text()
    player = (ROOT / "web/m2-webrtc.js").read_text()
    assert "ffmpeg" not in docker
    assert "ffmpeg" not in live and "fmp4" not in live
    assert not (ROOT / "web/m2-player.js").exists()
    assert not (ROOT / "compose.webrtc.yaml").exists()
    assert "/m2-player.js" not in web
    assert "append(){" not in player
    assert "sourceBufferReady" not in player and "queueChunks" not in player
    assert "/m2-webrtc.js" in web


@pytest.mark.parametrize("engine", ("mse", "webcodecs", "ffmpeg", "unknown"))
def test_retired_video_settings_never_fall_back_to_webrtc(engine):
    with pytest.raises(RuntimeError, match="only supports"):
        load_settings({"EASYADB_TOKEN": "local-test-token-123", "EASYADB_VIDEO_ENGINE": engine})
