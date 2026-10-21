"""Latest explicit WebSocket wins only after verified old-session cleanup.

The handler, admission, SQLite, registry and SessionManager are production.
Only the socket transport, ADB online check and media boundaries are fake;
Events expose causal handoff points instead of sleeping to infer a race.
"""
import asyncio
import importlib
import json
import threading
from types import SimpleNamespace

from fastapi import HTTPException, WebSocketDisconnect
import pytest

from server.api import live_handler
from server.devices import DeviceManager, selected_address
from server.m2_live import LiveRegistry, LiveVideo
from server.m2_quality import (EXPERIMENTAL_RESOLUTIONS, VIRTUAL_DPI_CHOICES,
                               resolve_live_quality)
from server.services.resource_budget import ScopedResourceBudget
from server.services.session_manager import SessionManager
from server.store import DeviceStore


REPLACED = "该设备的实时画面已由其他页面接管"
OFFER = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=recvonly\r\n" + "a=mock:abcdefgh\r\n" * 8


def no_external_io(*args, **kwargs):
    raise AssertionError("takeover regression must not access real ADB/media")


class Socket:
    headers = {"host": "testserver", "origin": "http://testserver"}

    def __init__(self, serial, *, initial=None, offer=True):
        self.initial = {"token": "local-test-token-123", "profile": "baseline",
                        "player": "webrtc", "selected_serial": serial, **(initial or {})}
        self.offer = offer
        self.messages = []
        self.commands = asyncio.Queue()
        self.command_received = asyncio.Event()
        self.changed = asyncio.Event()
        self.closed = False
        self.client_disconnected = False
        self.close_options = {}
        self.task = None

    async def accept(self):
        pass

    async def receive_json(self):
        return self.initial

    async def receive_text(self):
        command = await self.commands.get()
        self.command_received.set()
        if isinstance(command, Exception):
            self.client_disconnected = True
            raise command
        return command

    async def send_json(self, message):
        if self.client_disconnected:
            raise WebSocketDisconnect()
        self.messages.append(message)
        self.changed.set()
        if message["type"] == "starting" and self.offer:
            self.commands.put_nowait(json.dumps({
                "type": "webrtc_offer", "session_id": message["session_id"], "sdp": OFFER,
            }))

    async def close(self, **options):
        self.closed = True
        self.close_options.update(options)
        self.changed.set()

    def of_type(self, kind):
        return [message for message in self.messages if message["type"] == kind]

    async def wait(self, kind):
        async def receive():
            while True:
                found = self.of_type(kind)
                if found:
                    return found[-1]
                assert not self.closed, f"closed before {kind}: {self.messages}"
                self.changed.clear()
                await self.changed.wait()
        return await asyncio.wait_for(receive(), 3)


class ControlledStream(LiveVideo):
    """Use real stop/finished notifications with a controllable media worker."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.started = False
        self.hold_worker = False
        self.worker_clean = True
        self.stop_calls = 0
        self.joined = threading.Event()
        self.peer_closing = asyncio.Event()
        self.peer_release = asyncio.Event()
        self.peer_release.set()
        self.hold_sdp = False
        self.sdp_entered = asyncio.Event()
        self.sdp_cancelled = asyncio.Event()
        self.sdp_release = asyncio.Event()
        self.sdp_completed = asyncio.Event()

    def start(self):
        assert not self.started
        self.started = True
        self.events.put(("init", {"width": 720, "height": 1600,
                                  "control_available": False}))

    def stop(self):
        self.stop_calls += 1
        super().stop()
        if not self.hold_worker:
            self.finish_worker(clean=self.worker_clean)

    def finish_worker(self, *, clean=True):
        self.cleanup_complete = clean
        self._finish_worker()

    def join(self, timeout=20):
        # Represents the bounded join returning while the worker may remain.
        self.joined.set()

    def diagnostics(self):
        return {"stage": "controlled-media"}


class Runtime:
    def __init__(self, source, devices, created, checks):
        self.source, self.devices, self.created, self.checks = source, devices, created, checks
        self.sockets = []
        self.release_gates = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        for release in self.release_gates:
            release.set()
        for stream in self.created:
            stream.hold_worker = False
            stream.peer_release.set()
            stream.sdp_release.set()
            if stream.stop_event.is_set():
                stream.finish_worker()
        for ws in self.sockets:
            if not ws.task.done():
                ws.commands.put_nowait("stop")
        await asyncio.wait_for(asyncio.gather(*(ws.task for ws in self.sockets),
                                             return_exceptions=True), 4)

    def open(self, device=None, **options):
        device = device or self.devices[0]
        ws = Socket(selected_address(device), **options)
        ws.task = asyncio.create_task(live_handler.handle_live_video(ws, device["id"], self.source))
        self.sockets.append(ws)
        return ws

    def stream_for(self, ws):
        sid = ws.of_type("starting")[-1]["session_id"]
        return next(stream for stream in self.created if stream.session_id == sid)

    async def running(self, device=None, **options):
        ws = self.open(device, **options)
        await ws.wait("init")
        return ws, self.stream_for(ws)

    async def blocked_takeover(self):
        old, stream = await self.running()
        stream.hold_worker = True
        new = self.open()
        await new.wait("waiting")
        await old.wait("replaced")
        await asyncio.wait_for(old.task, 3)
        assert not stream.finished.is_set()
        assert self.source.live_registry.sessions[self.devices[0]["id"]] is stream
        return old, stream, new


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    # Reuse the production peer-close wrapper (including late_cleanup), while
    # keeping the application module's process-wide registry isolated.
    monkeypatch.setenv("EASYADB_TOKEN", "local-test-token-123")
    app = importlib.import_module("server.app")
    import aiortc

    store = DeviceStore(str(tmp_path / "takeover.sqlite3"))
    store.initialize()
    store.create_group("Home", "192.168.2.*")
    devices = [store.create({"name": f"Phone {n}", "ip": f"10.0.0.{n}",
                             "port": 5555, "group_name": "Home"}) for n in (1, 2, 3)]
    manager = DeviceManager(store, no_external_io)
    for device in devices:
        manager._set_state(device["id"], "connected", serial=selected_address(device), route="mesh")
    registry = LiveRegistry()
    session_manager = SessionManager(lambda: registry)
    monkeypatch.setattr(app, "session_manager", session_manager)
    created, checks = [], []

    def new_stream(serial, profile, **options):
        stream = ControlledStream(serial, profile, **options)
        created.append(stream)
        return stream

    def connected(serial):
        checks.append(serial)
        return True

    async def no_adb_loss(*args):
        return False

    class Peer:
        connectionState = "connected"

        def __init__(self, configuration):
            self.localDescription = None

        def addTrack(self, track):
            self.stream = next(stream for stream in created if stream.webrtc_track is track)
            self.sender = object()
            return self.sender

        def getTransceivers(self):
            return [SimpleNamespace(sender=self.sender, setCodecPreferences=lambda _: None)]

        def on(self, event):
            return lambda callback: callback

        async def setRemoteDescription(self, description):
            assert description.type == "offer"
            if self.stream.hold_sdp:
                self.stream.sdp_entered.set()
                while not self.stream.sdp_release.is_set():
                    try:
                        await self.stream.sdp_release.wait()
                    except asyncio.CancelledError:
                        # A media dependency can complete despite cancellation;
                        # the real handler must still reject the stale owner.
                        self.stream.sdp_cancelled.set()
                self.stream.sdp_completed.set()

        async def createAnswer(self):
            return aiortc.RTCSessionDescription(sdp="v=0\r\n", type="answer")

        async def setLocalDescription(self, description):
            self.localDescription = description

        async def close(self):
            self.stream.peer_closing.set()
            await self.stream.peer_release.wait()
            self.connectionState = "closed"

    monkeypatch.setattr(aiortc, "RTCPeerConnection", Peer)
    monkeypatch.setattr(live_handler, "LIVE_TAKEOVER_TIMEOUT", 3, raising=False)
    source = SimpleNamespace(
        TOKEN="local-test-token-123", VIDEO_ENGINE="webrtc", store=store, manager=manager,
        live_registry=registry, session_manager=session_manager,
        resource_budget=ScopedResourceBudget(lambda: registry),
        display_lab=SimpleNamespace(scan=lambda _: {"display_ids": [1]},
                                    has_pending=lambda _: False, _log=lambda *args: None),
        LiveVideo=new_stream, resolve_live_quality=resolve_live_quality,
        EXPERIMENTAL_RESOLUTIONS=EXPERIMENTAL_RESOLUTIONS,
        VIRTUAL_DPI_CHOICES=VIRTUAL_DPI_CHOICES, selected_address=selected_address,
        automatic_unlock=no_external_io, is_connected=connected, adb=no_external_io,
        confirm_live_adb_loss=no_adb_loss, _close_webrtc_peer=app._close_webrtc_peer,
        LIVE_HEARTBEAT_TIMEOUT=45, LIVE_HEARTBEAT_CHECK_INTERVAL=1,
        LIVE_WS_SEND_TIMEOUT=1, LIVE_TAKEOVER_TIMEOUT=3, HTTPException=HTTPException,
    )
    return Runtime(source, devices, created, checks)


@pytest.mark.parametrize("pending", ["worker", "peer"])
def test_same_socket_takes_over_only_after_old_worker_and_peer_are_clean(runtime, pending):
    async def run():
        async with runtime as rt:
            other, other_stream = await rt.running(rt.devices[1])
            old, stream = await rt.running()
            if pending == "worker":
                stream.hold_worker = True
            else:
                stream.peer_release.clear()
            new = rt.open()
            waiting = await new.wait("waiting")
            assert waiting["reason"] == "takeover"
            replaced = await old.wait("replaced")
            assert replaced["message"] == REPLACED
            assert replaced["session_id"] == stream.session_id
            assert stream.stop_event.is_set()
            assert stream.webrtc_track.readyState == "ended"
            if pending == "worker":
                await asyncio.wait_for(old.task, 3)
                assert not stream.finished.is_set() and stream.peer_cleanup_complete
            else:
                await asyncio.wait_for(stream.peer_closing.wait(), 3)
                assert stream.finished.is_set() and not stream.peer_cleanup_complete
            assert rt.source.live_registry.sessions[rt.devices[0]["id"]] is stream
            assert not new.of_type("starting")
            assert not other.of_type("replaced") and not other_stream.stop_event.is_set()
            if pending == "worker":
                stream.finish_worker()
            else:
                stream.peer_release.set()
            await new.wait("init")
            current = rt.stream_for(new)
            assert current is not stream and current.started
            assert rt.source.live_registry.sessions[rt.devices[0]["id"]] is current
            assert rt.source.live_registry.sessions[rt.devices[1]["id"]] is other_stream
            assert len(new.of_type("starting")) == 1 and len(new.of_type("init")) == 1
            assert not old.of_type("ended"), "takeover must not masquerade as a manual stop"
    asyncio.run(run())


def test_third_page_replaces_waiting_second_page_without_starting_it(runtime):
    async def run():
        async with runtime as rt:
            _, stream, second = await rt.blocked_takeover()
            third = rt.open()
            await third.wait("waiting")
            replaced = await second.wait("replaced")
            assert replaced["message"] == REPLACED
            await asyncio.wait_for(second.task, 3)
            assert not second.of_type("starting")
            assert rt.source.live_registry.sessions[rt.devices[0]["id"]] is stream
            stream.finish_worker()
            await third.wait("init")
            assert rt.source.live_registry.sessions[rt.devices[0]["id"]] is rt.stream_for(third)
            assert not second.of_type("starting") and not third.of_type("replaced")
    asyncio.run(run())


@pytest.mark.parametrize("invalid", ["token", "profile", "screen_off", "address", "offline", "display"])
def test_invalid_new_request_does_not_revoke_valid_waiting_page(runtime, invalid):
    async def run():
        async with runtime as rt:
            _, stream, waiting = await rt.blocked_takeover()
            initial = {
                "token": {"token": "wrong"},
                "profile": {"profile": "unsupported"},
                "screen_off": {"screen_off": "true"},
                "address": {"selected_serial": "10.99.99.99:5555"},
                "offline": {},
                "display": {"display_experiment": {"mode": "display", "display_id": 2}},
            }[invalid]
            connected = rt.source.is_connected
            if invalid == "offline":
                rt.source.is_connected = lambda _: False
            bad = rt.open(initial=initial)
            await asyncio.wait_for(bad.task, 3)
            rt.source.is_connected = connected
            if invalid == "token":
                assert bad.close_options["code"] == 1008
            else:
                assert bad.of_type("error")
            assert not bad.of_type("starting") and not bad.of_type("waiting")
            assert not waiting.of_type("replaced")
            stream.finish_worker()
            await waiting.wait("init")
            assert rt.source.live_registry.sessions[rt.devices[0]["id"]] is rt.stream_for(waiting)
    asyncio.run(run())


def test_slower_older_valid_request_cannot_take_back_a_newer_published_request(runtime):
    async def run():
        async with runtime as rt:
            old, stream = await rt.running()
            stream.hold_worker = True
            entered, release = threading.Event(), threading.Event()
            rt.release_gates.append(release)
            calls = 0
            lock = threading.Lock()
            connected = rt.source.is_connected

            def slow_first(serial):
                nonlocal calls
                with lock:
                    calls += 1
                    ordinal = calls
                if ordinal == 1:
                    entered.set()
                    assert release.wait(4), "test did not release older admission"
                return connected(serial)

            rt.source.is_connected = slow_first
            second = rt.open()
            assert await asyncio.to_thread(entered.wait, 2)
            third = rt.open()
            await third.wait("waiting")
            await old.wait("replaced")
            await asyncio.wait_for(old.task, 3)
            release.set()
            await second.wait("replaced")
            await asyncio.wait_for(second.task, 3)
            assert not second.of_type("starting") and not third.of_type("replaced")
            stream.finish_worker()
            await third.wait("init")
            assert rt.source.live_registry.sessions[rt.devices[0]["id"]] is rt.stream_for(third)
    asyncio.run(run())


@pytest.mark.parametrize("exit_kind", ["stop", "disconnect", "cancel"])
def test_waiting_page_exit_prevents_late_automatic_start(runtime, exit_kind):
    async def run():
        async with runtime as rt:
            _, stream, waiting = await rt.blocked_takeover()
            if exit_kind == "cancel":
                waiting.task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await asyncio.wait_for(waiting.task, 3)
            else:
                waiting.commands.put_nowait("stop" if exit_kind == "stop" else WebSocketDisconnect())
                await asyncio.wait_for(waiting.task, 3)
            assert not waiting.of_type("starting")
            assert rt.source.live_registry.sessions[rt.devices[0]["id"]] is stream
            stream.finish_worker()
            assert rt.devices[0]["id"] not in rt.source.live_registry.sessions
            assert not waiting.of_type("starting") and not waiting.of_type("init")
            assert rt.source.resource_budget.snapshot()["starting"] == 0
    asyncio.run(run())


@pytest.mark.parametrize("exit_kind", ["stop", "disconnect"])
def test_page_exiting_during_online_check_cannot_revoke_the_running_owner(runtime, exit_kind):
    async def run():
        async with runtime as rt:
            old, stream = await rt.running()
            entered, release = threading.Event(), threading.Event()
            rt.release_gates.append(release)
            connected = rt.source.is_connected

            def blocked_check(serial):
                entered.set()
                assert release.wait(4), "test did not release online validation"
                return connected(serial)

            rt.source.is_connected = blocked_check
            leaving = rt.open()
            assert await asyncio.to_thread(entered.wait, 2)
            leaving.commands.put_nowait("stop" if exit_kind == "stop" else WebSocketDisconnect())
            await asyncio.wait_for(leaving.command_received.wait(), 2)
            # The pending reader consumes the exit before validation returns.
            release.set()
            await asyncio.wait_for(leaving.task, 3)
            assert not leaving.of_type("starting") and not leaving.of_type("waiting")
            assert not old.of_type("replaced") and not old.closed
            assert not stream.stop_event.is_set() and stream.webrtc_track.readyState == "live"
            assert rt.source.live_registry.sessions[rt.devices[0]["id"]] is stream
            assert rt.source.session_manager.snapshot(rt.devices[0]["id"])["phase"] == "running"
            assert [candidate for candidate in rt.created if candidate.started] == [stream]
    asyncio.run(run())


def test_late_sdp_after_replacement_cannot_start_the_old_worker(runtime):
    async def run():
        async with runtime as rt:
            old = rt.open(offer=False)
            await old.wait("starting")
            stream = rt.stream_for(old)
            stream.hold_sdp = True
            old.commands.put_nowait(json.dumps({
                "type": "webrtc_offer", "session_id": stream.session_id, "sdp": OFFER,
            }))
            await asyncio.wait_for(stream.sdp_entered.wait(), 2)
            new = rt.open()
            await new.wait("waiting")
            await old.wait("replaced")
            await asyncio.wait_for(stream.sdp_cancelled.wait(), 2)
            assert stream.stop_event.is_set() and stream.webrtc_track.readyState == "ended"
            assert not stream.started and not new.of_type("starting")
            # The old media await now returns normally, even after cancellation.
            stream.sdp_release.set()
            await asyncio.wait_for(old.task, 3)
            assert stream.sdp_completed.is_set()
            assert not stream.started and not old.of_type("init")
            assert not old.of_type("webrtc_answer")
            await new.wait("init")
            assert rt.source.live_registry.sessions[rt.devices[0]["id"]] is rt.stream_for(new)
            assert rt.stream_for(new).started
    asyncio.run(run())


def dirty_owner(rt, missing):
    device = rt.devices[0]
    stream = LiveVideo(selected_address(device), "baseline")
    stream.cleanup_complete = missing != "worker_cleanup"
    stream.peer_cleanup_complete = missing != "peer"
    if missing != "worker_finished":
        stream.finished.set()
    assert rt.source.session_manager.reserve(device["id"], stream)
    rt.source.session_manager.cleaning(device["id"], stream)
    assert not rt.source.session_manager.complete(device["id"], stream, clean=False)
    return stream


@pytest.mark.parametrize("missing", ["worker_finished", "worker_cleanup", "peer"])
def test_each_missing_cleanup_proof_retains_dirty_owner_and_blocks_takeover(runtime, missing):
    async def run():
        async with runtime as rt:
            stream = dirty_owner(rt, missing)
            device_id = rt.devices[0]["id"]
            new = rt.open()
            await new.wait("waiting")
            checks = list(rt.checks)
            assert not rt.source.session_manager.late_cleanup(device_id, stream)
            assert not rt.source.session_manager.complete(device_id, stream, clean=True)
            new.commands.put_nowait("stop")
            await asyncio.wait_for(new.task, 3)
            assert not new.of_type("starting") and not new.of_type("init")
            assert not new.of_type("ended"), "an unreserved waiter owns no clean session"
            assert rt.source.live_registry.sessions[device_id] is stream
            assert rt.source.session_manager.snapshot(device_id)["phase"] == "dirty"
            assert rt.checks == checks, "waiting must not poll ADB for cleanup proof"
    asyncio.run(run())


def test_takeover_timeout_keeps_dirty_slot_and_never_reports_success(runtime, monkeypatch):
    monkeypatch.setattr(live_handler, "LIVE_TAKEOVER_TIMEOUT", 0.05)
    runtime.source.LIVE_TAKEOVER_TIMEOUT = 0.05

    async def run():
        async with runtime as rt:
            stream = dirty_owner(rt, "worker_cleanup")
            new = rt.open()
            await new.wait("waiting")
            error = await new.wait("error")
            assert error["code"] == "takeover_timeout"
            await asyncio.wait_for(new.task, 3)
            assert not new.of_type("starting") and not new.of_type("ended")
            assert rt.source.live_registry.sessions[rt.devices[0]["id"]] is stream
            assert rt.source.session_manager.snapshot(rt.devices[0]["id"])["phase"] == "dirty"
            assert rt.source.resource_budget.snapshot()["starting"] == 0
    asyncio.run(run())


def test_full_twenty_slot_registry_can_replace_same_device_but_rejects_another(runtime):
    async def run():
        async with runtime as rt:
            old, stream = await rt.running()
            stream.hold_worker = True
            others = []
            for n in range(1, LiveRegistry.MAX_LIVE_SESSIONS):
                device = rt.source.store.create({
                    "name": f"Reserved {n}", "ip": f"10.1.0.{n + 10}",
                    "port": 5555, "group_name": "Home",
                })
                occupant = LiveVideo(selected_address(device), "baseline")
                assert rt.source.session_manager.reserve(device["id"], occupant)
                others.append((device["id"], occupant))
            assert len(rt.source.live_registry.sessions) == 20
            waiting = rt.open()
            await waiting.wait("waiting")
            await old.wait("replaced")
            await asyncio.wait_for(old.task, 3)
            assert len(rt.source.live_registry.sessions) == 20
            denied = rt.open(rt.devices[1])
            await denied.wait("error")
            await asyncio.wait_for(denied.task, 3)
            assert not denied.of_type("starting")
            assert len(rt.source.live_registry.sessions) == 20
            stream.finish_worker()
            await waiting.wait("init")
            assert len(rt.source.live_registry.sessions) == 20
            assert rt.source.live_registry.sessions[rt.devices[0]["id"]] is rt.stream_for(waiting)
            for device_id, occupant in others:
                assert rt.source.live_registry.sessions[device_id] is occupant
                assert not occupant.stop_event.is_set()
    asyncio.run(run())


def test_takeover_does_not_bypass_another_devices_startup_budget(runtime):
    runtime.source.resource_budget = ScopedResourceBudget(
        lambda: runtime.source.live_registry, max_starting=1)

    async def run():
        async with runtime as rt:
            old, stream = await rt.running()
            stream.hold_worker = True
            other = rt.open(rt.devices[1], offer=False)
            await other.wait("starting")
            other_stream = rt.stream_for(other)
            assert rt.source.resource_budget.snapshot()["starting"] == 1
            waiting = rt.open()
            await waiting.wait("waiting")
            await old.wait("replaced")
            await asyncio.wait_for(old.task, 3)
            stream.finish_worker()
            error = await waiting.wait("error")
            assert error["code"] == "start_budget_full"
            await asyncio.wait_for(waiting.task, 3)
            assert not waiting.of_type("starting") and not waiting.of_type("init")
            assert rt.devices[0]["id"] not in rt.source.live_registry.sessions
            assert rt.source.live_registry.sessions[rt.devices[1]["id"]] is other_stream
            assert not other_stream.stop_event.is_set() and not other.of_type("replaced")
            assert rt.source.resource_budget.snapshot()["starting"] == 1
    asyncio.run(run())
