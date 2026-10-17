import importlib
import subprocess
from fastapi.testclient import TestClient

def test_auth_and_invalid_ip(monkeypatch):
    monkeypatch.setenv("EASYADB_TOKEN", "local-test-token-123")
    module = importlib.import_module("server.app")
    client = TestClient(module.app)
    assert client.get("/api/status").status_code == 401
    headers = {"X-EasyADB-Token": "local-test-token-123"}
    assert client.post("/api/connect", headers=headers, json={"ip": "bad host", "port": 5555}).status_code == 400
    assert client.post("/api/pair", headers=headers, json={"ip": "127.0.0.1", "port": 37000, "code": "abc"}).status_code == 400

def test_connect_and_screenshot(monkeypatch):
    monkeypatch.setenv("EASYADB_TOKEN", "local-test-token-123")
    module = importlib.import_module("server.app")
    calls = []
    png = b"\x89PNG\r\n\x1a\n" + b"example-image"
    def fake_run(args, **kwargs):
        calls.append(args)
        if args[1:2] == ["connect"]:
            return subprocess.CompletedProcess(args, 0, "connected", "")
        if "get-state" in args:
            return subprocess.CompletedProcess(args, 0, "device\n", "")
        if "getprop" in args:
            return subprocess.CompletedProcess(args, 0, "Test Phone\n", "")
        if "screencap" in args:
            return subprocess.CompletedProcess(args, 0, png, b"")
        raise AssertionError(args)
    monkeypatch.setattr(module.subprocess, "run", fake_run)
    client = TestClient(module.app)
    headers = {"X-EasyADB-Token": "local-test-token-123"}
    result = client.post("/api/connect", headers=headers, json={"ip": "192.168.1.9", "port": 37123})
    assert result.status_code == 200
    assert result.json()["serial"] == "192.168.1.9:37123"
    assert client.get("/api/status", headers=headers).json()["model"] == "Test Phone"
    image = client.get("/api/screenshot", headers=headers)
    assert image.status_code == 200
    assert image.headers["content-type"] == "image/png"
    assert image.content == png
    assert any(call[1:3] == ["-s", "192.168.1.9:37123"] for call in calls)
