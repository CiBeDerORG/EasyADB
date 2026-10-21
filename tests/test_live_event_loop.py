"""Real live handler/coordination with isolated SQLite and no external ADB.

Blocking gates stand in for bounded device I/O. Another session must remain
usable, and cancelled admission must not lose a late reservation.
"""
import asyncio
from contextlib import contextmanager
import threading
from types import SimpleNamespace

from fastapi import HTTPException
import pytest

from server.api.live_handler import handle_live_video
from server.devices import DeviceManager, selected_address
from server.m2_live import LiveRegistry, LiveVideo
from server.m2_quality import (EXPERIMENTAL_RESOLUTIONS, VIRTUAL_DPI_CHOICES,
                               resolve_live_quality)
from server.services.live_coordination import confirm_adb_loss
from server.services.resource_budget import ScopedResourceBudget
from server.services.session_manager import SessionManager
from server.store import DeviceStore


def no_external_io(*args, **kwargs):
    raise AssertionError("No real ADB/media operation is allowed")


class Socket:
    headers = {"host": "testserver", "origin": "http://testserver"}

    def __init__(self, serial, *, experiment=None, auto_stop=True):
        self.initial = {"token": "test-token", "profile": "baseline",
                        "player": "webrtc", "selected_serial": serial}
        if experiment:
            self.initial["display_experiment"] = experiment
        self.messages = []
        self.commands = asyncio.Queue()
        self.auto_stop = auto_stop

    async def accept(self):
        pass

    async def receive_json(self):
        return self.initial

    async def receive_text(self):
        return await self.commands.get()

    async def send_json(self, message):
        self.messages.append(message)
        if message["type"] == "starting" and self.auto_stop:
            self.commands.put_nowait("stop")

    async def close(self, **kwargs):
        pass


@pytest.fixture
def runtime(tmp_path):
    store = DeviceStore(str(tmp_path / "live.sqlite3"))
    store.initialize()
    store.create_group("Home", "192.168.2.*")
    devices = [store.create({"name": str(n), "ip": f"10.0.0.{n}",
                             "port": 5555, "group_name": "Home"}) for n in (1, 2)]
    manager = DeviceManager(store, no_external_io)
    for device in devices:
        manager._set_state(device["id"], "connected", serial=selected_address(device), route="mesh")
    registry = LiveRegistry()
    session_manager = SessionManager(lambda: registry)
    created = []

    def new_stream(serial, profile, **options):
        stream = LiveVideo(serial, profile, **options)
        stream.start = no_external_io  # no SDP offer is sent by this fixture
        created.append(stream)
        return stream

    async def no_adb_loss(*args):
        return False

    source = SimpleNamespace(
        TOKEN="test-token", VIDEO_ENGINE="webrtc", store=store, manager=manager,
        live_registry=registry, session_manager=session_manager,
        resource_budget=ScopedResourceBudget(lambda: registry),
        display_lab=SimpleNamespace(scan=lambda _: {"display_ids": [1]},
                                    has_pending=lambda _: False, _log=lambda *args: None),
        LiveVideo=new_stream, resolve_live_quality=resolve_live_quality,
        EXPERIMENTAL_RESOLUTIONS=EXPERIMENTAL_RESOLUTIONS,
        VIRTUAL_DPI_CHOICES=VIRTUAL_DPI_CHOICES, selected_address=selected_address,
        automatic_unlock=no_external_io, is_connected=lambda _: True, adb=no_external_io,
        confirm_live_adb_loss=no_adb_loss, _close_webrtc_peer=no_external_io,
        LIVE_HEARTBEAT_TIMEOUT=45, LIVE_HEARTBEAT_CHECK_INTERVAL=1,
        LIVE_WS_SEND_TIMEOUT=1, HTTPException=HTTPException,
    )
    return source, devices, created


@contextmanager
def held_device_lock(manager, device_id):
    entered, release = threading.Event(), threading.Event()
    def hold():
        with manager._device_lock(device_id):
            entered.set()
            assert release.wait(4), "test did not release device lock"
    thread = threading.Thread(target=hold)
    thread.start()
    assert entered.wait(1)
    try:
        yield release
    finally:
        release.set()
        thread.join(1)
        assert not thread.is_alive()


async def another_session_finishes(source, device):
    ws = Socket(selected_address(device))
    await asyncio.wait_for(handle_live_video(ws, device["id"], source), 1)
    assert any(m["type"] == "ended" and m["cleanup_complete"] for m in ws.messages)


@pytest.mark.parametrize("blocked", ["scan", "device_lock", "store_read"])
def test_blocked_admission_does_not_block_other_session(runtime, monkeypatch, blocked):
    source, devices, _ = runtime
    first, second = devices
    entered, release = threading.Event(), threading.Event()
    original_get = source.store.get

    def scan(serial):
        entered.set()
        assert release.wait(3)
        return {"display_ids": [1]}

    def get(device_id):
        if device_id == first["id"] and not release.is_set():
            scan(selected_address(first))
        return original_get(device_id)

    if blocked == "scan":
        source.display_lab.scan = scan
    elif blocked == "store_read":
        monkeypatch.setattr(source.store, "get", get)
    else:
        source.is_connected = lambda serial: entered.set() or True

    async def run():
        ws = Socket(selected_address(first), experiment={"mode": "display", "display_id": 1})
        task = asyncio.create_task(handle_live_video(ws, first["id"], source))
        try:
            assert await asyncio.to_thread(entered.wait, 1)
            await another_session_finishes(source, second)
        finally:
            release.set()
        await asyncio.wait_for(task, 2)
        assert not source.live_registry.sessions

    if blocked == "device_lock":
        with held_device_lock(source.manager, first["id"]) as lock_release:
            release = lock_release
            asyncio.run(run())
    else:
        asyncio.run(run())


@pytest.mark.parametrize("blocked", ["scan", "device_lock"])
def test_cancelled_admission_does_not_create_a_late_session(runtime, blocked):
    source, devices, created = runtime
    device = devices[0]
    entered, release = threading.Event(), threading.Event()

    def scan(serial):
        entered.set()
        assert release.wait(3)
        return {"display_ids": [1]}

    if blocked == "scan":
        source.display_lab.scan = scan
    else:
        source.is_connected = lambda serial: entered.set() or True

    async def run():
        ws = Socket(selected_address(device), experiment={"mode": "display", "display_id": 1})
        task = asyncio.create_task(handle_live_video(ws, device["id"], source))
        assert await asyncio.to_thread(entered.wait, 1)
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done(), "the admission result must remain owned"
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 2)
        assert not created and not source.live_registry.sessions
        assert source.resource_budget.snapshot()["starting"] == 0

    if blocked == "device_lock":
        with held_device_lock(source.manager, device["id"]) as lock_release:
            release = lock_release
            asyncio.run(run())
    else:
        asyncio.run(run())


def test_cancel_racing_reservation_drains_and_cleans_only_its_owner(runtime, monkeypatch):
    source, devices, created = runtime
    first, second = devices
    original = source.session_manager.reserve
    entered, release = threading.Event(), threading.Event()
    other = LiveVideo(selected_address(second), "baseline")
    assert original(second["id"], other)

    def reserve(device_id, stream):
        accepted = original(device_id, stream)
        if device_id == first["id"]:
            entered.set()
            assert release.wait(3)
        return accepted
    monkeypatch.setattr(source.session_manager, "reserve", reserve)

    async def run():
        task = asyncio.create_task(handle_live_video(Socket(selected_address(first)), first["id"], source))
        try:
            assert await asyncio.to_thread(entered.wait, 1)
            task.cancel()
            await asyncio.sleep(0)
            task.cancel()  # a second cancellation may not lose the pending owner
            await asyncio.sleep(0)
            assert not task.done()
        finally:
            release.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 2)
        assert source.live_registry.sessions == {second["id"]: other}
        assert not other.stop_event.is_set()
        assert created[0].stop_event.is_set() and created[0].finished.is_set()
        assert source.session_manager.snapshot(first["id"])["phase"] == "released"
        assert source.resource_budget.snapshot()["starting"] == 0
    asyncio.run(run())


def test_address_is_revalidated_after_waiting_for_device_lock(runtime):
    source, devices, created = runtime
    device = devices[0]
    checked = threading.Event()
    source.is_connected = lambda _: checked.set() or True

    async def run(release):
        ws = Socket(selected_address(device))
        task = asyncio.create_task(handle_live_video(ws, device["id"], source))
        assert await asyncio.to_thread(checked.wait, 1)
        # Simulate the mutation which owns the device lock finishing first.
        source.store.select_route(device["id"], "lan")
        release.set()
        await asyncio.wait_for(task, 2)
        assert any("当前选择的 IP 已改变" in m.get("message", "") for m in ws.messages)
        assert not created and not source.live_registry.sessions
    with held_device_lock(source.manager, device["id"]) as release:
        asyncio.run(run(release))


def test_blocked_diagnostics_do_not_block_another_session(runtime):
    source, devices, created = runtime
    entered, release = threading.Event(), threading.Event()
    factory = source.LiveVideo

    def new_stream(serial, *args, **kwargs):
        stream = factory(serial, *args, **kwargs)
        if serial == selected_address(devices[0]):
            def diagnostics():
                entered.set()
                assert release.wait(3)
                return {"stage": "mock-blocked-control-lock"}
            stream.diagnostics = diagnostics
        return stream
    source.LiveVideo = new_stream

    async def run():
        ws = Socket(selected_address(devices[0]), auto_stop=False)
        task = asyncio.create_task(handle_live_video(ws, devices[0]["id"], source))
        try:
            assert await asyncio.to_thread(entered.wait, 1)
            await another_session_finishes(source, devices[1])
        finally:
            release.set()
            ws.commands.put_nowait("stop")
        await asyncio.wait_for(task, 2)
        assert not source.live_registry.sessions
    asyncio.run(run())


def test_adb_loss_device_lock_wait_does_not_block_loop_or_overwrite_new_route(runtime):
    source, devices, _ = runtime
    device = devices[0]
    checked = threading.Event()
    source.is_connected = lambda _: checked.set() and False

    async def run(release):
        task = asyncio.create_task(confirm_adb_loss(source, device["id"], selected_address(device)))
        assert await asyncio.to_thread(checked.wait, 1)
        await asyncio.sleep(0.02)
        assert not release.is_set() and not task.done()
        changed = source.store.select_route(device["id"], "lan")
        source.manager._set_state(device["id"], "connected", serial=selected_address(changed), route="lan")
        release.set()
        assert await asyncio.wait_for(task, 2)
        assert source.manager.serial_for(changed) == selected_address(changed)
    with held_device_lock(source.manager, device["id"]) as release:
        asyncio.run(run(release))


def test_cancelled_adb_loss_cannot_later_clear_a_connection(runtime, monkeypatch):
    source, devices, _ = runtime
    device = devices[0]
    serial = selected_address(device)
    source.is_connected = lambda _: False
    acquiring, completed = threading.Event(), threading.Event()
    original_lock = source.manager._device_lock

    @contextmanager
    def observed_lock(device_id):
        acquiring.set()
        with original_lock(device_id):
            try:
                yield
            finally:
                completed.set()

    async def run(release):
        monkeypatch.setattr(source.manager, "_device_lock", observed_lock)
        task = asyncio.create_task(confirm_adb_loss(source, device["id"], serial))
        assert await asyncio.to_thread(acquiring.wait, 1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        source.manager._set_state(device["id"], "connected", serial=serial, route="mesh")
        release.set()
        assert await asyncio.to_thread(completed.wait, 1)
        assert source.manager.serial_for(device) == serial
    with held_device_lock(source.manager, device["id"]) as release:
        asyncio.run(run(release))


def test_shutdown_cancel_then_repeated_cleanup_cancel_retains_the_exact_owner(runtime, monkeypatch):
    source, devices, created = runtime
    device = devices[0]
    reserve_entered, reserve_release = threading.Event(), threading.Event()
    stop_entered, stop_release = threading.Event(), threading.Event()
    reserve = source.session_manager.reserve

    def gated_reserve(device_id, stream):
        accepted = reserve(device_id, stream)
        stop = stream.stop
        def gated_stop():
            stop_entered.set()
            assert stop_release.wait(3)
            stop()
        stream.stop = gated_stop
        reserve_entered.set()
        assert reserve_release.wait(3)
        return accepted
    monkeypatch.setattr(source.session_manager, "reserve", gated_reserve)

    async def run():
        task = asyncio.create_task(handle_live_video(Socket(selected_address(device)), device["id"], source))
        try:
            assert await asyncio.to_thread(reserve_entered.wait, 1)
            # Simulate shutdown cancelling all request Tasks. The executor
            # result must not be a second Task that can lose its return value.
            pending = asyncio.all_tasks() - {asyncio.current_task()}
            watchers = {other for other in pending if other.get_name() == "live-pending-start"}
            assert len(watchers) == 1
            assert pending == {task} | watchers
            for other in pending:
                other.cancel()
            await asyncio.sleep(0)
            reserve_release.set()
            assert await asyncio.to_thread(stop_entered.wait, 1)
            task.cancel()
            await asyncio.sleep(0)
            task.cancel()
            await asyncio.sleep(0)
            assert not task.done()
        finally:
            reserve_release.set()
            stop_release.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 2)
        assert created[0].finished.is_set() and created[0].cleanup_complete
        assert not source.live_registry.sessions
        assert source.session_manager.snapshot(device["id"])["phase"] == "released"
        assert source.resource_budget.snapshot()["starting"] == 0
    asyncio.run(run())


def test_direct_cleanup_task_cancellation_preserves_dirty_ownership(runtime, monkeypatch):
    from server.api import live_handler
    source, devices, created = runtime
    device = devices[0]

    async def run():
        entered = asyncio.Event()
        cleanup_tasks = []
        async def pending_cleanup(**kwargs):
            cleanup_tasks.append(asyncio.current_task())
            entered.set()
            await asyncio.Event().wait()
        monkeypatch.setattr(live_handler, "cleanup_live_session", pending_cleanup)
        task = asyncio.create_task(handle_live_video(Socket(selected_address(device)), device["id"], source))
        await asyncio.wait_for(entered.wait(), 2)
        cleanup_tasks[0].cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 2)
        assert source.live_registry.sessions[device["id"]] is created[0]
        assert not source.live_registry.is_cleaned(created[0])
        state = source.session_manager.snapshot(device["id"])
        assert state["phase"] == "dirty" and "取消" in state["reason"]
        assert source.resource_budget.snapshot()["starting"] == 0
    asyncio.run(run())
