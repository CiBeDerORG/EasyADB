"""V2-F05: Compose startup quota reaches the actual API process unchanged.

No Docker, ADB, NAS, network or live device access; each API probe starts a
fresh isolated Python process so app module globals cannot hide config drift.
"""
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
COMPOSE_FILES = ("compose.yaml", "compose.no-proxy.yaml", "compose.webrtc.yaml")

# A new interpreter is required: server.app reads Settings at import time.
PROBE = r"""
import importlib
import json
from fastapi.testclient import TestClient

module = importlib.import_module("server.app")
client = TestClient(module.app)
response = client.get("/api/m2/video-engine")
response.raise_for_status()
print(json.dumps({
    "metadata": response.json(),
    "configured": module.settings.max_starting,
    "budget": module.resource_budget.snapshot(),
    "max_sessions": module.live_registry.MAX_LIVE_SESSIONS,
}))
"""


def test_all_compose_entries_forward_identical_startup_budget():
    expected = "      EASYADB_MAX_STARTING: " + "$" + "{EASYADB_MAX_STARTING:-3}"
    for filename in COMPOSE_FILES:
        content = (ROOT / filename).read_text()
        # Quote-free Compose scalar expands to the actual .env or shell value;
        # :-3 also covers unset/empty environment values.
        assert content.count(expected + "\n") == 1, filename
        assert "EASYADB_VIDEO_ENGINE: webrtc" in content
        assert "network_mode: host" in content
    example = (ROOT / ".env.example").read_text()
    assert "EASYADB_MAX_STARTING=3\n" in example


def probe(tmp_path, setting):
    env = os.environ.copy()
    env.update({
        "EASYADB_TOKEN": "local-test-token-123",
        "EASYADB_DB": str(tmp_path / "quota-probe.sqlite3"),
        "EASYADB_VIDEO_ENGINE": "webrtc",
    })
    env.pop("EASYADB_MAX_STARTING", None)
    if setting is not None:
        env["EASYADB_MAX_STARTING"] = setting
    return subprocess.run([sys.executable, "-c", PROBE], cwd=ROOT, env=env,
                          text=True, capture_output=True, timeout=30, check=False)


@pytest.mark.parametrize(("setting", "expected"), [
    (None, 3), ("1", 1), ("3", 3), ("5", 5),
])
def test_startup_budget_reaches_fresh_app_and_public_metadata(tmp_path, setting, expected):
    result = probe(tmp_path, setting)
    assert result.returncode == 0, result.stdout + result.stderr
    payload = json.loads(result.stdout.strip().splitlines()[-1])
    assert payload["metadata"] == {
        "engine": "webrtc", "implemented": True, "max_starting": expected
    }
    assert payload["configured"] == expected
    assert payload["budget"] == {"starting": 0, "max_starting": expected}
    # Startup concurrency does not alter the independent logical slot limit.
    assert payload["max_sessions"] == 20


@pytest.mark.parametrize("invalid", ["0", "21", "-1", "not-an-integer", "1.5"])
def test_invalid_startup_budget_refuses_application_start(tmp_path, invalid):
    result = probe(tmp_path, invalid)
    assert result.returncode != 0
    assert "EASYADB_MAX_STARTING must be an integer 1..20" in result.stderr
    assert not result.stdout.strip(), "bad config must fail before the API responds"
