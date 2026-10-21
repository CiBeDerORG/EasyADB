"""V4-02 public ES Modules: explicit HTTP allowlist, legacy routes unchanged."""
import importlib
from pathlib import Path

from fastapi.testclient import TestClient


MODULES = (
    "app/main.js",
    "core/api-client.js",
    "shared/dom.js",
    "shared/ui/dialog.js",
    "shared/ui/toast.js",
    "features/live/live-session-controller.js",
    "features/live/live-card-view.js",
    "features/live/live-batch-scheduler.js",
    "features/live/live-quality-settings.js",
    "features/devices/device-list-model.js",
    "features/devices/device-list-view.js",
    "features/devices/device-connection-controller.js",
)


def test_v4_module_urls_only_serve_explicit_assets(monkeypatch):
    monkeypatch.setenv("EASYADB_TOKEN", "local-test-token-123")
    app = importlib.import_module("server.app").app
    with TestClient(app) as client:
        for path in MODULES:
            response = client.get("/" + path)
            assert response.status_code == 200, path
            assert response.headers["cache-control"] == "no-store"
            assert response.headers["content-type"].startswith("application/javascript")
            assert response.text == (
                Path(__file__).resolve().parents[1] / "web" / path
            ).read_text(encoding="utf-8")
        stylesheet = client.get("/assets/legacy-page.css")
        assert stylesheet.status_code == 200
        assert stylesheet.headers["cache-control"] == "no-store"
        assert stylesheet.headers["content-type"].startswith("text/css")
        assert stylesheet.text == (
            Path(__file__).resolve().parents[1] / "web/assets/legacy-page.css"
        ).read_text(encoding="utf-8")
        page = client.get("/").text
        assert '<link rel="stylesheet" href="/assets/legacy-page.css">' in page
        assert "<style>" not in page
        for path in (
            "/assets/private.css", "/app/secret.js", "/core/private.js", "/shared/ui/private.js",
            "/app/../core/private.js", "/shared/ui/../../.env", "/features/devices/private.js",
        ):
            assert client.get(path).status_code == 404, path
        assert client.get("/m2-webrtc.js").status_code == 200
        assert client.get("/").status_code == 200
