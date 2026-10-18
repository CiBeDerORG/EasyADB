"""Group LAN mapping, LAN-first fallback, snapshot and migration regression tests."""
import importlib
import sqlite3
import subprocess

from fastapi.testclient import TestClient

from server.devices import DeviceManager
from server.store import DeviceStore, internal_ip

AUTH = {"X-EasyADB-Token": "local-test-token-123"}
PNG = b"\x89PNG\r\n\x1a\n"


def fixture(monkeypatch, tmp_path):
    monkeypatch.setenv("EASYADB_TOKEN", "local-test-token-123")
    module = importlib.import_module("server.app")
    module.store = DeviceStore(str(tmp_path / "devices.sqlite3"))
    module.manager = DeviceManager(module.store, module.adb)
    online, blocked, calls = set(), set(), []

    def fake_run(args, **kwargs):
        calls.append(args)
        if args[1] == "connect":
            serial = args[2]
            if serial in blocked:
                return subprocess.CompletedProcess(args, 1, "unable to connect\n", "")
            online.add(serial)
            return subprocess.CompletedProcess(args, 0, "connected\n", "")
        if "get-state" in args:
            serial = args[2]
            success = serial in online
            return subprocess.CompletedProcess(args, 0 if success else 1,
                                               "device\n" if success else "", "")
        if "getprop" in args:
            return subprocess.CompletedProcess(args, 0,
                        "Test Phone\n" if args[-1] == "ro.product.model" else "15\n", "")
        if "screencap" in args:
            return subprocess.CompletedProcess(args, 0, PNG + args[2].encode(), b"")
        raise AssertionError(args)

    monkeypatch.setattr(module.subprocess, "run", fake_run)
    return module, online, blocked, calls


def dev(ip="10.10.30.206", group="Home", port=5555, auto=True):
    return {"name": "Phone", "group_name": group, "ip": ip,
            "port": port, "auto_reconnect": auto}


def test_group_priority_fallback_and_scoped_screenshot(monkeypatch, tmp_path):
    mod, online, blocked, calls = fixture(monkeypatch, tmp_path)
    lan, mesh = "192.168.10.206:5555", "10.10.30.206:5555"
    with TestClient(mod.app) as client:
        mod.manager.stop()
        assert client.get("/api/groups").status_code == 401
        assert client.post("/api/groups", headers=AUTH,
                           json={"name": "Home", "ip_prefix": "192.168.10.*"}).status_code == 201
        add = client.post("/api/devices", headers=AUTH, json=dev())
        assert add.status_code == 201
        device_id = add.json()["id"]
        assert add.json()["mesh_ip"] == "10.10.30.206"
        assert add.json()["lan_ip"] == "192.168.10.206"
        connected = client.post(f"/api/devices/{device_id}/connect", headers=AUTH).json()
        assert connected["status"] == "connected"
        assert connected["active_serial"] == lan
        assert connected["active_route"] == "lan"
        assert client.get(f"/api/devices/{device_id}/screenshot", headers=AUTH).content == PNG + lan.encode()
        assert [c[2] for c in calls if c[1] == "connect"] == [lan]

        online.clear()
        blocked.add(lan)
        fallback = client.post(f"/api/devices/{device_id}/connect", headers=AUTH).json()
        assert fallback["active_serial"] == mesh
        assert fallback["active_route"] == "mesh"
        assert [c[2] for c in calls if c[1] == "connect"][-2:] == [lan, mesh]
        assert client.get(f"/api/devices/{device_id}/screenshot", headers=AUTH).content == PNG + mesh.encode()

        # A new prefix invalidates the old active route; devices retain their ID.
        changed = client.put("/api/groups/Home", headers=AUTH,
                             json={"name": "Home", "ip_prefix": "192.168.20.*"})
        assert changed.status_code == 200
        state = client.get("/api/devices", headers=AUTH).json()[0]
        assert state["id"] == device_id
        assert state["lan_ip"] == "192.168.20.206"
        assert state["status"] == "checking"
        assert client.get(f"/api/devices/{device_id}/screenshot", headers=AUTH).status_code == 409
        # Group renames atomically update member records and derived LAN IPs.
        renamed = client.put("/api/groups/Home", headers=AUTH,
                             json={"name": "Office", "ip_prefix": "192.168.30.*"})
        assert renamed.status_code == 200
        state = client.get("/api/devices", headers=AUTH).json()[0]
        assert state["group_name"] == "Office"
        assert state["lan_ip"] == "192.168.30.206"

        # Removing the prefix means only the saved mesh IP remains.
        cleared = client.put("/api/groups/Office", headers=AUTH,
                             json={"name": "Office", "ip_prefix": ""})
        assert cleared.status_code == 200
        state = client.get("/api/devices", headers=AUTH).json()[0]
        assert state["lan_ip"] is None


def test_prefix_validation_and_cross_device_serial_conflict(monkeypatch, tmp_path):
    mod, online, blocked, calls = fixture(monkeypatch, tmp_path)
    with TestClient(mod.app) as client:
        mod.manager.stop()
        for invalid in ["192.168.10.0/24", "999.168.10.*", "192.168.*",
                        "192.168.10.206", "192.168.010.*"]:
            assert client.post("/api/groups", headers=AUTH,
                               json={"name": "Test", "ip_prefix": invalid}).status_code == 400
        assert client.post("/api/groups", headers=AUTH,
                           json={"name": "Home", "ip_prefix": None}).status_code == 201
        one = client.post("/api/devices", headers=AUTH, json=dev())
        assert one.status_code == 201
        two = client.post("/api/devices", headers=AUTH,
                          json=dev(ip="192.168.10.206", group="", port=5555))
        assert two.status_code == 201
        # A generated serial must never target another saved device.
        conflict = client.put("/api/groups/Home", headers=AUTH,
                              json={"name": "Home", "ip_prefix": "192.168.10.*"})
        assert conflict.status_code == 409
        assert client.get("/api/groups", headers=AUTH).json()[0]["ip_prefix"] is None
        # Same conflict when creating a device in a group already having a prefix.
        assert client.post("/api/groups", headers=AUTH,
                           json={"name": "Lab", "ip_prefix": "192.168.20.*"}).status_code == 201
        assert client.post("/api/devices", headers=AUTH,
                           json=dev(ip="192.168.20.7", group="", port=5555)).status_code == 201
        assert client.post("/api/devices", headers=AUTH,
                           json=dev(ip="10.10.30.7", group="Lab", port=5555)).status_code == 409


def test_existing_m1_database_migrates_without_data_loss(tmp_path):
    dbfile = tmp_path / "legacy.sqlite3"
    with sqlite3.connect(dbfile) as db:
        db.execute("""CREATE TABLE devices (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, group_name TEXT NOT NULL DEFAULT '',
            ip TEXT NOT NULL, port INTEGER NOT NULL, auto_reconnect INTEGER NOT NULL DEFAULT 0,
            model TEXT, android_version TEXT, UNIQUE(ip,port))""")
        db.execute("""INSERT INTO devices VALUES
                   ('keep-id','Old Phone','Existing','10.10.30.206',5555,1,'Old Model','14')""")
    store = DeviceStore(str(dbfile))
    store.initialize()
    store.initialize()
    assert store.list_groups() == [{"name": "Existing", "ip_prefix": None}]
    assert store.get("keep-id")["mesh_ip"] == "10.10.30.206"
    assert store.get("keep-id")["lan_ip"] is None
    assert store.get("keep-id")["model"] == "Old Model"
    assert store.update_group("Existing", "Existing", "192.168.10.*")
    assert store.get("keep-id")["lan_ip"] == "192.168.10.206"
    assert internal_ip("192.168.10.*", "10.10.30.206") == "192.168.10.206"



def test_delete_group_moves_members_without_deleting_devices(monkeypatch, tmp_path):
    mod, online, blocked, calls = fixture(monkeypatch, tmp_path)
    with TestClient(mod.app) as client:
        mod.manager.stop()
        assert client.delete("/api/groups/Home").status_code == 401
        assert client.delete("/api/groups/DoesNotExist", headers=AUTH).status_code == 404

        assert client.post("/api/groups", headers=AUTH, json={
            "name": "Home", "ip_prefix": "192.168.10.*"
        }).status_code == 201
        assert client.post("/api/groups", headers=AUTH, json={
            "name": "Other", "ip_prefix": "192.168.11.*"
        }).status_code == 201
        a = client.post("/api/devices", headers=AUTH, json=dev()).json()
        b = client.post("/api/devices", headers=AUTH, json=dev(
            ip="10.10.30.207", group="Home")).json()
        other = client.post("/api/devices", headers=AUTH, json=dev(
            ip="10.10.30.208", group="Other")).json()
        assert client.post(f'/api/devices/{a["id"]}/connect', headers=AUTH).json()[
            "active_route"] == "lan"
        assert client.get(f'/api/devices/{a["id"]}/screenshot', headers=AUTH).status_code == 200
        calls_before = len(calls)

        deleted = client.delete("/api/groups/Home", headers=AUTH)
        assert deleted.status_code == 200
        assert deleted.json() == {"deleted": True, "moved_count": 2}
        # Deleting a group does not itself issue adb disconnect or any other ADB command.
        assert len(calls) == calls_before
        assert client.delete("/api/groups/Home", headers=AUTH).status_code == 404
        assert client.get("/api/groups", headers=AUTH).json() == [
            {"name": "Other", "ip_prefix": "192.168.11.*"}
        ]
        records = {d["id"]: d for d in client.get("/api/devices", headers=AUTH).json()}
        assert len(records) == 3
        for original in (a, b):
            moved = records[original["id"]]
            assert moved["group_name"] == ""
            assert moved["lan_ip"] is None
            assert moved["mesh_ip"] == original["mesh_ip"]
            assert moved["port"] == original["port"]
            assert moved["status"] == "checking"
            assert moved["active_serial"] is None
        assert records[other["id"]]["group_name"] == "Other"
        assert records[other["id"]]["lan_ip"] == "192.168.11.208"
        # The old LAN connection remains in ADB for other clients, but EasyADB
        # must no longer use it until a fresh probe picks the remaining mesh route.
        assert client.get(f'/api/devices/{a["id"]}/screenshot', headers=AUTH).status_code == 409
        mesh_route = client.post(f'/api/devices/{a["id"]}/connect', headers=AUTH).json()
        assert mesh_route["active_route"] == "mesh"
        assert mesh_route["active_serial"] == "10.10.30.206:5555"
        assert client.get(f'/api/devices/{a["id"]}/screenshot', headers=AUTH).content == (
            PNG + b"10.10.30.206:5555"
        )
        # Restart/migration should not resurrect the deleted group from old members.
        reloaded = DeviceStore(str(tmp_path / "devices.sqlite3"))
        reloaded.initialize()
        assert reloaded.list_groups() == [{"name": "Other", "ip_prefix": "192.168.11.*"}]


def test_delete_empty_group(monkeypatch, tmp_path):
    mod, online, blocked, calls = fixture(monkeypatch, tmp_path)
    with TestClient(mod.app) as client:
        mod.manager.stop()
        assert client.post("/api/groups", headers=AUTH, json={
            "name": "Empty", "ip_prefix": "192.168.20.*"
        }).status_code == 201
        r = client.delete("/api/groups/Empty", headers=AUTH)
        assert r.status_code == 200
        assert r.json() == {"deleted": True, "moved_count": 0}
        assert client.get("/api/groups", headers=AUTH).json() == []
