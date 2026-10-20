"""Focused V1 foundation tests: startup boundaries and operation lock ordering."""
import importlib
from concurrent.futures import ThreadPoolExecutor
import threading

import pytest

from server.core.config import load_settings
from server.core.runtime import build_runtime
from server.devices import DeviceManager
from server.m2_live import LiveRegistry
from server.services.operations import device_locks
from server.store import DeviceStore


TOKEN = "local-test-token-123"


def test_settings_validate_without_importing_app(tmp_path):
    base = {"EASYADB_TOKEN": TOKEN, "EASYADB_DB": str(tmp_path / "data.sqlite3")}
    settings = load_settings(base)
    assert settings.token == TOKEN
    assert settings.db_path == str(tmp_path / "data.sqlite3")
    assert settings.video_engine == "webrtc"
    assert load_settings({**base, "EASYADB_VIDEO_ENGINE": " WEBRTC "}).video_engine == "webrtc"
    with pytest.raises(RuntimeError, match="EASYADB_VIDEO_ENGINE"):
        load_settings({**base, "EASYADB_VIDEO_ENGINE": "unknown"})
    with pytest.raises(RuntimeError, match="EASYADB_TOKEN"):
        load_settings({"EASYADB_TOKEN": "short"})
    with pytest.raises(RuntimeError, match="EASYADB_TOKEN"):
        load_settings({"EASYADB_TOKEN": "REPLACE_WITH_RANDOM_LONG_TOKEN"})


def test_runtime_composition_has_no_eager_db_creation_or_adb(tmp_path):
    db_path = tmp_path / "runtime.sqlite3"
    calls = []

    def adb(*args, **kwargs):
        calls.append((args, kwargs))
        raise AssertionError("composition must never run an adb command")

    runtime = build_runtime(str(db_path), adb)
    assert runtime.store.path == db_path
    assert runtime.manager.store is runtime.store
    assert runtime.manager.adb is adb
    assert isinstance(runtime.live_registry, LiveRegistry)
    assert not calls and not db_path.exists()


def test_multi_device_locks_are_sorted_and_unique():
    acquired = []

    class Tracked:
        def __init__(self, name):
            self.name = name

        def __enter__(self):
            acquired.append(self.name)

        def __exit__(self, *unused):
            acquired.append("exit:" + self.name)

    class Manager:
        def _device_lock(self, key):
            return Tracked(key)

    with device_locks(Manager(), ["z", "b", "a", "b"]):
        assert acquired == ["a", "b", "z"]
    assert acquired == ["a", "b", "z", "exit:z", "exit:b", "exit:a"]


@pytest.mark.parametrize("action", ["update", "delete"])
def test_mutation_waits_for_existing_device_operation(monkeypatch, tmp_path, action):
    """Hold the connect/live per-device lock: mutation must not enter store."""
    monkeypatch.setenv("EASYADB_TOKEN", TOKEN)
    mod = importlib.import_module("server.app")
    store = DeviceStore(str(tmp_path / "devices.sqlite3"))
    store.initialize()
    manager = DeviceManager(store, lambda *a, **kw: pytest.fail("no adb allowed"))
    monkeypatch.setattr(mod, "store", store)
    monkeypatch.setattr(mod, "manager", manager)
    monkeypatch.setattr(mod, "live_registry", LiveRegistry())
    data = {"ip": "10.20.30.40", "port": 5555, "name": "Phone", "group_name": ""}
    did = store.create(data)["id"]
    entered = threading.Event()
    started = threading.Event()
    original = getattr(store, action)

    def watch_store(*args, **kwargs):
        entered.set()
        return original(*args, **kwargs)

    monkeypatch.setattr(store, action, watch_store)

    def mutate():
        started.set()
        if action == "update":
            return mod.update_device(
                did, mod.DeviceInput(**{**data, "name": "Renamed"}))
        return mod.delete_device(did)

    with ThreadPoolExecutor(max_workers=1) as pool:
        with manager._device_lock(did):
            work = pool.submit(mutate)
            assert started.wait(2)
            assert not entered.wait(0.2), "DB mutation bypassed the device lock"
        result = work.result(timeout=3)
    assert entered.is_set()
    if action == "update":
        assert result["name"] == "Renamed"
        assert store.get(did)["name"] == "Renamed"
    else:
        assert result == {"deleted": True}
        assert store.get(did) is None


def test_group_edit_and_delete_reject_an_inflight_scan(monkeypatch, tmp_path):
    """A group may not be renamed/deleted while an explicit RPCD scan owns it."""
    from fastapi.testclient import TestClient

    monkeypatch.setenv("EASYADB_TOKEN", TOKEN)
    mod = importlib.import_module("server.app")
    store = DeviceStore(str(tmp_path / "groups.sqlite3"))
    monkeypatch.setattr(mod, "store", store)
    monkeypatch.setattr(mod, "manager", DeviceManager(store, lambda *a, **kw: pytest.fail("no adb")))
    monkeypatch.setattr(mod, "_discovery_locks", {})
    with TestClient(mod.app) as client:
        auth = {"X-EasyADB-Token": TOKEN}
        assert client.post("/api/groups", headers=auth,
                           json={"name": "Home", "ip_prefix": "192.168.1.*"}).status_code == 201
        scan_mutex = threading.Lock()
        scan_mutex.acquire()
        mod._discovery_locks["Home"] = scan_mutex
        try:
            edited = client.put("/api/groups/Home", headers=auth,
                                json={"name": "Renamed", "ip_prefix": "192.168.2.*"})
            removed = client.delete("/api/groups/Home", headers=auth)
            assert edited.status_code == removed.status_code == 409
            assert store.get_group("Home") is not None
            assert store.get_group("Renamed") is None
        finally:
            scan_mutex.release()
        assert client.put("/api/groups/Home", headers=auth,
                          json={"name": "Renamed", "ip_prefix": "192.168.2.*"}).status_code == 200


def test_group_edit_waits_for_member_device_lock(monkeypatch, tmp_path):
    """Group prefix/route mutations cannot bypass an in-flight device operation."""
    monkeypatch.setenv("EASYADB_TOKEN", TOKEN)
    mod = importlib.import_module("server.app")
    store = DeviceStore(str(tmp_path / "groups.sqlite3"))
    store.initialize()
    store.create_group("Home", "192.168.1.*")
    did = store.create({"name": "P", "group_name": "Home",
                        "ip": "10.10.10.10", "port": 5555})["id"]
    manager = DeviceManager(store, lambda *a, **kw: pytest.fail("no adb"))
    monkeypatch.setattr(mod, "store", store)
    monkeypatch.setattr(mod, "manager", manager)
    monkeypatch.setattr(mod, "_discovery_locks", {})
    entered = threading.Event()
    started = threading.Event()
    original = store.update_group

    def watch(*args, **kwargs):
        entered.set()
        return original(*args, **kwargs)

    monkeypatch.setattr(store, "update_group", watch)

    def mutate():
        started.set()
        return mod.update_group("Home", mod.GroupInput(name="Home", ip_prefix="192.168.2.*"))

    with ThreadPoolExecutor(max_workers=1) as pool:
        with manager._device_lock(did):
            job = pool.submit(mutate)
            assert started.wait(2)
            assert not entered.wait(0.2), "group mutation must wait for member's device lock"
        result = job.result(timeout=3)
    assert entered.is_set()
    assert result["ip_prefix"] == "192.168.2.*"


def test_explicit_lifespan_initializes_once_and_stops_existing_sessions():
    import asyncio
    from server.core.lifecycle import managed_resources

    events = []

    class Store:
        def initialize(self):
            events.append("initialize")

    class Registry:
        def stop_all(self):
            events.append("stop_all")

    async def check():
        async with managed_resources(lambda: (Store(), Registry())):
            assert events == ["initialize"]
        assert events == ["initialize", "stop_all"]

    asyncio.run(check())


def test_group_discovery_validates_group_only_after_acquiring_operation_mutex():
    from server.core.exceptions import DomainError
    from server.services.group_discovery import run_group_scan

    mutex = threading.Lock()

    class Store:
        def get_group(self, name):
            assert mutex.locked(), "group state may not be read before scan ownership"
            return None

    with pytest.raises(DomainError) as exc:
        run_group_scan(
            "Home", persist=True, test_config=None, store=Store(), discovery_client=None,
            manager=None, display_lab=None, live_registry=None,
            discovery_guard=threading.RLock(), discovery_locks={"Home": mutex},
        )
    assert exc.value.status_code == 404
    assert not mutex.locked()


def test_unrelated_device_update_is_not_blocked_by_other_device_lock(monkeypatch, tmp_path):
    """A connected/live operation on A must not serialize an ordinary edit on B."""
    monkeypatch.setenv("EASYADB_TOKEN", TOKEN)
    mod = importlib.import_module("server.app")
    store = DeviceStore(str(tmp_path / "parallel.sqlite3"))
    store.initialize()
    manager = DeviceManager(store, lambda *a, **kw: pytest.fail("no ADB allowed"))
    monkeypatch.setattr(mod, "store", store)
    monkeypatch.setattr(mod, "manager", manager)
    monkeypatch.setattr(mod, "live_registry", LiveRegistry())
    a = store.create({"name": "A", "group_name": "", "ip": "10.2.0.1", "port": 5555})
    b = store.create({"name": "B", "group_name": "", "ip": "10.2.0.2", "port": 5555})
    update = mod.DeviceInput(name="B2", group_name="", ip="10.2.0.2", port=5555)

    with ThreadPoolExecutor(max_workers=1) as pool:
        with manager._device_lock(a["id"]):
            future = pool.submit(mod.update_device, b["id"], update)
            result = future.result(timeout=2)
            assert result["name"] == "B2", "unrelated device may not wait for A"
    assert store.get(a["id"])["name"] == "A"
    assert store.get(b["id"])["name"] == "B2"


def test_runtime_preserves_an_existing_sqlite_database(tmp_path):
    """V1 composition may initialize an existing DB but never replace its data."""
    path = tmp_path / "existing.sqlite3"
    before = DeviceStore(str(path))
    before.initialize()
    saved = before.create({"name": "Persist", "group_name": "",
                           "ip": "10.7.7.7", "port": 5555})
    runtime = build_runtime(str(path), lambda *a, **kw: pytest.fail("no ADB on startup"))
    runtime.store.initialize()
    assert runtime.store.get(saved["id"])["name"] == "Persist"
    assert runtime.store.get(saved["id"])["ip"] == "10.7.7.7"


def test_v2_rejects_removed_mse_and_webcodecs_settings_without_fallback(tmp_path):
    for retired in ("mse", "webcodecs"):
        with pytest.raises(RuntimeError, match="only supports"):
            load_settings({"EASYADB_TOKEN": TOKEN, "EASYADB_DB": str(tmp_path / "a.sqlite3"),
                           "EASYADB_VIDEO_ENGINE": retired})
    assert load_settings({"EASYADB_TOKEN": TOKEN}).video_engine == "webrtc"
