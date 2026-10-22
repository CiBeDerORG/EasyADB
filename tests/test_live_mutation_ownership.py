"""Credential re-entry resets old live sessions before device work resumes."""
import threading

import pytest

from server.core.exceptions import DomainError
from server.devices import DeviceManager, selected_address
from server.m2_live import LiveRegistry
from server.services.group_discovery import run_group_scan
from server.services.live_reset import reset_live_sessions
from server.services.session_manager import SessionManager
from server.store import DeviceStore


class DummyLab:
    @staticmethod
    def has_pending(_device_id):
        return False


class ControlledSession:
    def __init__(self, session_id, clean_on_stop=True):
        self.session_id = session_id
        self.finished = threading.Event()
        self.cleanup_complete = False
        self.peer_cleanup_complete = False
        self.clean_on_stop = clean_on_stop
        self.stop_calls = 0
        self.join_calls = 0
        self.stop_event = threading.Event()

    def stop(self):
        self.stop_calls += 1
        self.stop_event.set()
        if self.clean_on_stop:
            self.cleanup_complete = True
            self.peer_cleanup_complete = True
            self.finished.set()

    def join(self, timeout=None):
        self.join_calls += 1


def reserve(sessions, device_id, session_id, clean_on_stop=True):
    worker = ControlledSession(session_id, clean_on_stop)
    assert sessions.reserve(device_id, worker)
    assert sessions.starting(device_id, worker)
    assert sessions.running(device_id, worker)
    return worker


def test_reset_revokes_published_and_unpublished_pre_reset_requests():
    registry = LiveRegistry()
    sessions = SessionManager(lambda: registry)
    callbacks = []
    published = sessions.begin_request("a", on_replaced=lambda: callbacks.append("a"), on_changed=None)
    unpublished = sessions.begin_request("b", on_replaced=lambda: callbacks.append("b"), on_changed=None)
    assert sessions.publish_request("a", published)

    assert sessions.revoke_all_requests("token_reset") == 1
    assert published.replaced.is_set() and published.replacement_reason == "token_reset"
    assert callbacks == ["a"]
    assert not sessions.publish_request("b", unpublished), "slow pre-reset validation cannot revive"

    fresh = sessions.begin_request("b", on_replaced=None, on_changed=None)
    assert sessions.publish_request("b", fresh), "a request created after reset may start normally"


def test_reset_stops_all_sessions_and_releases_only_verified_cleanup():
    registry = LiveRegistry()
    sessions = SessionManager(lambda: registry)
    one = reserve(sessions, "a", "one")
    two = reserve(sessions, "b", "two")

    result = reset_live_sessions(
        session_manager=sessions, live_registry=registry, timeout=0.1, poll_interval=0,
    )

    assert result == {"cleared": 2, "revoked_requests": 0, "remaining": 0}
    assert one.stop_calls == two.stop_calls == 1
    assert registry.sessions == {}
    assert sessions.snapshot("a")["phase"] == "released"
    assert sessions.snapshot("b")["phase"] == "released"


def test_reset_timeout_keeps_unclean_slot_fail_closed():
    registry = LiveRegistry()
    sessions = SessionManager(lambda: registry)
    worker = reserve(sessions, "a", "dirty", clean_on_stop=False)

    with pytest.raises(DomainError, match="1 路资源未完成清理") as error:
        reset_live_sessions(
            session_manager=sessions, live_registry=registry, timeout=0, poll_interval=0,
        )
    assert error.value.status_code == 409
    assert registry.sessions["a"] is worker
    assert worker.stop_calls == 1


class DiscoveryClient:
    def scan(self, _url, _username, _password):
        return {
            "status": "ok", "scanned_at": 1792400000,
            "devices": [{
                "instance": "adb-test", "iface": "br-lan",
                "address": "192.168.10.206", "port": 6000,
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


def scan_port(store, manager, registry):
    return run_group_scan(
        "Home", persist=True, test_config=None, store=store,
        discovery_client=DiscoveryClient(), manager=manager,
        display_lab=DummyLab(), live_registry=registry,
        discovery_guard=threading.RLock(), discovery_locks={},
    )


def test_discovery_updates_adb_connected_device_after_reset_without_auto_connect(tmp_path):
    store, manager, registry, _sessions, device = setup_discovery(tmp_path)
    result = scan_port(store, manager, registry)
    assert result["updated"] == [{
        "id": device["id"], "ip": "192.168.10.206", "old_port": 5555, "port": 6000,
    }]
    assert result["busy"] == []
    assert store.get(device["id"])["port"] == 6000
    assert device["id"] not in manager.states
    assert manager.snapshot(store.get(device["id"]))["status"] == "idle"


def test_discovery_still_blocks_real_unclean_live_session(tmp_path):
    store, manager, registry, sessions, device = setup_discovery(tmp_path)
    worker = reserve(sessions, device["id"], "live", clean_on_stop=False)
    result = scan_port(store, manager, registry)
    assert result["updated"] == []
    assert result["busy"] == [{"id": device["id"], "ip": "192.168.10.206"}]
    assert store.get(device["id"])["port"] == 5555
    assert worker.stop_calls == 0
