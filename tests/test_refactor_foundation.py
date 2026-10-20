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
    assert settings.video_engine == "mse"
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
