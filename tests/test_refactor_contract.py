"""Frozen M3 HTTP/WS route contract for architecture-only refactoring.

The expected routes were captured at M3 commit
5ff047fa3a4dbe0aed75e1a06fa0d4d20042787a, NOT generated at test time.
An intentional API change needs explicit review of this contract.
"""
import importlib

from fastapi.routing import APIWebSocketRoute
from fastapi.testclient import TestClient


EXPECTED_HTTP = {
    ("GET", "/"),
    ("GET", "/m2-player.js"),
    ("GET", "/m2-webrtc.js"),
    ("GET", "/m2-traffic.js"),
    ("GET", "/m2-touch.js"),
    ("GET", "/m2-metrics.js"),
    ("GET", "/display-lab.js"),
    ("GET", "/m2-multi.js"),
    ("GET", "/m2-group.js"),
    ("POST", "/api/pair"),
    ("POST", "/api/devices/{device_id}/pair"),
    ("GET", "/api/devices"),
    ("GET", "/api/groups"),
    ("POST", "/api/groups"),
    ("PUT", "/api/groups/{group_name}"),
    ("PUT", "/api/groups/{group_name}/discovery"),
    ("DELETE", "/api/groups/{group_name}/discovery"),
    ("POST", "/api/groups/{group_name}/discovery/test"),
    ("POST", "/api/groups/{group_name}/discovery/scan"),
    ("GET", "/api/groups/{group_name}/discovery/last"),
    ("DELETE", "/api/groups/{group_name}"),
    ("POST", "/api/devices"),
    ("POST", "/api/devices/refresh"),
    ("PUT", "/api/devices/{device_id}"),
    ("GET", "/api/devices/{device_id}/unlock"),
    ("PUT", "/api/devices/{device_id}/unlock"),
    ("DELETE", "/api/devices/{device_id}"),
    ("PUT", "/api/devices/{device_id}/temp-address"),
    ("PUT", "/api/devices/{device_id}/route"),
    ("POST", "/api/devices/{device_id}/connect"),
    ("POST", "/api/devices/{device_id}/refresh"),
    ("POST", "/api/devices/{device_id}/m2/preflight"),
    ("POST", "/api/devices/{device_id}/m2/video-probe"),
    ("GET", "/api/devices/{device_id}/display-lab/state"),
    ("POST", "/api/devices/{device_id}/display-lab/environment"),
    ("POST", "/api/devices/{device_id}/display-lab/scan"),
    ("POST", "/api/devices/{device_id}/display-lab/overlay"),
    ("POST", "/api/devices/{device_id}/display-lab/restore"),
    ("POST", "/api/devices/{device_id}/display-lab/castplus/start"),
    ("POST", "/api/devices/{device_id}/display-lab/castplus/auto"),
    ("POST", "/api/devices/{device_id}/display-lab/castplus/switch"),
    ("POST", "/api/devices/{device_id}/display-lab/castplus/verify"),
    ("POST", "/api/devices/{device_id}/display-lab/castplus/restore"),
    ("GET", "/api/m2/video-engine"),
    ("GET", "/api/devices/{device_id}/screenshot"),
    ("POST", "/api/connect"),
    ("GET", "/api/status"),
    ("GET", "/api/screenshot"),
}
EXPECTED_WS = {
    "/api/devices/{device_id}/m2/live",
}


def _module(monkeypatch):
    monkeypatch.setenv("EASYADB_TOKEN", "local-test-token-123")
    return importlib.import_module("server.app")


def test_m3_http_and_websocket_routes_unchanged(monkeypatch):
    mod = _module(monkeypatch)
    # Compare exposed HTTP paths regardless of whether a static route is
    # represented as FastAPI APIRoute or Starlette Route by installed versions.
    http = {(method, route.path) for route in mod.app.routes
            for method in (getattr(route, "methods", None) or ())}
    ws = {route.path for route in mod.app.routes
          if isinstance(route, APIWebSocketRoute)}
    # API paths are registered directly. Public static assets are validated
    # with actual requests because their router representation is framework-
    # version-specific; preserving the served paths is the real contract.
    assert {(method, path) for method, path in http if path.startswith("/api/")} == {
        (method, path) for method, path in EXPECTED_HTTP if path.startswith("/api/")
    }
    assert ws == EXPECTED_WS
    with TestClient(mod.app) as client:
        for method, path in EXPECTED_HTTP:
            if not path.startswith("/api/"):
                response = client.request(method, path)
                assert response.status_code == 200, path
                assert response.headers["cache-control"] == "no-store"
                if path.endswith(".js"):
                    assert response.headers["content-type"].startswith("application/javascript")


def test_m3_auth_and_public_capability_boundary(monkeypatch):
    mod = _module(monkeypatch)
    with TestClient(mod.app) as client:
        # Calls must fail authentication BEFORE requiring ADB or valid device IDs.
        for method, path in (
            ("GET", "/api/devices"),
            ("GET", "/api/groups"),
            ("POST", "/api/devices/missing/connect"),
            ("POST", "/api/groups/missing/discovery/scan"),
            ("DELETE", "/api/devices/missing"),
        ):
            assert client.request(method, path).status_code == 401, (method, path)
        assert client.get("/api/devices", headers={"X-EasyADB-Token": "invalid"}).status_code == 401
        public = client.get("/api/m2/video-engine")
        assert public.status_code == 200
        assert set(public.json()) == {"engine", "implemented"}
        assert "token" not in str(public.json()).lower()
