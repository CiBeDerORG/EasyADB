"""Live ownership guards for persisted device mutations."""
import threading

import pytest

from server.core.exceptions import DomainError
from server.devices import DeviceManager, selected_address
from server.m2_live import LiveRegistry
from server.services.device_service import delete_device_record, update_device_record
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


def reserve(sessions, device_id, session_id="live-old"):
    worker = ControlledSession(session_id)
    assert sessions.reserve(device_id, worker)
    assert sessions.starting(device_id, worker)
    assert sessions.running(device_id, worker)
    return worker


def payload(device, **changes):
    value = {key: device[key] for key in ("name", "group_name", "ip", "port")}
    value.update(changes)
    return value


def test_orphan_cleanup_does_not_masquerade_as_active_projection_for_port_edit(tmp_path):
    store, manager, registry, sessions, device = setup_device(tmp_path)
    worker = reserve(sessions, device["id"])
    assert not sessions.has_active_request(device["id"])

    updated = update_device_record(
        device["id"], lambda: payload(device, port=6000), store=store, manager=manager,
        display_lab=DummyLab(), live_registry=registry, session_manager=sessions,
    )

    assert updated["port"] == 6000
    assert updated["status"] == "idle"
    assert worker.stop_calls == 1
    assert registry.sessions[device["id"]] is worker
    assert not sessions.reserve(device["id"], ControlledSession("replacement"))


def test_active_page_blocks_port_edit_while_orphan_still_blocks_device_delete(tmp_path):
    store, manager, registry, sessions, device = setup_device(tmp_path)
    ticket = sessions.begin_request(device["id"], on_replaced=lambda: None, on_changed=lambda: None)
    assert sessions.publish_request(device["id"], ticket)
    worker = ControlledSession("live-owned")
    assert sessions.reserve_latest(device["id"], ticket, worker) == "reserved"
    assert sessions.starting(device["id"], worker)
    assert sessions.running(device["id"], worker)
    assert sessions.has_active_request(device["id"])

    with pytest.raises(DomainError, match="其他页面投屏") as error:
        update_device_record(
            device["id"], lambda: payload(device, port=6000), store=store, manager=manager,
            display_lab=DummyLab(), live_registry=registry, session_manager=sessions,
        )
    assert error.value.status_code == 409
    assert store.get(device["id"])["port"] == 5555

    sessions.finish_request(device["id"], ticket)
    assert not sessions.has_active_request(device["id"])
    with pytest.raises(DomainError) as delete_error:
        delete_device_record(
            device["id"], store=store, manager=manager, display_lab=DummyLab(),
            live_registry=registry,
        )
    assert delete_error.value.status_code == 409
    assert registry.sessions[device["id"]] is worker
