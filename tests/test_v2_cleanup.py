"""V2-03: cleanup proof, independent error handling and late peer close."""
import asyncio
import threading

from server.m2_live import LiveRegistry
from server.services.session_cleanup import cleanup_live_session


class Stream:
    def __init__(self, cleaned=True, throw_on_stop=False):
        self.session_id = "session"
        self.finished = threading.Event()
        self.cleanup_complete = cleaned
        self.peer_cleanup_complete = True
        self.peer_close_task = None
        self.webrtc_track = None
        self.throw_on_stop = throw_on_stop
        self.calls = []

    def stop(self):
        self.calls.append("stop")
        self.finished.set()
        if self.throw_on_stop:
            raise OSError("transport cleanup failed")

    def join(self, timeout):
        self.calls.append("join")


def test_clean_without_peer_releases_only_after_worker_join():
    async def run():
        stream = Stream()
        report = await cleanup_live_session(
            device_id="phone", stream=stream, pc=None, registry=LiveRegistry(),
            close_peer=None, requested_stop=asyncio.Event(),
            worker_launch_attempted=True)
        assert report.cleaned and stream.calls == ["stop", "join"]
        assert report.worker_finished and report.peer_cleanup
    asyncio.run(run())


def test_dirty_worker_and_stop_exception_fail_closed():
    async def run():
        for stream in (Stream(cleaned=False), Stream(throw_on_stop=True)):
            report = await cleanup_live_session(
                device_id="phone", stream=stream, pc=None, registry=LiveRegistry(),
                close_peer=None, requested_stop=asyncio.Event(),
                worker_launch_attempted=True)
            assert not report.cleaned
            assert not stream.cleanup_complete or report.problems
            assert stream.calls == ["stop", "join"]
    asyncio.run(run())


def test_timeout_keeps_strong_late_peer_task_alive():
    async def run():
        stream = Stream()
        stream.peer_cleanup_complete = False
        can_close = asyncio.Event()
        async def peer_close(pc, session, device_id, registry):
            await can_close.wait()
            session.peer_cleanup_complete = True
        report = await cleanup_live_session(
            device_id="phone", stream=stream, pc=object(),
            registry=LiveRegistry(), close_peer=peer_close,
            requested_stop=asyncio.Event(), worker_launch_attempted=True,
            peer_timeout=0.01)
        assert not report.cleaned and report.peer_close_pending
        assert stream.peer_close_task is not None and not stream.peer_close_task.done()
        can_close.set()
        await asyncio.wait_for(stream.peer_close_task, 1)
        assert stream.peer_cleanup_complete
    asyncio.run(run())
