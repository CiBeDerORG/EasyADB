"""Real LiveVideo finalization and SessionManager after bounded WS cleanup.

Only ADB/process/socket boundaries are fake. The worker thread, finally path,
cleanup proofs, registry capacity and coordinator transitions are production.
"""
import asyncio
import importlib
import threading

import pytest

from server import m2_live
from server.m2_live import LiveRegistry, LiveVideo
from server.services.session_cleanup import cleanup_live_session
from server.services.session_manager import SessionManager


class ClosedPeer:
    async def close(self):
        pass


class FailedPeer:
    async def close(self):
        raise RuntimeError("mock peer still owns its transport")


@pytest.fixture
def runtime(monkeypatch, tmp_path):
    # Match the existing app fixture token: importing app initializes settings
    # once, and this regression may be collected before the legacy ASGI tests.
    monkeypatch.setenv("EASYADB_TOKEN", "local-test-token-123")
    app = importlib.import_module("server.app")
    registry = LiveRegistry()
    manager = SessionManager(lambda: registry)
    monkeypatch.setattr(app, "session_manager", manager)
    jar = tmp_path / "fake-scrcpy.jar"
    jar.write_bytes(b"not executed")
    workers = []
    controls = {}

    class Process:
        pid = None
        def __init__(self, *args, **kwargs):
            self.exited = False
        def poll(self):
            return 0 if self.exited else None
        def terminate(self):
            self.exited = True
        def kill(self):
            self.exited = True
        def wait(self, timeout):
            assert self.exited
            return 0

    def adb(serial, *args, **kwargs):
        control = controls[serial]
        control["commands"].append(args)
        if args[0] == "push":
            return "pushed"
        if args[:2] == ("forward", "tcp:0"):
            return "38523"
        if args[:2] == ("forward", "--remove"):
            control["entered"].set()
            assert control["release"].wait(5), "test did not release mock cleanup"
            if control["failure"] == "forward":
                raise m2_live.VideoProbeError("mock forward removal failed")
            return ""
        if args[:3] == ("shell", "rm", "-f"):
            if control["failure"] == "remote":
                raise m2_live.VideoProbeError("mock remote jar removal failed")
            return ""
        raise AssertionError(args)

    def stop_before_socket(*args, **kwargs):
        raise m2_live.VideoProbeError("mock media ended")

    monkeypatch.setattr(m2_live, "_run_adb", adb)
    monkeypatch.setattr(m2_live.subprocess, "Popen", Process)
    monkeypatch.setattr(m2_live, "_connect_forwarded", stop_before_socket)

    def make_worker(device_id, failure=None):
        serial = f"{device_id}:5555"
        controls[serial] = {"entered": threading.Event(), "release": threading.Event(),
                            "failure": failure, "commands": []}
        stream = LiveVideo(serial, "baseline", server_file=jar)
        stream.peer_cleanup_complete = False
        assert manager.reserve(device_id, stream)
        manager.starting(device_id, stream)
        manager.running(device_id, stream)
        workers.append(stream)
        stream.start()
        assert controls[serial]["entered"].wait(1)
        return stream, controls[serial]

    async def cleanup(device_id, stream, *, peer=None, callback=None):
        manager.cleaning(device_id, stream)
        return await cleanup_live_session(
            device_id=device_id, stream=stream, pc=peer or ClosedPeer(),
            registry=registry, close_peer=app._close_webrtc_peer,
            requested_stop=asyncio.Event(), worker_launch_attempted=True,
            join_timeout=0.002, peer_timeout=1,
            on_late_worker=(callback if callback is not None else
                            lambda: manager.late_cleanup(device_id, stream)),
        )

    yield registry, manager, make_worker, cleanup
    for stream in workers:
        controls[stream.serial]["release"].set()
    for stream in workers:
        stream.thread.join(2)
        assert not stream.thread.is_alive()


def test_late_worker_restores_all_twenty_slots_after_websocket_loop_has_closed(runtime):
    registry, manager, make_worker, cleanup = runtime
    workers = [make_worker(f"phone-{n}") for n in range(registry.MAX_LIVE_SESSIONS)]

    async def stop_all():
        reports = await asyncio.gather(*(cleanup(f"phone-{n}", stream)
                                        for n, (stream, _) in enumerate(workers)))
        for n, ((stream, _), report) in enumerate(zip(workers, reports)):
            assert report.peer_cleanup and not report.worker_finished and not report.cleaned
            assert not manager.complete(f"phone-{n}", stream, clean=False, reason=report.reason)
        assert manager.summary()["dirty"] == 20
    asyncio.run(stop_all())
    # No event loop or browser remains to receive the late worker completion.
    for _, control in workers:
        control["release"].set()
    for stream, _ in workers:
        stream.thread.join(1)
        assert stream.finished.is_set() and registry.is_cleaned(stream)
        assert stream._finished_callback is None
    assert not registry.sessions
    assert manager.summary()["dirty"] == 0
    assert manager.summary()["released"] == 20
    assert manager.reserve("new-device", LiveVideo("new-device:5555", "baseline"))


@pytest.mark.parametrize("failure", ["forward", "remote", "peer"])
def test_late_worker_never_releases_unverified_resources(runtime, failure):
    registry, manager, make_worker, cleanup = runtime
    stream, control = make_worker("phone", failure=failure)

    async def stop():
        report = await cleanup("phone", stream, peer=FailedPeer() if failure == "peer" else None)
        assert not report.cleaned
        manager.complete("phone", stream, clean=False, reason=report.reason)
    asyncio.run(stop())
    control["release"].set()
    stream.thread.join(1)
    assert stream.finished.is_set()
    assert not registry.is_cleaned(stream)
    assert registry.sessions["phone"] is stream
    assert manager.snapshot("phone")["phase"] == "dirty"
    assert not manager.reserve("phone", LiveVideo("phone:5555", "baseline"))
    assert any(command[:3] == ("shell", "rm", "-f") for command in control["commands"])


def test_late_worker_callback_cannot_release_a_replacement_session(runtime):
    registry, manager, make_worker, cleanup = runtime
    stream, control = make_worker("phone")
    callback_entered, callback_release = threading.Event(), threading.Event()

    def late():
        callback_entered.set()
        assert callback_release.wait(3)
        assert not manager.late_cleanup("phone", stream)

    async def stop():
        report = await cleanup("phone", stream, callback=late)
        assert not report.cleaned
        manager.complete("phone", stream, clean=False, reason=report.reason)
    asyncio.run(stop())
    try:
        control["release"].set()
        assert callback_entered.wait(1)
        assert registry.is_cleaned(stream)
        newer = LiveVideo("phone:5555", "baseline")
        assert manager.reserve("phone", newer)
    finally:
        callback_release.set()
        stream.thread.join(1)
    assert registry.sessions["phone"] is newer
    assert not newer.stop_event.is_set()
    assert manager.snapshot("phone")["session_id"] == newer.session_id
    assert manager.snapshot("phone")["phase"] == "reserved"


def test_worker_finishing_just_before_subscription_is_not_lost(runtime, monkeypatch):
    registry, manager, make_worker, cleanup = runtime
    stream, control = make_worker("phone")
    subscribe = stream.when_worker_finished

    def finish_then_subscribe(callback):
        control["release"].set()
        stream.thread.join(1)
        assert stream.finished.is_set()
        subscribe(callback)
    monkeypatch.setattr(stream, "when_worker_finished", finish_then_subscribe)

    async def stop():
        report = await cleanup("phone", stream)
        assert report.cleaned
        # Subscription immediately delivered the already-finished edge.
        assert manager.snapshot("phone")["phase"] == "released"
        assert not registry.sessions
    asyncio.run(stop())


@pytest.mark.parametrize("failed_operation", ["stop", "join"])
def test_raised_cleanup_operation_is_not_treated_as_a_pending_worker(runtime, monkeypatch, failed_operation):
    registry, manager, make_worker, cleanup = runtime
    stream, control = make_worker("phone")

    def failed(*args, **kwargs):
        raise OSError("mock cleanup operation failed")
    monkeypatch.setattr(stream, failed_operation, failed)

    async def stop():
        report = await cleanup("phone", stream)
        assert not report.cleaned
        assert f"worker {failed_operation} raised" in report.problems
        manager.complete("phone", stream, clean=False, reason=report.reason)
        assert stream._finished_callback is None
    asyncio.run(stop())
    control["release"].set()
    stream.thread.join(1)
    assert stream.finished.is_set()
    assert registry.sessions["phone"] is stream
    assert manager.snapshot("phone")["phase"] == "dirty"
