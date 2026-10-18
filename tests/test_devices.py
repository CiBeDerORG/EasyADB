"""M1 regression tests use a fake ADB transport; no Android device is required."""
import importlib
import subprocess

from fastapi.testclient import TestClient

from server.devices import DeviceManager
from server.store import DeviceStore

AUTH = {"X-EasyADB-Token": "local-test-token-123"}
PNG = b"\x89PNG\r\n\x1a\n"


def setup_app(monkeypatch, tmp_path):
    monkeypatch.setenv("EASYADB_TOKEN", "local-test-token-123")
    module = importlib.import_module("server.app")
    module.store = DeviceStore(str(tmp_path / "devices.sqlite3"))
    module.manager = DeviceManager(module.store, module.adb)
    online = set()
    calls = []

    def run(args, **kwargs):
        calls.append(args)
        if args[1] == "connect":
            online.add(args[2])
            return subprocess.CompletedProcess(args, 0, "connected\n", "")
        if "get-state" in args:
            serial = args[2]
            return subprocess.CompletedProcess(
                args, 0 if serial in online else 1,
                "device\n" if serial in online else "", ""
            )
        if "getprop" in args:
            value = "Test Model\n" if args[-1] == "ro.product.model" else "14\n"
            return subprocess.CompletedProcess(args, 0, value, "")
        if "screencap" in args:
            return subprocess.CompletedProcess(args, 0, PNG + args[2].encode(), b"")
        raise AssertionError(args)

    monkeypatch.setattr(module.subprocess, "run", run)
    return module, online, calls


def device(ip, port, name, auto=False, group=""):
    return {"name": name, "group_name": group, "ip": ip,
            "port": port, "auto_reconnect": auto}


def test_multi_device_crud_and_scoped_screenshots(monkeypatch, tmp_path):
    module, online, calls = setup_app(monkeypatch, tmp_path)
    with TestClient(module.app) as client:
        module.manager.stop()  # deterministic explicit probes in this test
        assert client.get("/api/devices").status_code == 401
        invalid = client.post("/api/devices", headers=AUTH,
                              json=device("not-an-ip", 5555, "invalid"))
        assert invalid.status_code == 400
        empty_name = client.post("/api/devices", headers=AUTH,
                                 json=device("192.168.1.3", 5555, "  "))
        assert empty_name.status_code == 400

        a = client.post("/api/devices", headers=AUTH,
                        json=device("192.168.1.11", 37123, "Phone A", group="Home"))
        b = client.post("/api/devices", headers=AUTH,
                        json=device("192.168.1.12", 37124, "Phone B"))
        assert a.status_code == b.status_code == 201
        aid, bid = a.json()["id"], b.json()["id"]
        assert aid != bid
        assert len(client.get("/api/devices", headers=AUTH).json()) == 2
        assert client.post("/api/devices", headers=AUTH,
                           json=device("192.168.1.11", 37123, "Duplicate")).status_code == 409
        assert client.get(f"/api/devices/{aid}/screenshot", headers=AUTH).status_code == 409

        assert client.post(f"/api/devices/{aid}/connect", headers=AUTH).json()["status"] == "connected"
        assert client.post(f"/api/devices/{bid}/connect", headers=AUTH).json()["status"] == "connected"
        imga = client.get(f"/api/devices/{aid}/screenshot", headers=AUTH)
        imgb = client.get(f"/api/devices/{bid}/screenshot", headers=AUTH)
        assert imga.content == PNG + b"192.168.1.11:37123"
        assert imgb.content == PNG + b"192.168.1.12:37124"
        assert imga.content != imgb.content
        assert any(call[1:3] == ["-s", "192.168.1.11:37123"] for call in calls)
        assert any(call[1:3] == ["-s", "192.168.1.12:37124"] for call in calls)

        # Editing preserves the logical ID, but a new endpoint clears cached metadata.
        edit = client.put(f"/api/devices/{aid}", headers=AUTH,
                          json=device("192.168.1.11", 40000, "Renamed", group="Office"))
        assert edit.status_code == 200
        assert edit.json()["id"] == aid
        assert edit.json()["model"] is None
        assert edit.json()["status"] == "checking"
        assert client.put(f"/api/devices/{bid}", headers=AUTH,
                          json=device("192.168.1.11", 40000, "Collision")).status_code == 409
        assert client.delete(f"/api/devices/{bid}", headers=AUTH).json()["deleted"] is True
        assert client.get(f"/api/devices/{bid}/screenshot", headers=AUTH).status_code == 404
        assert len(client.get("/api/devices", headers=AUTH).json()) == 1

    # Opening a new store against the same path simulates service restart.
    reopened = DeviceStore(str(tmp_path / "devices.sqlite3"))
    assert [(x["id"], x["name"], x["port"]) for x in reopened.list()] == [
        (aid, "Renamed", 40000)
    ]


def test_auto_reconnect_and_disabled_option(monkeypatch, tmp_path):
    module, online, calls = setup_app(monkeypatch, tmp_path)
    with TestClient(module.app) as client:
        module.manager.stop()
        a = client.post("/api/devices", headers=AUTH,
                        json=device("10.1.1.2", 5555, "Auto", auto=True)).json()
        b = client.post("/api/devices", headers=AUTH,
                        json=device("10.1.1.3", 5556, "Manual", auto=False)).json()
        results = client.post("/api/devices/refresh", headers=AUTH).json()
        assert {d["id"]: d["status"] for d in results} == {
            a["id"]: "connected", b["id"]: "disconnected"
        }
        assert "10.1.1.2:5555" in online
        assert "10.1.1.3:5556" not in online
        assert sum(call[1:2] == ["connect"] for call in calls) == 1
        online.clear()  # network dropped
        refreshed = client.post(f'/api/devices/{a["id"]}/refresh', headers=AUTH).json()
        assert refreshed["status"] == "connected"
        assert refreshed["model"] == "Test Model"
        assert refreshed["android_version"] == "14"
        assert refreshed["last_seen"] is not None
        assert sum(call[1:2] == ["connect"] for call in calls) == 2
