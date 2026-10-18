"""Manual mesh/LAN selection, no fallback, migration and group mutation tests."""
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
            ok = serial in online
            return subprocess.CompletedProcess(args, 0 if ok else 1, "device\n" if ok else "", "")
        if "getprop" in args:
            value = "Test Phone\n" if args[-1] == "ro.product.model" else "15\n"
            return subprocess.CompletedProcess(args, 0, value, "")
        if "screencap" in args:
            return subprocess.CompletedProcess(args, 0, PNG + args[2].encode(), b"")
        raise AssertionError(args)

    monkeypatch.setattr(module.subprocess, "run", fake_run)
    return module, online, blocked, calls


def dev(ip="10.10.30.206", group="Home", port=5555):
    return {"name": "Phone", "group_name": group, "ip": ip, "port": port}


def choose(client, device_id, route):
    return client.put(f"/api/devices/{device_id}/route", headers=AUTH, json={"route": route})


def test_explicit_route_selection_is_persistent_and_never_connects_automatically(monkeypatch, tmp_path):
    mod, online, blocked, calls = fixture(monkeypatch, tmp_path)
    lan, mesh = "192.168.10.206:5555", "10.10.30.206:5555"
    with TestClient(mod.app) as client:
        assert client.post("/api/groups", headers=AUTH, json={
            "name": "Home", "ip_prefix": "192.168.10.*"
        }).status_code == 201
        added = client.post("/api/devices", headers=AUTH, json=dev()).json()
        id_ = added["id"]
        assert added["selected_route"] == "mesh"
        assert added["selected_serial"] == mesh
        assert not calls
        assert client.put(f"/api/devices/{id_}/route", json={"route": "lan"}).status_code == 401
        assert choose(client, id_, "invalid").status_code == 400
        assert choose(client, "missing", "mesh").status_code == 404
        selected = choose(client, id_, "lan").json()
        assert selected["selected_route"] == "lan"
        assert selected["selected_serial"] == lan
        assert selected["status"] == "idle"
        assert not calls, "Switching must only persist; no get-state or connect"
        assert client.get(f"/api/devices/{id_}/screenshot", headers=AUTH).status_code == 409

        blocked.add(lan)
        failed = client.post(f"/api/devices/{id_}/connect", headers=AUTH)
        assert failed.status_code == 502
        assert [a[2] for a in calls if a[1] == "connect"] == [lan], "No fallback to mesh"
        assert client.get("/api/devices", headers=AUTH).json()[0]["selected_route"] == "lan"

        # Explicit refresh checks selected LAN address but must NOT connect.
        before = len([a for a in calls if a[1] == "connect"])
        assert client.post("/api/devices/refresh", headers=AUTH).status_code == 200
        assert len([a for a in calls if a[1] == "connect"]) == before
        # Explicit switch back to mesh is also persistence only.
        changed = choose(client, id_, "mesh").json()
        assert changed["selected_serial"] == mesh
        assert changed["active_serial"] is None
        assert changed["status"] == "idle"
        assert client.get(f"/api/devices/{id_}/screenshot", headers=AUTH).status_code == 409
        assert client.post(f"/api/devices/{id_}/connect", headers=AUTH).json()["active_serial"] == mesh
        assert [a[2] for a in calls if a[1] == "connect"] == [lan, mesh]
        assert client.get(f"/api/devices/{id_}/screenshot", headers=AUTH).content == PNG + mesh.encode()

    # Restart keeps the choice but never restores a stale "connected" state.
    reopened = DeviceStore(str(tmp_path / "devices.sqlite3"))
    reopened.initialize()
    assert reopened.get(id_)["selected_route"] == "mesh"
    mod2, online2, blocked2, calls2 = fixture(monkeypatch, tmp_path)
    with TestClient(mod2.app) as client:
        assert not calls2
        d = client.get("/api/devices", headers=AUTH).json()[0]
        assert d["selected_serial"] == mesh and d["status"] == "idle"
        assert not calls2


def test_switching_from_live_lan_invalidates_old_screenshot(monkeypatch, tmp_path):
    mod, online, blocked, calls = fixture(monkeypatch, tmp_path)
    with TestClient(mod.app) as client:
        client.post("/api/groups", headers=AUTH, json={"name": "Home", "ip_prefix": "192.168.10.*"})
        id_ = client.post("/api/devices", headers=AUTH, json=dev()).json()["id"]
        choose(client, id_, "lan")
        assert client.post(f"/api/devices/{id_}/connect", headers=AUTH).json()["active_route"] == "lan"
        assert client.get(f"/api/devices/{id_}/screenshot", headers=AUTH).content == PNG + b"192.168.10.206:5555"
        switched = choose(client, id_, "mesh").json()
        assert switched["selected_route"] == "mesh"
        assert switched["status"] == "idle"
        assert switched["active_serial"] is None
        assert client.get(f"/api/devices/{id_}/screenshot", headers=AUTH).status_code == 409
        before = len([a for a in calls if a[1] == "connect"])
        assert choose(client, id_, "lan").status_code == 200
        assert len([a for a in calls if a[1] == "connect"]) == before


def test_group_edit_and_delete_keep_route_selection_valid(monkeypatch, tmp_path):
    mod, online, blocked, calls = fixture(monkeypatch, tmp_path)
    with TestClient(mod.app) as client:
        client.post("/api/groups", headers=AUTH, json={"name": "Home", "ip_prefix": "192.168.10.*"})
        id_ = client.post("/api/devices", headers=AUTH, json=dev()).json()["id"]
        choose(client, id_, "lan")
        changed = client.put("/api/groups/Home", headers=AUTH, json={
            "name": "Office", "ip_prefix": "192.168.20.*"
        })
        assert changed.status_code == 200
        d = client.get("/api/devices", headers=AUTH).json()[0]
        assert d["selected_route"] == "lan"
        assert d["selected_serial"] == "192.168.20.206:5555"
        assert d["status"] == "idle"
        # Removing the LAN prefix resets selection to mesh, with no connection.
        assert client.put("/api/groups/Office", headers=AUTH, json={
            "name": "Office", "ip_prefix": None
        }).status_code == 200
        d = client.get("/api/devices", headers=AUTH).json()[0]
        assert d["selected_route"] == "mesh"
        assert d["lan_ip"] is None
        assert choose(client, id_, "lan").status_code == 409
        assert not calls
        # A group delete must preserve every device and use the mesh selection.
        client.put("/api/groups/Office", headers=AUTH, json={
            "name": "Office", "ip_prefix": "192.168.30.*"
        })
        choose(client, id_, "lan")
        result = client.delete("/api/groups/Office", headers=AUTH)
        assert result.json() == {"deleted": True, "moved_count": 1}
        d = client.get("/api/devices", headers=AUTH).json()[0]
        assert d["id"] == id_
        assert d["group_name"] == ""
        assert d["selected_route"] == "mesh"
        assert d["selected_serial"] == "10.10.30.206:5555"
        assert d["status"] == "idle"
        assert not calls
        assert client.delete("/api/groups/Office", headers=AUTH).status_code == 404


def test_prefix_validation_and_cross_device_serial_conflict(monkeypatch, tmp_path):
    mod, online, blocked, calls = fixture(monkeypatch, tmp_path)
    with TestClient(mod.app) as client:
        assert client.get("/api/groups").status_code == 401
        assert client.delete("/api/groups/Home").status_code == 401
        for invalid in ["192.168.10.0/24", "999.168.10.*", "192.168.*",
                        "192.168.10.206", "192.168.010.*"]:
            assert client.post("/api/groups", headers=AUTH,
                               json={"name": "Test", "ip_prefix": invalid}).status_code == 400
        assert client.post("/api/groups", headers=AUTH,
                           json={"name": "Home", "ip_prefix": None}).status_code == 201
        assert client.post("/api/devices", headers=AUTH, json=dev()).status_code == 201
        assert client.post("/api/devices", headers=AUTH, json=dev(
            ip="192.168.10.206", group="")).status_code == 201
        assert client.put("/api/groups/Home", headers=AUTH,
                          json={"name": "Home", "ip_prefix": "192.168.10.*"}).status_code == 409
        assert client.get("/api/groups", headers=AUTH).json()[0]["ip_prefix"] is None
        assert client.post("/api/groups", headers=AUTH,
                           json={"name": "Lab", "ip_prefix": "192.168.20.*"}).status_code == 201
        assert client.post("/api/devices", headers=AUTH, json=dev(
            ip="192.168.20.7", group="")).status_code == 201
        assert client.post("/api/devices", headers=AUTH, json=dev(
            ip="10.10.30.7", group="Lab")).status_code == 409
        assert not calls


def test_existing_m1_schema_migration_preserves_devices_and_disables_auto_retry(tmp_path):
    path = tmp_path / "legacy.sqlite3"
    with sqlite3.connect(path) as db:
        db.execute("""CREATE TABLE devices (
            id TEXT PRIMARY KEY,name TEXT NOT NULL,group_name TEXT NOT NULL DEFAULT '',
            ip TEXT NOT NULL,port INTEGER NOT NULL,auto_reconnect INTEGER NOT NULL DEFAULT 0,
            model TEXT,android_version TEXT,UNIQUE(ip,port))""")
        db.execute("""INSERT INTO devices VALUES
                   ('keep-id','Old Phone','Existing','10.10.30.206',5555,1,'Old Model','14')""")
    store = DeviceStore(str(path))
    store.initialize()
    store.initialize()
    d = store.get("keep-id")
    assert d["mesh_ip"] == "10.10.30.206"
    assert d["selected_route"] == "mesh" and d["lan_ip"] is None
    assert d["model"] == "Old Model" and "auto_reconnect" not in d
    assert store.list_groups() == [{"name": "Existing", "ip_prefix": None}]
    store.update_group("Existing", "Existing", "192.168.10.*")
    assert store.get("keep-id")["selected_route"] == "mesh"
    assert internal_ip("192.168.10.*", "10.10.30.206") == "192.168.10.206"
    store.select_route("keep-id", "lan")
    assert store.get("keep-id")["selected_route"] == "lan"
    assert DeviceStore(str(path)).get("keep-id")["selected_route"] == "lan"


def test_group_empty_delete_and_move_device_out_of_lan_group(monkeypatch, tmp_path):
    mod, online, blocked, calls = fixture(monkeypatch, tmp_path)
    with TestClient(mod.app) as client:
        client.post("/api/groups", headers=AUTH, json={"name": "Empty", "ip_prefix": "192.168.30.*"})
        assert client.delete("/api/groups/Empty", headers=AUTH).json() == {"deleted": True, "moved_count": 0}
        client.post("/api/groups", headers=AUTH, json={"name": "Home", "ip_prefix": "192.168.10.*"})
        id_ = client.post("/api/devices", headers=AUTH, json=dev()).json()["id"]
        choose(client, id_, "lan")
        out = client.put(f"/api/devices/{id_}", headers=AUTH, json=dev(group=""))
        assert out.status_code == 200
        assert out.json()["selected_route"] == "mesh"
        assert out.json()["lan_ip"] is None
        assert not calls
