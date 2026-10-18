"""M2-00: explicit, authenticated, read-only preflight bound to M1 selected IP."""
import importlib
import subprocess

from fastapi.testclient import TestClient

from server.devices import DeviceManager
from server.m2_preflight import inspect_device
from server.store import DeviceStore

AUTH = {"X-EasyADB-Token": "local-test-token-123"}


def setup_app(monkeypatch, tmp_path):
    monkeypatch.setenv("EASYADB_TOKEN", "local-test-token-123")
    module = importlib.import_module("server.app")
    module.store = DeviceStore(str(tmp_path / "devices.sqlite3"))
    module.manager = DeviceManager(module.store, module.adb)
    online, calls = set(), []

    def fake_run(args, **kwargs):
        calls.append(args)
        if args[1] == "connect":
            online.add(args[2])
            return subprocess.CompletedProcess(args, 0, "connected\n", "")
        if args[1] == "-s":
            serial = args[2]
            if args[3] == "get-state":
                ok = serial in online
                return subprocess.CompletedProcess(args, 0 if ok else 1,
                                                   "device\n" if ok else "", "")
            if args[3:5] == ["shell", "getprop"]:
                values = {
                    "ro.product.model": "Test Phone",
                    "ro.build.version.release": "15",
                    "ro.build.version.sdk": "35",
                    "ro.product.cpu.abi": "arm64-v8a",
                }
                return subprocess.CompletedProcess(args, 0, values.get(args[5], "") + "\n", "")
            if args[3:5] == ["shell", "wm"]:
                return subprocess.CompletedProcess(args, 0,
                                                   "Physical size: 1080x2400\n", "")
        raise AssertionError(args)

    monkeypatch.setattr(module.subprocess, "run", fake_run)
    return module, calls


def test_preflight_only_after_manual_connect_and_only_on_selected_ip(monkeypatch, tmp_path):
    mod, calls = setup_app(monkeypatch, tmp_path)
    with TestClient(mod.app) as client:
        g = client.post("/api/groups", headers=AUTH,
                        json={"name": "Home", "ip_prefix": "192.168.10.*"})
        assert g.status_code == 201
        added = client.post("/api/devices", headers=AUTH, json={
            "name": "Phone", "group_name": "Home", "ip": "10.10.30.206", "port": 5555
        })
        assert added.status_code == 201
        device_id = added.json()["id"]
        endpoint = f"/api/devices/{device_id}/m2/preflight"
        assert not calls  # no startup timer
        assert client.post(endpoint).status_code == 401
        assert client.post(endpoint, headers=AUTH).status_code == 409
        assert client.post("/api/devices/nonexistent/m2/preflight", headers=AUTH).status_code == 404
        assert not any(c[1] == "connect" for c in calls)

        # Manual selection alone never connects.
        selected = client.put(f"/api/devices/{device_id}/route", headers=AUTH,
                              json={"route": "lan"})
        assert selected.status_code == 200
        assert client.post(endpoint, headers=AUTH).status_code == 409
        assert not any(c[1] == "connect" for c in calls)

        assert client.post(f"/api/devices/{device_id}/connect", headers=AUTH).status_code == 200
        before = sum(c[1] == "connect" for c in calls)
        result = client.post(endpoint, headers=AUTH)
        assert result.status_code == 200
        assert result.json() == {
            "selected_serial": "192.168.10.206:5555",
            "android_sdk": 35,
            "cpu_abi": "arm64-v8a",
            "model": "Test Phone",
            "display_size": "Physical size: 1080x2400",
            "adb_connected": True,
            "stream_verified": False,
            "note": "基础 ADB 信息已读取；尚未启动或验证实时视频流",
        }
        assert sum(c[1] == "connect" for c in calls) == before
        assert not any(c[1] in ("push", "forward", "reverse") for c in calls)
        assert not any(c[3:5] == ["shell", "screencap"] for c in calls if len(c) >= 5)
        assert {c[2] for c in calls if c[1] == "-s"} == {"192.168.10.206:5555"}

        # An address switch invalidates the previous M2 preflight session.
        client.put(f"/api/devices/{device_id}/route", headers=AUTH,
                   json={"route": "mesh"})
        assert client.post(endpoint, headers=AUTH).status_code == 409
        assert sum(c[1] == "connect" for c in calls) == before


def test_preflight_does_not_guess_missing_sdk_or_codec():
    def adb(*args, **kwargs):
        return subprocess.CompletedProcess(args, 0,
                ("not-an-sdk\n" if args[-1] == "ro.build.version.sdk" else ""), "")
    result = inspect_device("10.10.30.206:5555", adb)
    assert result["android_sdk"] is None
    assert result["stream_verified"] is False
    assert result["cpu_abi"] is None
    assert result["display_size"] is None
