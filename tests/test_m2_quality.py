"""M2-05-A bounded live quality profiles; no arbitrary scrcpy options."""
import importlib
import queue
import threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server.devices import DeviceManager
from server.store import DeviceStore
from server.m2_live import LiveRegistry, LiveVideo
from server.m2_quality import CUSTOM_CHOICES, LIVE_PROFILES, resolve_live_quality
from server.m2_video_probe import PROFILES

AUTH = {"X-EasyADB-Token": "local-test-token-123"}


def test_original_probe_and_live_presets_are_unchanged():
    assert PROFILES == {
        "baseline": {"max_size": 1600, "video_bit_rate": 8_000_000, "max_fps": 30},
        "native": {"max_size": 0, "video_bit_rate": 16_000_000, "max_fps": 30},
    }
    assert LIVE_PROFILES["baseline"] == PROFILES["baseline"]
    assert LIVE_PROFILES["native"] == PROFILES["native"]
    assert "economy" not in PROFILES and "custom" not in PROFILES
    assert resolve_live_quality("economy") == {
        "max_size": 960, "video_bit_rate": 3_000_000, "max_fps": 24,
    }
    settings = resolve_live_quality("baseline")
    settings["max_fps"] = 1
    assert LIVE_PROFILES["baseline"]["max_fps"] == 30


@pytest.mark.parametrize("payload", [
    {}, {"max_size": True, "video_bit_rate": 8_000_000, "max_fps": 30},
    {"max_size": "1600", "video_bit_rate": 8_000_000, "max_fps": 30},
    {"max_size": -1, "video_bit_rate": 8_000_000, "max_fps": 30},
    {"max_size": 8192, "video_bit_rate": 8_000_000, "max_fps": 30},
    {"max_size": 1600, "video_bit_rate": 99_000_000, "max_fps": 30},
    {"max_size": 1600, "video_bit_rate": 8_000_000, "max_fps": 120},
    {"max_size": 1600, "video_bit_rate": 8_000_000, "max_fps": 30,
     "shell": "adb disconnect"},
    [1600, 8_000_000, 30], "max_fps=120", None,
])
def test_reject_unsafe_or_malformed_custom_quality(payload):
    with pytest.raises(ValueError):
        resolve_live_quality("custom", payload)


@pytest.mark.parametrize("profile,quality", [
    (None, None), ([], None), ("ultra", None), ("economy", {}),
    ("baseline", {"max_fps": 120}), ("native", {"max_size": 960}),
])
def test_unrecognized_presets_or_overrides_are_rejected(profile, quality):
    with pytest.raises(ValueError):
        resolve_live_quality(profile, quality)


def test_every_allowed_custom_option_is_explicitly_bounded():
    assert CUSTOM_CHOICES == {
        "max_size": (0, 960, 1280, 1600),
        "video_bit_rate": (2_000_000, 4_000_000, 8_000_000, 12_000_000, 16_000_000),
        "max_fps": (15, 24, 30),
    }
    quality = resolve_live_quality("custom", {
        "max_size": 1280, "video_bit_rate": 4_000_000, "max_fps": 15,
    })
    video = LiveVideo("only-selected:5555", "custom", quality=quality)
    assert video.settings == quality
    assert video.settings is not quality
    assert video.profile == "custom"
    assert video.stop_event.is_set() is False
    assert LiveVideo("only-selected:5555", "baseline").settings == PROFILES["baseline"]


def test_invalid_ws_quality_is_rejected_before_adb_or_worker(monkeypatch, tmp_path):
    monkeypatch.setenv("EASYADB_TOKEN", "local-test-token-123")
    mod = importlib.import_module("server.app")
    mod.store = DeviceStore(str(tmp_path / "rejected-quality.sqlite3"))
    mod.manager = DeviceManager(mod.store, mod.adb)
    mod.live_registry = LiveRegistry()
    monkeypatch.setattr(mod, "is_connected", lambda serial: pytest.fail("invalid profile used ADB"))
    monkeypatch.setattr(mod, "LiveVideo", lambda *args, **kwargs: pytest.fail("invalid profile created worker"))
    cases = [
        {"profile": "custom"},
        {"profile": "baseline", "quality": {"max_fps": 120}},
        {"profile": "unknown"},
        {"profile": "custom", "quality": {
            "max_size": 1600, "video_bit_rate": 16_000_000, "max_fps": 60,
        }},
        {"profile": "custom", "quality": {
            "max_size": 1600, "video_bit_rate": 4_000_000, "max_fps": 30, "command": "shell",
        }},
    ]
    with TestClient(mod.app) as client:
        for case in cases:
            with client.websocket_connect(
                "/api/devices/nonexistent/m2/live",
                headers={"origin": "http://testserver"},
            ) as ws:
                ws.send_json({"token": "local-test-token-123", "player": "mse",
                              "selected_serial": "none", **case})
                assert ws.receive_json()["type"] == "error"


def test_custom_quality_uses_current_selected_device_and_reports_actual_size(monkeypatch, tmp_path):
    monkeypatch.setenv("EASYADB_TOKEN", "local-test-token-123")
    mod = importlib.import_module("server.app")
    mod.store = DeviceStore(str(tmp_path / "quality.sqlite3"))
    mod.manager = DeviceManager(mod.store, mod.adb)
    mod.live_registry = LiveRegistry()
    checked = []
    monkeypatch.setattr(mod, "is_connected", lambda serial: checked.append(serial) or True)
    created = []

    class FakeStream:
        def __init__(self, serial, profile, quality=None):
            self.serial, self.profile, self.settings = serial, profile, quality
            self.session_id = "quality-session"
            self.finished = threading.Event()
            self.cleanup_complete = False
            self.events = queue.Queue()
            created.append(self)
        def start(self):
            self.events.put(("init", {
                "width": 720, "height": 1280, "mime": 'video/mp4; codecs="avc1.640028"',
                "profile": self.profile, "control_available": True,
            }))
        def diagnostics(self): return {"stage": "quality test"}
        def stop(self):
            self.cleanup_complete = True
            self.finished.set()
        def join(self, timeout=20): self.finished.wait(timeout)

    monkeypatch.setattr(mod, "LiveVideo", FakeStream)
    quality = {"max_size": 1280, "video_bit_rate": 4_000_000, "max_fps": 24}
    with TestClient(mod.app) as client:
        device = client.post("/api/devices", headers=AUTH, json={
            "name": "Phone", "ip": "10.10.30.206", "port": 40455,
        }).json()
        serial = device["selected_serial"]
        mod.manager._set_state(device["id"], "connected", serial=serial, route="mesh")
        with client.websocket_connect(
            f"/api/devices/{device['id']}/m2/live",
            headers={"origin": "http://testserver"},
        ) as ws:
            ws.send_json({"token": "local-test-token-123", "player": "mse",
                          "profile": "custom", "quality": quality, "selected_serial": serial})
            for _ in range(12):
                msg = ws.receive_json()
                if msg["type"] == "init":
                    assert msg["profile"] == "custom"
                    assert msg["requested"] == quality
                    assert (msg["width"], msg["height"]) == (720, 1280)
                    break
            else:
                pytest.fail("missing init")
            assert created[0].settings == quality and created[0].serial == serial
            ws.send_text("stop")
            for _ in range(12):
                if ws.receive_json()["type"] == "ended":
                    break
            else:
                pytest.fail("missing terminal cleanup")
        assert checked == [serial]
        assert not mod.live_registry.sessions


def test_quality_page_is_opt_in_and_disallows_hot_reconfiguration():
    page = (Path(__file__).resolve().parents[1] / "web" / "index.html").read_text()
    for field in ("liveProfile", "liveCustomQuality", "liveQualitySize",
                  "liveQualityBitrate", "liveQualityFps"):
        assert f'id="{field}"' in page
    for name in ("economy", "baseline", "native", "custom"):
        assert f'value="{name}"' in page
    assert "$('liveProfile').disabled=loading||!!liveWS||" in page
    assert 'id="legacySolo" hidden' in page
    assert 'id="multiPicker"' in page
    assert 'runPreflight:async id' in page
    assert 'runVideoProbe:async(id,profile)' in page
    assert 'id="multiProfile"' not in page
    assert '<option value="economy" selected>' in page
    assert "if(msg.player!==playerMode)" in page
    assert "requested.max_fps" in page and "实际编码" in page
    assert "selected_serial:serial,player:playerMode" in page
