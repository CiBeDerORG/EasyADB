"""M1: CRUD, persisted manual route and no background ADB work."""
import importlib
import sqlite3
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
    online, calls = set(), []

    def run(args, **kwargs):
        calls.append(args)
        if args[1] == "connect":
            online.add(args[2])
            return subprocess.CompletedProcess(args, 0, "connected\n", "")
        if "get-state" in args:
            serial = args[2]
            success = serial in online
            return subprocess.CompletedProcess(args, 0 if success else 1,
                                               "device\n" if success else "", "")
        if "getprop" in args:
            return subprocess.CompletedProcess(args, 0,
                        "Test Model\n" if args[-1] == "ro.product.model" else "14\n", "")
        if "screencap" in args:
            return subprocess.CompletedProcess(args, 0, PNG + args[2].encode(), b"")
        raise AssertionError(args)

    monkeypatch.setattr(module.subprocess, "run", run)
    return module, online, calls


def device(ip, port, name, group=""):
    return {"name": name, "group_name": group, "ip": ip, "port": port}


def test_multi_device_crud_and_manual_connection(monkeypatch, tmp_path):
    mod, online, calls = setup_app(monkeypatch, tmp_path)
    with TestClient(mod.app) as client:
        assert not calls, "Starting the service must not check or reconnect ADB devices"
        assert client.get("/api/devices").status_code == 401
        assert client.post("/api/devices", headers=AUTH,
                           json=device("invalid", 5555, "Broken")).status_code == 400
        assert client.post("/api/devices", headers=AUTH,
                           json=device("10.0.0.3", 5555, "  ")).status_code == 400
        a = client.post("/api/devices", headers=AUTH,
                        json=device("10.0.0.11", 5555, "Phone A", "Home"))
        b = client.post("/api/devices", headers=AUTH,
                        json=device("10.0.0.12", 5556, "Phone B"))
        assert a.status_code == b.status_code == 201
        aid, bid = a.json()["id"], b.json()["id"]
        assert a.json()["selected_route"] == "mesh"
        assert a.json()["selected_serial"] == "10.0.0.11:5555"
        assert "auto_reconnect" not in a.json()
        assert not calls, "CRUD and list must not send ADB commands"
        assert client.post("/api/devices", headers=AUTH,
                           json=device("10.0.0.11", 5555, "Dup")).status_code == 409
        assert client.get(f"/api/devices/{aid}/screenshot", headers=AUTH).status_code == 409

        assert client.post(f"/api/devices/{aid}/connect", headers=AUTH).json()["status"] == "connected"
        assert client.post(f"/api/devices/{bid}/connect", headers=AUTH).json()["status"] == "connected"
        assert client.get(f"/api/devices/{aid}/screenshot", headers=AUTH).content == PNG + b"10.0.0.11:5555"
        assert client.get(f"/api/devices/{bid}/screenshot", headers=AUTH).content == PNG + b"10.0.0.12:5556"
        assert [c[2] for c in calls if c[1] == "connect"] == ["10.0.0.11:5555", "10.0.0.12:5556"]

        updated = client.put(f"/api/devices/{aid}", headers=AUTH,
                             json=device("10.0.0.11", 6000, "Renamed", "Home"))
        assert updated.status_code == 200
        assert updated.json()["id"] == aid
        assert updated.json()["status"] == "idle"
        assert client.get(f"/api/devices/{aid}/screenshot", headers=AUTH).status_code == 409
        assert client.put(f"/api/devices/{bid}", headers=AUTH,
                          json=device("10.0.0.11", 6000, "Collision")).status_code == 409
        assert client.delete(f"/api/devices/{bid}", headers=AUTH).json() == {"deleted": True}
        assert client.get(f"/api/devices/{bid}/screenshot", headers=AUTH).status_code == 404
        assert len(client.get("/api/devices", headers=AUTH).json()) == 1

    reopened = DeviceStore(str(tmp_path / "devices.sqlite3"))
    reopened.initialize()
    assert [(d["id"], d["name"], d["port"]) for d in reopened.list()] == [
        (aid, "Renamed", 6000)
    ]


def test_old_auto_reconnect_data_is_ignored(monkeypatch, tmp_path):
    dbfile = tmp_path / "devices.sqlite3"
    store = DeviceStore(str(dbfile))
    store.initialize()
    with sqlite3.connect(dbfile) as db:
        db.execute("""INSERT INTO devices
                   (id,name,group_name,ip,port,auto_reconnect)
                   VALUES ('old','Previously Auto','','10.10.30.206',5555,1)""")
    mod, online, calls = setup_app(monkeypatch, tmp_path)
    with TestClient(mod.app) as client:
        assert not calls, "A legacy auto_reconnect=1 must NEVER restart polling"
        d = client.get("/api/devices", headers=AUTH).json()[0]
        assert d["selected_route"] == "mesh"
        assert d["selected_serial"] == "10.10.30.206:5555"
        assert d["status"] == "idle"
        assert "auto_reconnect" not in d
        assert not calls
        checked = client.post("/api/devices/refresh", headers=AUTH).json()
        assert checked[0]["status"] == "disconnected"
        assert not any(c[1] == "connect" for c in calls), "Explicit status checking must not reconnect"
        assert client.post("/api/devices/old/connect", headers=AUTH).json()["status"] == "connected"
        assert [c[2] for c in calls if c[1] == "connect"] == ["10.10.30.206:5555"]
