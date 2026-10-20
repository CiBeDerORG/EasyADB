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



def test_deferred_real_peer_close_releases_dirty_session_through_manager(monkeypatch):
    """Timeout leaves worker proof intact; late close retires only its own slot."""
    import importlib

    monkeypatch.setenv("EASYADB_TOKEN", "local-test-token-123")
    app = importlib.import_module("server.app")
    from server.services.session_manager import SessionManager

    class DeferredPeer:
        def __init__(self):
            self.gate = asyncio.Event()
        async def close(self):
            await self.gate.wait()

    async def run():
        registry = LiveRegistry()
        manager = SessionManager(lambda: app.live_registry)
        monkeypatch.setattr(app, "live_registry", registry)
        monkeypatch.setattr(app, "session_manager", manager)
        old = Stream()
        old.peer_cleanup_complete = False
        old.session_id = "old"
        assert manager.reserve("phone", old)
        assert manager.starting("phone", old)
        assert manager.running("phone", old)
        manager.cleaning("phone", old)
        peer = DeferredPeer()
        report = await cleanup_live_session(
            device_id="phone", stream=old, pc=peer, registry=registry,
            close_peer=app._close_webrtc_peer, requested_stop=asyncio.Event(),
            worker_launch_attempted=True, peer_timeout=0.01)
        assert not report.cleaned and report.peer_close_pending
        assert report.worker_finished and report.worker_cleanup
        assert not report.peer_cleanup
        assert old.cleanup_complete and not old.peer_cleanup_complete
        assert not manager.complete("phone", old, clean=False, reason=report.reason)
        assert manager.snapshot("phone", old)["phase"] == "dirty"
        newer = Stream()
        newer.session_id = "new"
        assert not manager.reserve("phone", newer)
        assert registry.sessions["phone"] is old
        peer.gate.set()
        assert await asyncio.wait_for(old.peer_close_task, 1) is True
        assert old.peer_cleanup_complete and registry.is_cleaned(old)
        assert manager.snapshot("phone", old)["phase"] == "released"
        assert "phone" not in registry.sessions
        assert manager.reserve("phone", newer)
        # An old callback may never remove a newly owned session.
        assert not manager.late_cleanup("phone", old)
        assert registry.sessions["phone"] is newer
        assert manager.snapshot("phone", newer)["session_id"] == "new"
    asyncio.run(run())


def test_late_peer_failure_or_unverified_worker_remains_dirty(monkeypatch):
    import importlib

    monkeypatch.setenv("EASYADB_TOKEN", "local-test-token-123")
    app = importlib.import_module("server.app")
    from server.services.session_manager import SessionManager

    class DeferredPeer:
        def __init__(self, failed=False):
            self.gate = asyncio.Event()
            self.failed = failed
        async def close(self):
            await self.gate.wait()
            if self.failed:
                raise RuntimeError("DTLS still owns resources")

    async def run(failed_peer, bad_worker):
        registry = LiveRegistry()
        manager = SessionManager(lambda: app.live_registry)
        monkeypatch.setattr(app, "live_registry", registry)
        monkeypatch.setattr(app, "session_manager", manager)
        old = Stream(cleaned=not bad_worker, throw_on_stop=bad_worker)
        old.session_id = "old"
        old.peer_cleanup_complete = False
        assert manager.reserve("phone", old)
        manager.cleaning("phone", old)
        peer = DeferredPeer(failed_peer)
        report = await cleanup_live_session(
            device_id="phone", stream=old, pc=peer, registry=registry,
            close_peer=app._close_webrtc_peer, requested_stop=asyncio.Event(),
            worker_launch_attempted=True, peer_timeout=0.01)
        assert not report.cleaned and report.peer_close_pending
        assert not manager.complete("phone", old, clean=False, reason=report.reason)
        peer.gate.set()
        assert await asyncio.wait_for(old.peer_close_task, 1) is (not failed_peer)
        assert not registry.is_cleaned(old)
        assert registry.sessions["phone"] is old
        assert manager.snapshot("phone", old)["phase"] == "dirty"
        assert not manager.reserve("phone", Stream())
    asyncio.run(run(True, False))
    asyncio.run(run(False, True))


def test_no_worker_stop_failure_cannot_be_overwritten_by_synthetic_finish():
    async def run():
        stream = Stream(throw_on_stop=True)
        report = await cleanup_live_session(
            device_id="phone", stream=stream, pc=None, registry=LiveRegistry(),
            close_peer=None, requested_stop=asyncio.Event(),
            worker_launch_attempted=False)
        assert report.worker_finished and not report.worker_cleanup
        assert not stream.cleanup_complete and not report.cleaned
    asyncio.run(run())


def test_peer_close_wrapper_exception_does_not_skip_worker_cleanup():
    async def run():
        stream = Stream()
        stream.peer_cleanup_complete = False
        async def bad_close(*args):
            raise RuntimeError("wrapper failed")
        report = await cleanup_live_session(
            device_id="phone", stream=stream, pc=object(),
            registry=LiveRegistry(), close_peer=bad_close,
            requested_stop=asyncio.Event(), worker_launch_attempted=True)
        assert not report.cleaned
        assert "WebRTC peer close raised" in report.problems
        assert stream.calls == ["stop", "join"]
        assert stream.cleanup_complete and not stream.peer_cleanup_complete
    asyncio.run(run())
