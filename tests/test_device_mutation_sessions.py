"""Record mutations must preserve live ownership until cleanup is verified.

Exercise the real HTTP adapters, services, SQLite store and session coordinator.
Only ADB and the worker's resource completion are controlled by this fixture.
"""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import importlib
import sqlite3
import threading
from types import SimpleNamespace

from fastapi.testclient import TestClient
import pytest

from server.devices import DeviceManager, selected_address
from server.display_lab import DisplayLab
from server.m2_live import LiveRegistry
from server.services.operations import device_lock
from server.services.session_manager import SessionManager
from server.store import DeviceStore


TOKEN = "local-test-token-123"
AUTH = {"X-EasyADB-Token": TOKEN}


class ControlledSession:
    def __init__(self, session_id):
        self.session_id = session_id
        self.finished = threading.Event()
        self.cleanup_complete = False
        self.peer_cleanup_complete = False
        self.stop_calls = 0
        self.join_calls = 0

    def stop(self):
        # A stop request is deliberately NOT a cleanup acknowledgment.
        self.stop_calls += 1

    def join(self, timeout=None):
        self.join_calls += 1

    def confirm_clean(self):
        self.cleanup_complete = True
        self.peer_cleanup_complete = True
        self.finished.set()


def payload(record, **changes):
    result = {key: record[key] for key in ("name", "group_name", "ip", "port")}
    result.update(changes)
    return result


def request(harness, operation):
    _, method, path, body = operation
    return harness.client.request(method, path, headers=AUTH, json=body)


def mutation_cases(harness):
    record = harness.store.get(harness.target_id)
    path = f"/api/devices/{harness.target_id}"
    return {
        "rename": ("rename", "PUT", path, payload(record, name="Renamed")),
        "update": ("update", "PUT", path, payload(record, ip="10.30.0.99")),
        "port": ("port", "PUT", path, payload(record, port=6000)),
        "membership": ("membership", "PUT", path, payload(record, group_name="Other")),
        "delete": ("delete", "DELETE", path, None),
        "route": ("route", "PUT", path + "/route", {"route": "mesh"}),
        "temp": ("temp", "PUT", path + "/temp-address", {"ip": "172.16.0.99", "port": 6001}),
        "remove_temp": ("remove_temp", "PUT", path + "/temp-address", {"ip": None}),
        "group_update": ("group_update", "PUT", "/api/groups/Home", {
            "name": "RenamedHome", "ip_prefix": "192.168.60.*",
        }),
        "group_delete": ("group_delete", "DELETE", "/api/groups/Home", None),
    }


def full_snapshot(harness):
    # Include credentials and discovery rows which group/delete operations can
    # otherwise remove even when a later live guard rejects the request.
    with sqlite3.connect(harness.store.path) as database:
        database_dump = tuple(database.iterdump())
    return {
        "database": database_dump,
        "cache": deepcopy(harness.manager.states),
        "registry": dict(harness.registry.sessions),
        "sessions": {
            device_id: harness.sessions.snapshot(device_id)
            for device_id in harness.session_device_ids
        },
        "workers": [
            (worker.finished.is_set(), worker.cleanup_complete,
             worker.peer_cleanup_complete, worker.stop_calls, worker.join_calls)
            for worker in harness.workers
        ],
        "adb": list(harness.adb_calls),
    }


def reserve(harness, device_id=None, phase="running"):
    device_id = device_id or harness.target_id
    worker = ControlledSession(f"session-{len(harness.workers)}")
    harness.workers.append(worker)
    harness.session_device_ids.add(device_id)
    # Match the lock order used by api.live_handler's reservation boundary.
    with device_lock(harness.manager, device_id):
        assert harness.sessions.reserve(device_id, worker)
        assert harness.sessions.starting(device_id, worker)
        if phase != "starting":
            assert harness.sessions.running(device_id, worker)
        if phase in ("cleaning", "dirty"):
            assert harness.sessions.cleaning(device_id, worker)
        if phase == "dirty":
            worker.finished.set()
            worker.cleanup_complete = True
            assert not harness.sessions.complete(device_id, worker, clean=False)
    assert harness.sessions.snapshot(device_id)["phase"] == phase
    return worker


@pytest.fixture
def harness(monkeypatch, tmp_path):
    monkeypatch.setenv("EASYADB_TOKEN", TOKEN)
    monkeypatch.setenv("EASYADB_DB", str(tmp_path / "devices.sqlite3"))
    module = importlib.import_module("server.app")
    adb_calls = []

    def unexpected_adb(*args, **kwargs):
        adb_calls.append((args, kwargs))
        raise AssertionError("Record mutation must not issue ADB commands")

    store = DeviceStore(str(tmp_path / "devices.sqlite3"))
    manager = DeviceManager(store, unexpected_adb)
    registry = LiveRegistry()
    sessions = SessionManager(lambda: registry)
    for name, value in {
        "TOKEN": TOKEN,
        "store": store,
        "manager": manager,
        "live_registry": registry,
        "session_manager": sessions,
        "display_lab": DisplayLab(unexpected_adb, tmp_path / "display-recovery.json"),
        "adb": unexpected_adb,
        "_discovery_guard": threading.RLock(),
        "_discovery_locks": {},
    }.items():
        monkeypatch.setattr(module, name, value)

    with TestClient(module.app) as client:
        for name, prefix in (("Home", "192.168.40.*"), ("Other", "192.168.50.*")):
            response = client.post("/api/groups", headers=AUTH,
                                   json={"name": name, "ip_prefix": prefix})
            assert response.status_code == 201
        records = []
        for name, group, octet in (("A idle", "Home", 11), ("Z target", "Home", 12),
                                   ("Unrelated", "Other", 13)):
            response = client.post("/api/devices", headers=AUTH, json={
                "name": name, "group_name": group, "ip": f"10.30.0.{octet}", "port": 5555,
            })
            assert response.status_code == 201
            device_id = response.json()["id"]
            assert client.put(f"/api/devices/{device_id}/temp-address", headers=AUTH,
                              json={"ip": f"172.16.0.{octet}"}).status_code == 200
            assert client.put(f"/api/devices/{device_id}/route", headers=AUTH,
                              json={"route": "lan"}).status_code == 200
            store.set_metadata(device_id, "Fixture phone", "15")
            record = store.get(device_id)
            manager._set_state(device_id, "connected", serial=selected_address(record), route="lan")
            records.append(record)
        # Real persisted ancillary data makes atomic group/delete assertions
        # sensitive to partial writes, not only the visible device list.
        store.save_unlock_secret(records[1]["id"], "1234")
        store.set_group_discovery("Home", "http://192.168.40.1/ubus", "easyadb", "fixture-secret")
        store.apply_group_discovery("Home", {"devices": [], "scanned_at": "fixture-scan"})
        assert not adb_calls
        yield SimpleNamespace(
            client=client, store=store, manager=manager, registry=registry, sessions=sessions,
            idle_id=records[0]["id"], target_id=records[1]["id"], outside_id=records[2]["id"],
            workers=[], session_device_ids=set(), adb_calls=adb_calls,
        )


@pytest.mark.parametrize("phase", ["starting", "running", "cleaning", "dirty"])
def test_busy_lifecycle_rejects_all_record_mutations_without_side_effects(harness, phase):
    worker = reserve(harness, phase=phase)
    before = full_snapshot(harness)
    for operation in mutation_cases(harness).values():
        response = request(harness, operation)
        assert response.status_code == 409, (phase, operation[0], response.text)
        assert "清理" in response.json()["detail"]
        assert full_snapshot(harness) == before, (phase, operation[0])
    assert harness.registry.sessions[harness.target_id] is worker
    assert worker.stop_calls == 0


@pytest.mark.parametrize("unconfirmed", ["finished", "cleanup_complete", "peer_cleanup_complete"])
def test_each_incomplete_production_cleanup_proof_keeps_mutations_blocked(harness, unconfirmed):
    worker = reserve(harness, phase="cleaning")
    worker.confirm_clean()
    if unconfirmed == "finished":
        worker.finished.clear()
    else:
        setattr(worker, unconfirmed, False)
    assert not harness.registry.is_cleaned(worker)
    before = full_snapshot(harness)
    for name in ("delete", "temp"):
        response = request(harness, mutation_cases(harness)[name])
        assert response.status_code == 409, (unconfirmed, name, response.text)
        assert full_snapshot(harness) == before


def test_dirty_delete_cannot_free_an_address_until_verified_cleanup(harness):
    worker = reserve(harness, phase="dirty")
    original = harness.store.get(harness.target_id)
    before = full_snapshot(harness)
    assert request(harness, mutation_cases(harness)["delete"]).status_code == 409
    # Every stored route must still reserve its serial, including derived LAN
    # and temporary addresses, so recreating a new ID cannot bypass DIRTY.
    for ip in (original["ip"], original["lan_ip"], original["temp_ip"]):
        response = harness.client.post("/api/devices", headers=AUTH,
                                       json=payload(original, name="Replacement", group_name="", ip=ip))
        assert response.status_code == 409, (ip, response.text)
        assert full_snapshot(harness) == before
    worker.confirm_clean()
    assert harness.sessions.late_cleanup(harness.target_id, worker)
    assert harness.sessions.snapshot(harness.target_id)["phase"] == "released"
    assert harness.target_id not in harness.registry.sessions
    assert request(harness, mutation_cases(harness)["delete"]).status_code == 200
    assert harness.target_id not in harness.manager.states
    assert not harness.store.unlock_configured(harness.target_id)
    rebuilt = harness.client.post("/api/devices", headers=AUTH, json=payload(original))
    assert rebuilt.status_code == 201
    replacement = rebuilt.json()
    assert replacement["id"] != harness.target_id
    assert replacement["ip"] == original["ip"] and replacement["port"] == original["port"]
    assert replacement["status"] == "idle"
    new_worker = reserve(harness, replacement["id"], phase="starting")
    assert harness.registry.sessions[replacement["id"]] is new_worker
    assert worker.stop_calls == 0 and not harness.adb_calls


def test_one_busy_member_rejects_whole_group_but_unrelated_operations_remain_available(harness):
    worker = reserve(harness, phase="dirty")
    before = full_snapshot(harness)
    for name in ("group_update", "group_delete"):
        assert request(harness, mutation_cases(harness)[name]).status_code == 409
        assert full_snapshot(harness) == before

    # The first (idle) member remains unchanged; the guard applies to the whole
    # operation, not a prefix of members encountered before the busy member.
    assert harness.store.get(harness.idle_id)["group_name"] == "Home"
    assert harness.client.post("/api/groups", headers=AUTH, json={
        "name": "New", "ip_prefix": "192.168.70.*",
    }).status_code == 201
    created = harness.client.post("/api/devices", headers=AUTH, json={
        "name": "New phone", "group_name": "New", "ip": "10.30.0.90", "port": 5555,
    })
    assert created.status_code == 201
    outside = harness.store.get(harness.outside_id)
    path = f"/api/devices/{harness.outside_id}"
    assert harness.client.put(path, headers=AUTH, json=payload(outside, port=6000)).status_code == 200
    assert harness.client.put(path + "/temp-address", headers=AUTH,
                              json={"ip": "172.16.0.90", "port": 6001}).status_code == 200
    assert harness.client.put(path + "/route", headers=AUTH, json={"route": "temp"}).status_code == 200
    assert harness.client.put("/api/groups/Other", headers=AUTH,
                              json={"name": "Elsewhere", "ip_prefix": "192.168.80.*"}).status_code == 200
    assert harness.client.delete("/api/groups/Elsewhere", headers=AUTH).status_code == 200
    assert harness.client.delete(path, headers=AUTH).status_code == 200
    assert harness.store.get(harness.target_id)["group_name"] == "Home"
    assert harness.manager.states[harness.target_id] == before["cache"][harness.target_id]
    assert harness.manager.states[harness.idle_id] == before["cache"][harness.idle_id]
    assert harness.sessions.snapshot(harness.target_id) == before["sessions"][harness.target_id]
    assert harness.registry.sessions[harness.target_id] is worker
    assert worker.stop_calls == 0 and not harness.adb_calls


def test_verified_clean_worker_retained_in_registry_allows_existing_success_paths(harness):
    worker = reserve(harness, phase="dirty")
    worker.confirm_clean()
    assert harness.registry.is_cleaned(worker)
    # Completion may precede the callback which retires the registry entry.
    # Resource proof, not merely the presence of an entry or a stale DIRTY label,
    # controls permission to mutate the record.
    for name in ("update", "temp", "route", "group_update"):
        response = request(harness, mutation_cases(harness)[name])
        assert response.status_code == 200, (name, response.text)
    assert harness.client.delete("/api/groups/RenamedHome", headers=AUTH).status_code == 200
    assert harness.client.delete(f"/api/devices/{harness.target_id}", headers=AUTH).status_code == 200
    assert harness.store.get(harness.target_id) is None
    assert harness.target_id not in harness.manager.states
    assert worker.stop_calls == 5
    assert harness.registry.sessions[harness.target_id] is worker
    assert not harness.adb_calls


WRITE_METHODS = {
    "update": "update",
    "delete": "delete",
    "route": "select_route",
    "temp": "set_temp_address",
    "group_update": "update_group",
    "group_delete": "delete_group",
}


@pytest.mark.parametrize("operation_name", WRITE_METHODS)
def test_live_reservation_cannot_enter_between_cleanup_check_and_write(harness, monkeypatch, operation_name):
    write_entered = threading.Event()
    allow_write = threading.Event()
    reservation_attempted = threading.Event()
    reservation_finished = threading.Event()
    timeline = []
    original_record = harness.store.get(harness.target_id)
    operation = mutation_cases(harness)[operation_name]
    write_method = WRITE_METHODS[operation_name]
    actual_write = getattr(harness.store, write_method)
    candidate = ControlledSession("concurrent-candidate")

    def paused_write(*args, **kwargs):
        write_entered.set()
        assert allow_write.wait(5), "Test did not release the paused SQLite write"
        result = actual_write(*args, **kwargs)
        timeline.append("write-committed")
        return result

    def reserve_after_lock():
        # api.live_handler acquires this same DeviceManager lock before its
        # final device lookup and SessionManager.reserve. No alternate mutex
        # or mocked registry is used by this contention test.
        reservation_attempted.set()
        with device_lock(harness.manager, harness.target_id):
            observed = harness.store.get(harness.target_id)
            reserved = observed is not None and harness.sessions.reserve(harness.target_id, candidate)
            timeline.append("live-checked")
            reservation_finished.set()
            return reserved, observed

    monkeypatch.setattr(harness.store, write_method, paused_write)
    with ThreadPoolExecutor(max_workers=2) as executor:
        mutation = executor.submit(request, harness, operation)
        try:
            assert write_entered.wait(5), "Mutation never reached the real store boundary"
            members = [harness.target_id]
            if operation_name.startswith("group_"):
                members.append(harness.idle_id)
            for device_id in members:
                mutex = device_lock(harness.manager, device_id)
                acquired = mutex.acquire(blocking=False)
                if acquired:
                    mutex.release()
                assert not acquired, "Mutation released a device lock before the write committed"
            reservation = executor.submit(reserve_after_lock)
            assert reservation_attempted.wait(5)
            assert not reservation_finished.is_set()
            assert not harness.registry.sessions
        finally:
            allow_write.set()
        response = mutation.result(timeout=5)
        reserved, observed = reservation.result(timeout=5)
    assert response.status_code == 200, response.text
    assert timeline == ["write-committed", "live-checked"]
    assert observed == harness.store.get(harness.target_id)
    assert observed != original_record
    if operation_name == "delete":
        assert observed is None and not reserved
        assert not harness.registry.sessions
    else:
        assert reserved and harness.registry.sessions[harness.target_id] is candidate
    assert candidate.stop_calls == 0 and not harness.adb_calls


@pytest.mark.parametrize("operation_name", ["update", "group_delete"])
def test_reservation_winning_device_lock_makes_later_mutation_fail_atomically(harness, monkeypatch, operation_name):
    reserved = threading.Event()
    release_reservation_lock = threading.Event()
    mutation_attempted_lock = threading.Event()
    actual_lock_factory = harness.manager._device_lock
    mutex = actual_lock_factory(harness.target_id)
    worker = ControlledSession("reservation-winner")
    harness.workers.append(worker)
    harness.session_device_ids.add(harness.target_id)
    operation = mutation_cases(harness)[operation_name]

    class ObservedLock:
        """Observe entry while delegating all synchronization to the real RLock."""
        def __enter__(self):
            mutation_attempted_lock.set()
            return mutex.__enter__()

        def __exit__(self, *args):
            return mutex.__exit__(*args)

    def observed_lock_factory(device_id):
        return ObservedLock() if device_id == harness.target_id else actual_lock_factory(device_id)

    def winning_reservation():
        with mutex:
            assert harness.sessions.reserve(harness.target_id, worker)
            assert harness.sessions.starting(harness.target_id, worker)
            reserved.set()
            assert release_reservation_lock.wait(5)

    monkeypatch.setattr(harness.manager, "_device_lock", observed_lock_factory)
    with ThreadPoolExecutor(max_workers=2) as executor:
        reservation = executor.submit(winning_reservation)
        try:
            assert reserved.wait(5)
            before = full_snapshot(harness)
            mutation = executor.submit(request, harness, operation)
            assert mutation_attempted_lock.wait(5)
            assert not mutation.done()
        finally:
            release_reservation_lock.set()
        reservation.result(timeout=5)
        response = mutation.result(timeout=5)
    assert response.status_code == 409, response.text
    assert full_snapshot(harness) == before
    assert harness.registry.sessions[harness.target_id] is worker
    assert worker.stop_calls == 0
