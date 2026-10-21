"""Resize signaling keeps the existing live owner and its one-time actions.

Reuse the takeover suite's production handler/registry/SQLite fixture, whose
ADB, WebSocket and media boundaries are isolated from real devices.
"""
import asyncio
import json

from test_live_takeover import runtime  # noqa: F401 - shared pytest fixture


async def wait_count(ws, kind, count):
    async def receive():
        while len(ws.of_type(kind)) < count:
            assert not ws.closed, ws.messages
            ws.changed.clear()
            await ws.changed.wait()
        return ws.of_type(kind)[count - 1]
    return await asyncio.wait_for(receive(), 3)


def test_rotation_keeps_socket_track_control_and_does_not_repeat_start_or_unlock(runtime, monkeypatch):
    source = runtime.source
    create = source.LiveVideo
    unlocks, starts, releases = [], [], []
    acquire = source.resource_budget.acquire_start
    release = source.resource_budget.release_start

    def create_with_control(*args, **kwargs):
        stream = create(*args, **kwargs)
        start = stream.start
        def start_with_control():
            start()
            kind, payload = stream.events.get_nowait()
            assert kind == "init"
            stream.events.put((kind, {**payload, "control_available": True}))
        stream.start = start_with_control
        return stream

    def acquire_start(device_id, sid):
        starts.append((device_id, sid))
        return acquire(device_id, sid)

    def release_start(device_id, sid):
        releases.append((device_id, sid))
        return release(device_id, sid)

    source.LiveVideo = create_with_control
    monkeypatch.setattr(source.store, "get_unlock_secret", lambda _: "fixture-only-password")
    source.automatic_unlock = lambda stream, _: unlocks.append(stream.session_id) or "submitted"
    monkeypatch.setattr(source.resource_budget, "acquire_start", acquire_start)
    monkeypatch.setattr(source.resource_budget, "release_start", release_start)

    async def run():
        async with runtime as rt:
            other, other_stream = await rt.running(rt.devices[1])
            ws, stream = await rt.running()
            await wait_count(ws, "unlock_notice", 2)
            sid, track = stream.session_id, stream.webrtc_track
            for count, (width, height) in enumerate(((1600, 720), (720, 1600), (1600, 720)), 1):
                stream.events.put(("resize", {"width": width, "height": height}))
                assert await wait_count(ws, "resize", count) == {
                    "type": "resize", "session_id": sid, "width": width, "height": height,
                }
                ws.commands.put_nowait(json.dumps({"type": "control_enable", "session_id": sid}))
                await wait_count(ws, "control_enabled", count)
                assert not ws.closed and not stream.stop_event.is_set()
                assert stream.webrtc_track is track and track.readyState == "live"
                assert source.live_registry.sessions[rt.devices[0]["id"]] is stream
                assert source.session_manager.snapshot(rt.devices[0]["id"], stream)["phase"] == "running"
            assert len(ws.of_type("starting")) == len(ws.of_type("init")) == len(ws.of_type("webrtc_answer")) == 1
            assert unlocks.count(sid) == 1
            assert starts.count((rt.devices[0]["id"], sid)) == releases.count((rt.devices[0]["id"], sid)) == 1
            assert source.resource_budget.snapshot()["starting"] == 0
            assert not ws.of_type("error") and not ws.of_type("ended")
            assert not other.of_type("resize") and not other_stream.stop_event.is_set()
            ws.commands.put_nowait("stop")
            await asyncio.wait_for(ws.task, 3)
            assert ws.of_type("ended")[-1]["cleanup_complete"] is True
            assert rt.devices[0]["id"] not in source.live_registry.sessions
            assert source.live_registry.sessions[rt.devices[1]["id"]] is other_stream
    asyncio.run(run())


def test_replaced_rotated_stream_cannot_resize_its_new_owner(runtime):
    async def run():
        async with runtime as rt:
            old, stream = await rt.running()
            stream.events.put(("resize", {"width": 1600, "height": 720}))
            await old.wait("resize")
            new, current = await rt.running()
            await asyncio.wait_for(old.task, 3)
            assert old.of_type("replaced")[-1]["session_id"] == stream.session_id
            assert stream.stop_event.is_set() and stream.webrtc_track.readyState == "ended"
            stream.events.put(("resize", {"width": 720, "height": 1600}))
            current.events.put(("resize", {"width": 1600, "height": 720}))
            assert await new.wait("resize") == {
                "type": "resize", "session_id": current.session_id, "width": 1600, "height": 720,
            }
            assert len(old.of_type("resize")) == len(new.of_type("resize")) == 1
            assert len(new.of_type("init")) == 1 and not new.of_type("error")
            assert rt.source.live_registry.sessions[rt.devices[0]["id"]] is current
            assert not current.stop_event.is_set()
    asyncio.run(run())
