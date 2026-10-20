"""V2-07: WS admission, no hidden ADB, and available slot after verified stop."""
import importlib
import queue
import threading
from uuid import uuid4

from fastapi.testclient import TestClient

from server.devices import DeviceManager
from server.m2_live import LiveRegistry
from server.services.resource_budget import ScopedResourceBudget
from server.store import DeviceStore


AUTH = {"X-EasyADB-Token": "local-test-token-123"}


def next_kind(ws, kinds, count=30):
    for _ in range(count):
        value = ws.receive_json()
        if value["type"] in kinds:
            return value
    raise AssertionError("missing " + str(kinds))


def test_runtime_admission_limit_released_after_verified_stop(monkeypatch, tmp_path):
    monkeypatch.setenv("EASYADB_TOKEN", AUTH["X-EasyADB-Token"])
    app = importlib.import_module("server.app")
    store = DeviceStore(str(tmp_path / "admission.sqlite3"))
    manager = DeviceManager(store, lambda *a, **kw: (_ for _ in ()).throw(
        AssertionError("admission must not issue ADB commands")))
    monkeypatch.setattr(app, "store", store)
    monkeypatch.setattr(app, "manager", manager)
    monkeypatch.setattr(app, "live_registry", LiveRegistry())
    monkeypatch.setattr(app, "resource_budget",
                        ScopedResourceBudget(lambda: app.live_registry, max_starting=1))
    monkeypatch.setattr(app, "is_connected", lambda serial: True)

    class PendingStream:
        def __init__(self, serial, profile):
            self.serial = serial
            self.profile = profile
            self.session_id = str(uuid4())
            self.finished = threading.Event()
            self.cleanup_complete = False
            self.events = queue.Queue()
            self.webrtc_track = None
        def start(self): pass  # intentionally slow/no first video frame
        def stop(self):
            self.cleanup_complete = True
            self.finished.set()
        def join(self, timeout=20): self.finished.wait(timeout)
        def diagnostics(self): return {"stage": "waiting-keyframe"}
    monkeypatch.setattr(app, "LiveVideo", PendingStream)

    with TestClient(app.app) as client:
        devices = [client.post("/api/devices", headers=AUTH, json={
            "name": f"Phone {n}", "ip": f"10.40.0.{n}", "port": 5555
        }).json() for n in (1, 2)]
        for d in devices:
            manager._set_state(d["id"], "connected",
                               serial=d["selected_serial"], route="mesh")
        def connect(d):
            return client.websocket_connect(f"/api/devices/{d['id']}/m2/live",
                                            headers={"origin": "http://testserver"})
        def start(ws, d):
            ws.send_json({"token": AUTH["X-EasyADB-Token"], "player": "webrtc",
                          "selected_serial": d["selected_serial"], "profile": "baseline"})

        with connect(devices[0]) as first:
            start(first, devices[0])
            assert next_kind(first, {"starting"})["session_id"]
            assert app.resource_budget.snapshot()["starting"] == 1
            with connect(devices[1]) as second:
                start(second, devices[1])
                error = next_kind(second, {"error"})
                assert error["code"] == "start_budget_full"
                assert devices[1]["id"] not in app.live_registry.sessions or (
                    not app.live_registry.is_cleaned(app.live_registry.sessions[devices[1]["id"]]))
            first.send_text("stop")
            done = next_kind(first, {"ended", "error"})
            assert done["type"] == "ended" and done["cleanup_complete"]
        assert app.resource_budget.snapshot()["starting"] == 0
        with connect(devices[1]) as retry:
            start(retry, devices[1])
            assert next_kind(retry, {"starting"})["session_id"]
            retry.send_text("stop")
            assert next_kind(retry, {"ended", "error"})["type"] == "ended"
        assert app.resource_budget.snapshot()["starting"] == 0
