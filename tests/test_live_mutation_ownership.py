"""Port refreshes keep the logical device owner while stopping the old live stream."""
import threading

import pytest

from server.core.exceptions import DomainError
from server.devices import DeviceManager, selected_address
from server.m2_live import LiveRegistry
from server.services.device_service import delete_device_record, update_device_record
from server.services.group_discovery import run_group_scan
from server.services.session_manager import SessionManager
from server.store import DeviceStore


class DummyLab:
    @staticmethod
    def has_pending(_device_id):
        return False


class ControlledSession:
    def __init__(self, session_id):
        self.session_id = session_id
        self.finished = threading.Event()
        self.cleanup_complete = False
        self.peer_cleanup_complete = False
        self.stop_calls = 0

    def stop(self):
        self.stop_calls += 1

    def join(self, timeout=None):
        pass


def reserve(sessions, device_id, session_id="live-old"):
    worker = ControlledSession(session_id)
    assert sessions.reserve(device_id, worker)
    assert sessions.starting(device_id, worker)
    assert sessions.running(device_id, worker)
    return worker


def device_payload(device, **changes):
    value = {key: device[key] for key in ("name", "group_name", "ip", "port")}
    value.update(changes)
    return value


def setup_device(tmp_path):
    store = DeviceStore(str(tmp_path / "devices.sqlite3"))
    store.initialize()
    device = store.create({
        "name": "Phone", "group_name": "", "ip": "10.20.30.40", "port": 5555,
    })
    manager = DeviceManager(store, lambda *args, **kwargs: pytest.fail("mutation must not call adb"))
    manager._set_state(device["id"], "connected", serial=selected_address(device), route="mesh")
    registry = LiveRegistry()
    sessions = SessionManager(lambda: registry)
    return store, manager, registry, sessions, device


def test_port_only_edit_stops_old_live_but_keeps_its_slot_until_cleanup(tmp_path):
    store, manager, registry, sessions, device = setup_device(tmp_path)
    worker = reserve(sessions, device["id"])

    updated = update_device_record(
        device["id"], lambda: device_payload(device, port=6000),
        store=store, manager=manager, display_lab=DummyLab(), live_registry=registry,
    )

    assert updated["port"] == 6000
    assert updated["status"] == "idle"
    assert worker.stop_calls == 1
    assert registry.sessions[device["id"]] is worker
    assert not sessions.reserve(device["id"], ControlledSession("replacement"))

    # Anything beyond a pure shared-port change keeps the original fail-closed guard.
    with pytest.raises(DomainError) as error:
        update_device_record(
            device["id"], lambda: device_payload(store.get(device["id"]), name="Renamed"),
            store=store, manager=manager, display_lab=DummyLab(), live_registry=registry,
        )
    assert error.value.status_code == 409
    with pytest.raises(DomainError):
        delete_device_record(
            device["id"], store=store, manager=manager,
            display_lab=DummyLab(), live_registry=registry,
        )


class DiscoveryClient:
    def __init__(self, port):
        self.port = port

    def scan(self, _url, _username, _password):
        return {
            "status": "ok", "scanned_at": 1792400000,
            "devices": [{
                "instance": "adb-test", "iface": "br-lan",
                "address": "192.168.10.206", "port": self.port,
            }],
        }


def setup_discovery(tmp_path):
    store = DeviceStore(str(tmp_path / "discovery.sqlite3"))
    store.initialize()
    store.create_group("Home", "192.168.10.*")
    store.set_group_discovery(
        "Home", "http://10.10.10.2/ubus", "easyadb", "fixture-secret",
    )
    device = store.create({
        "name": "Phone", "group_name": "Home", "ip": "10.20.30.206", "port": 5555,
    })
    manager = DeviceManager(store, lambda *args, **kwargs: pytest.fail("scan must not call adb"))
    manager._set_state(device["id"], "connected", serial=selected_address(device), route="mesh")
    registry = LiveRegistry()
    sessions = SessionManager(lambda: registry)
    return store, manager, registry, sessions, device


def scan_port(store, manager, registry, port=6000):
    return run_group_scan(
        "Home", persist=True, test_config=None, store=store,
        discovery_client=DiscoveryClient(port), manager=manager,
        display_lab=DummyLab(), live_registry=registry,
        discovery_guard=threading.RLock(), discovery_locks={},
    )


def test_discovery_updates_port_even_when_adb_and_live_are_still_on_old_serial(tmp_path):
    store, manager, registry, sessions, device = setup_discovery(tmp_path)
    worker = reserve(sessions, device["id"])

    result = scan_port(store, manager, registry)

    assert result["updated"] == [{
        "id": device["id"], "ip": "192.168.10.206", "old_port": 5555, "port": 6000,
    }]
    assert result["busy"] == []
    assert store.get(device["id"])["port"] == 6000
    assert device["id"] not in manager.states
    assert manager.snapshot(store.get(device["id"]))["status"] == "idle"
    assert worker.stop_calls == 1
    assert registry.sessions[device["id"]] is worker
    assert not sessions.reserve(device["id"], ControlledSession("replacement"))
