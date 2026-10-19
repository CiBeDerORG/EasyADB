"""Regression: selected devices do not serialize behind a global ADB lock."""
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Lock
from types import SimpleNamespace

from server.devices import DeviceManager


class Store:
    def __init__(self):
        self.rows = {str(i): {
            "id": str(i), "name": "Device " + str(i),
            "selected_route": "mesh", "mesh_ip": "10.10.0." + str(i),
            "port": 5555, "model": "Model", "android_version": "14",
        } for i in (1, 2)}
    def get(self, key):
        row = self.rows.get(key)
        return row.copy() if row else None


def test_two_explicit_connects_run_simultaneously_in_independent_workers():
    rendezvous = Barrier(2)
    connected = set()
    guard = Lock()
    calls = []

    def adb(*args, timeout=None):
        if args[0] == "-s" and args[2] == "get-state":
            with guard:
                ready = args[1] in connected
            return SimpleNamespace(returncode=0 if ready else 1,
                                   stdout="device" if ready else "offline")
        assert args[0] == "connect" and args[1] in ("10.10.0.1:5555", "10.10.0.2:5555")
        with guard:
            calls.append(args[1])
        # A serialized/global ADB lock makes this barrier time out and FAIL.
        rendezvous.wait(timeout=3)
        with guard:
            connected.add(args[1])
        return SimpleNamespace(returncode=0, stdout="connected")

    manager = DeviceManager(Store(), adb)
    with ThreadPoolExecutor(max_workers=2) as pool:
        a = pool.submit(manager.probe, "1", True)
        b = pool.submit(manager.probe, "2", True)
        first, second = a.result(timeout=5), b.result(timeout=5)
    assert first["status"] == second["status"] == "connected"
    assert first["active_serial"] == "10.10.0.1:5555"
    assert second["active_serial"] == "10.10.0.2:5555"
    assert len(calls) == 2
