"""ADB waits are per device; recovery persistence remains atomic and durable."""
from concurrent.futures import ThreadPoolExecutor
import importlib
import json
import os
from pathlib import Path
import threading
from types import SimpleNamespace

from fastapi.testclient import TestClient
import pytest

from server.castplus_lab import CastError
from server.devices import DeviceManager
from server.display_lab import DisplayLab, LabError, OVERLAY
from server.m2_live import LiveRegistry
from server.store import DeviceStore
from test_castplus_lab import FakeADB as CastADB


A = "10.0.0.11:5555"
B = "10.0.0.12:5555"
AUTH = {"X-EasyADB-Token": "local-test-token-123"}


class ControlledADB:
    """Compose the existing Cast+ device fake with overlay state and an ADB gate."""
    def __init__(self):
        self.devices = {}
        self.overlays = {}
        self.calls = []
        self.guard = threading.Lock()
        self.gate = None

    def device(self, serial):
        if serial not in self.devices:
            device = CastADB()
            device.serial = serial
            self.devices[serial] = device
            self.overlays[serial] = "null"
        return self.devices[serial]

    def pause(self, serial, command=None):
        gate = SimpleNamespace(serial=serial, command=command, used=False,
                               entered=threading.Event(), release=threading.Event())
        self.gate = gate
        return gate

    def __call__(self, *args, timeout=12):
        assert args[0] == "-s"
        serial, command = args[1], args[2:]
        with self.guard:
            self.calls.append(args)
            device = self.device(serial)
            gate = self.gate
            should_pause = (gate is not None and not gate.used and gate.serial == serial
                            and (gate.command is None or gate.command == command))
            if should_pause:
                gate.used = True
        if should_pause:
            gate.entered.set()
            assert gate.release.wait(10), "Test did not release the controlled ADB command"
        if command == ("get-state",):
            value = "device"
        elif command == ("shell", "settings", "get", "global", "overlay_display_devices"):
            value = self.overlays[serial]
        elif command[:5] == ("shell", "settings", "put", "global", "overlay_display_devices"):
            self.overlays[serial] = command[5]
            value = ""
        elif command == ("shell", "settings", "delete", "global", "overlay_display_devices"):
            self.overlays[serial] = "null"
            value = ""
        else:
            return device(*args, timeout=timeout)
        return SimpleNamespace(returncode=0, stdout=value, stderr="")


def make_lab(tmp_path):
    adb = ControlledADB()
    lab = DisplayLab(adb, tmp_path / "display-lab.json")
    lab.cast_apk.write_bytes(b"test APK; no actual installation")
    adb.device(A)
    adb.device(B)
    return adb, lab


@pytest.mark.parametrize("operation", [
    "environment", "enable_overlay", "restore", "cast_create", "cast_auto",
    "cast_switch", "cast_verify", "cast_restore",
])
def test_slow_device_does_not_block_other_device_state_or_experiments(tmp_path, operation):
    adb, lab = make_lab(tmp_path)
    if operation == "restore":
        lab.enable_overlay("A", A)
    elif operation == "cast_restore":
        lab.cast_auto("A", A)
    elif operation == "cast_switch":
        adb.device(A).running = True
    gate = adb.pause(A)

    def operate_on_b():
        assert not lab.has_pending("B")
        assert lab.state("B")["pending_restore"] is None
        result = lab.enable_overlay("B", B)
        assert result["pending_restore"]["serial"] == B
        assert lab.has_pending("B")
        assert lab.state("B")["pending_restore"]["applied"] == OVERLAY
        assert lab.restore("B", B)["restored"] == "null"
        assert not lab.has_pending("B")

    with ThreadPoolExecutor(max_workers=2) as executor:
        blocked = executor.submit(getattr(lab, operation), "A", A)
        try:
            assert gate.entered.wait(5)
            executor.submit(operate_on_b).result(timeout=5)
            assert not blocked.done(), "A must still be waiting while B completes"
            assert not gate.release.is_set()
        finally:
            gate.release.set()
        assert isinstance(blocked.result(timeout=5), dict)
    assert adb.overlays[B] == "null"


def test_overlay_and_cast_operations_on_same_device_remain_serialized(tmp_path, monkeypatch):
    adb, lab = make_lab(tmp_path)
    gate = adb.pause(A)
    second_attempted = threading.Event()
    operation_context = threading.local()
    actual_lock_factory = lab._device_lock

    class ObservedLock:
        def __init__(self, mutex):
            self.mutex = mutex

        def __enter__(self):
            second_attempted.set()
            return self.mutex.__enter__()

        def __exit__(self, *args):
            return self.mutex.__exit__(*args)

    def observe_second_operation(device_id):
        mutex = actual_lock_factory(device_id)
        return ObservedLock(mutex) if getattr(operation_context, "observe", False) else mutex

    monkeypatch.setattr(lab, "_device_lock", observe_second_operation)

    def verify_after_overlay():
        operation_context.observe = True
        return lab.cast_verify("A", A)

    with ThreadPoolExecutor(max_workers=2) as executor:
        overlay = executor.submit(lab.enable_overlay, "A", A)
        try:
            assert gate.entered.wait(5)
            mutex = lab._device_lock("A")
            acquired = mutex.acquire(blocking=False)
            if acquired:
                mutex.release()
            assert not acquired, "A's ADB command must own its real per-device lock"
            calls_before = list(adb.calls)
            verification = executor.submit(verify_after_overlay)
            assert second_attempted.wait(5)
            assert not verification.done()
            assert adb.calls == calls_before
        finally:
            gate.release.set()
        assert overlay.result(timeout=5)["pending_restore"]["serial"] == A
        assert "pc_mode_evidence" in verification.result(timeout=5)
    assert lab.has_pending("A") and adb.overlays[A] == OVERLAY


@pytest.mark.parametrize("kind", ("overlay", "castplus"))
def test_concurrent_recovery_records_survive_failure_and_restart(tmp_path, monkeypatch, kind):
    adb, lab = make_lab(tmp_path)
    castplus = kind == "castplus"
    enable = lab.cast_auto if castplus else lab.enable_overlay
    restore = lab.cast_restore if castplus else lab.restore
    field = "pending_castplus" if castplus else "pending_restore"
    path = lab.cast_path if castplus else lab.path
    error = CastError if castplus else LabError
    command = (("shell", "settings", "put", "secure", "selected-proj-mode", "1")
               if castplus else ("shell", "settings", "put", "global", "overlay_display_devices", OVERLAY))
    # A has already persisted its recovery record when its device write waits.
    # B must commit a combined snapshot while A remains in progress.
    gate = adb.pause(A, command)
    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(enable, "A", A)
        try:
            assert gate.entered.wait(5)
            result_b = executor.submit(enable, "B", B).result(timeout=5)
            assert not first.done()
            assert set(json.loads(path.read_text())) == {"A", "B"}
            reopened = DisplayLab(adb, lab.path)
            assert reopened.has_pending("A") and reopened.has_pending("B")
            assert reopened.state("A")[field]["serial"] == A
            assert reopened.state("B")[field]["serial"] == B
        finally:
            gate.release.set()
        first.result(timeout=5)

    # Returned state and method results cannot mutate the live recovery owner.
    result_b[field]["serial"] = "changed result"
    returned_state = lab.state("B")
    returned_state[field]["serial"] = "changed state"
    assert lab.state("B")[field]["serial"] == B
    original_records = json.loads(path.read_text())
    actual_replace = os.replace
    failed = threading.Event()

    def fail_only_a_removal(source, destination):
        if Path(destination) == path and not failed.is_set():
            proposed = json.loads(Path(source).read_text())
            if "A" not in proposed:
                failed.set()
                raise OSError("controlled storage failure")
        return actual_replace(source, destination)

    monkeypatch.setattr(os, "replace", fail_only_a_removal)
    with pytest.raises(error, match="落盘失败"):
        restore("A", A)
    assert failed.is_set()
    assert json.loads(path.read_text()) == original_records
    assert lab.state("A")[field] == original_records["A"]
    assert lab.state("B")[field] == original_records["B"]
    # B can still finish and persist after A's failed deletion. A's record
    # remains retryable on restart even though its device was already restored.
    restore("B", B)
    assert json.loads(path.read_text()) == {"A": original_records["A"]}
    restarted = DisplayLab(adb, lab.path)
    assert restarted.has_pending("A") and not restarted.has_pending("B")
    restarted_restore = restarted.cast_restore if castplus else restarted.restore
    assert restarted_restore("A", A)["restored"] == ("0" if castplus else "null")
    assert json.loads(path.read_text()) == {}
    assert not DisplayLab(adb, lab.path).has_pending("A")


def test_slow_lab_api_does_not_make_other_edit_hold_membership_and_block_create(tmp_path, monkeypatch):
    monkeypatch.setenv("EASYADB_TOKEN", AUTH["X-EasyADB-Token"])
    module = importlib.import_module("server.app")
    adb, lab = make_lab(tmp_path)
    store = DeviceStore(str(tmp_path / "devices.sqlite3"))
    manager = DeviceManager(store, adb)
    for name, value in {
        "TOKEN": AUTH["X-EasyADB-Token"], "store": store, "manager": manager,
        "display_lab": lab, "adb": adb, "live_registry": LiveRegistry(),
    }.items():
        monkeypatch.setattr(module, name, value)
    with TestClient(module.app) as client:
        devices = []
        for name, ip in (("A", "10.0.0.11"), ("B", "10.0.0.12")):
            response = client.post("/api/devices", headers=AUTH, json={
                "name": name, "ip": ip, "port": 5555,
            })
            assert response.status_code == 201
            device = response.json()
            manager._set_state(device["id"], "connected", serial=ip + ":5555", route="mesh")
            devices.append(device)
        gate = adb.pause(A, ("shell", "getprop", "ro.build.version.sdk"))
        edit_entered_guard = threading.Event()
        actual_has_pending = lab.has_pending

        def observe_b_guard(device_id):
            if device_id == devices[1]["id"]:
                edit_entered_guard.set()
            return actual_has_pending(device_id)

        monkeypatch.setattr(lab, "has_pending", observe_b_guard)
        with ThreadPoolExecutor(max_workers=3) as executor:
            environment = executor.submit(
                client.post, f"/api/devices/{devices[0]['id']}/display-lab/environment", headers=AUTH)
            try:
                assert gate.entered.wait(5)
                edit = executor.submit(client.put, f"/api/devices/{devices[1]['id']}", headers=AUTH,
                                       json={"name": "B edited", "ip": "10.0.0.12", "port": 5555})
                assert edit_entered_guard.wait(5)
                create = executor.submit(client.post, "/api/devices", headers=AUTH,
                                         json={"name": "C", "ip": "10.0.0.13", "port": 5555})
                assert edit.result(timeout=5).status_code == 200
                assert create.result(timeout=5).status_code == 201
                assert not environment.done() and not gate.release.is_set()
                assert store.get(devices[1]["id"])["name"] == "B edited"
                assert len(store.list()) == 3
            finally:
                gate.release.set()
            response = environment.result(timeout=5)
            assert response.status_code == 200, response.text
