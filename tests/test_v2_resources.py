"""V2-04 resource admission and per-WebRTC-track byte budget tests."""
from concurrent.futures import ThreadPoolExecutor
import asyncio
import threading

import pytest
from aiortc.mediastreams import MediaStreamError

from server.services.resource_budget import ResourceBudget
import server.m2_webrtc as webrtc


CONFIG = b"\x00\x00\x00\x01\x67\x42\xc0\x1f"
KEY = b"\x00\x00\x00\x01\x65"
DELTA = b"\x00\x00\x00\x01\x41"


def test_start_budget_is_bounded_under_parallel_admission():
    budget = ResourceBudget(max_starting=3)
    with ThreadPoolExecutor(max_workers=12) as pool:
        grants = list(pool.map(lambda i: budget.acquire_start(str(i), str(i)), range(20)))
    assert sum(grants) == 3
    assert budget.snapshot() == {"starting": 3, "max_starting": 3}
    assert budget.release_start("0", "0") == bool(grants[0])
    assert budget.snapshot()["starting"] <= 3
    assert budget.acquire_start("new", "new")
    assert budget.release_start("new", "new")
    assert not budget.release_start("new", "new")


def test_byte_budget_drops_old_packets_and_requires_new_idr(monkeypatch):
    monkeypatch.setattr(webrtc, "MAX_PENDING_BYTES", 120)

    async def run():
        t = webrtc.ScrcpyH264Track(asyncio.get_running_loop())
        t._submit_on_loop(0, CONFIG, True, False)
        t._submit_on_loop(1, KEY + b"a" * 50, False, True)
        t._submit_on_loop(2, DELTA + b"b" * 50, False, False)
        assert t._queued_bytes <= 120
        t._submit_on_loop(3, DELTA + b"c" * 50, False, False)
        assert t.need_keyframe and t.frames.empty()
        t._submit_on_loop(4, DELTA, False, False)
        assert t.frames.empty()
        t._submit_on_loop(5, KEY + b"d" * 4, False, True)
        assert (await asyncio.wait_for(t.recv(), 1)).size <= 120
        assert t._queued_bytes == 0
        t.stop()
        await asyncio.sleep(0)
    asyncio.run(run())


def test_single_oversized_access_unit_never_enters_queue(monkeypatch):
    monkeypatch.setattr(webrtc, "MAX_PENDING_BYTES", 32)
    async def run():
        t = webrtc.ScrcpyH264Track(asyncio.get_running_loop())
        t._submit_on_loop(0, CONFIG, True, False)
        t._submit_on_loop(1, KEY + b"x" * 40, False, True)
        assert t.frames.empty() and t._queued_bytes == 0
        assert t.need_keyframe
        t.stop()
        await asyncio.sleep(0)
    asyncio.run(run())


def test_start_concurrency_config_validation(tmp_path):
    import pytest
    from server.core.config import load_settings
    env = {"EASYADB_TOKEN": "local-test-token-123",
           "EASYADB_DB": str(tmp_path / "resources.sqlite3")}
    assert load_settings(env).max_starting == 3
    assert load_settings({**env, "EASYADB_MAX_STARTING": "5"}).max_starting == 5
    for value in ("0", "21", "many", "-1"):
        with pytest.raises(RuntimeError, match="EASYADB_MAX_STARTING"):
            load_settings({**env, "EASYADB_MAX_STARTING": value})


def test_each_runtime_registry_owns_independent_start_budget():
    from server.m2_live import LiveRegistry
    from server.services.resource_budget import ScopedResourceBudget
    registry = LiveRegistry()
    scoped = ScopedResourceBudget(lambda: registry, max_starting=1)
    assert scoped.acquire_start("A", "one")
    assert not scoped.acquire_start("B", "two")
    registry = LiveRegistry()
    assert scoped.snapshot()["starting"] == 0
    assert scoped.acquire_start("B", "two")
    assert not scoped.acquire_start("C", "three")
    assert scoped.release_start("B", "two")



def test_reader_thread_callback_backlog_has_independent_byte_and_count_limits(monkeypatch):
    """A blocked event loop must never retain an unlimited list of payload closures."""
    monkeypatch.setattr(webrtc, "MAX_SUBMIT_CALLBACKS", 3)
    monkeypatch.setattr(webrtc, "MAX_SUBMIT_BYTES", 80)

    async def run():
        track = webrtc.ScrcpyH264Track(asyncio.get_running_loop())
        track._submit_on_loop(0, CONFIG, True, False)
        payload = KEY + b"x" * 20
        # Block the loop while many producer calls compete for the same track.
        def producer(first):
            for i in range(250):
                track.submit(first + i, payload, keyframe=True)
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(producer, range(0, 2000, 250)))
        with track._submit_lock:
            assert track._pending_callbacks <= 3
            assert track._pending_bytes <= 80
            assert track._overflow_notice_scheduled
            assert track._rejected_submissions >= 1997
        await asyncio.sleep(0)
        assert track._pending_callbacks == track._pending_bytes == 0
        assert not track._overflow_notice_scheduled
        assert track.frames.empty() and track.need_keyframe
        assert track.dropped_frames >= 1997
        # No stale delta packet may be delivered after a dropped callback.
        track.submit(3000, DELTA)
        await asyncio.sleep(0)
        assert track.frames.empty()
        track.submit(3001, KEY, keyframe=True)
        await asyncio.sleep(0)
        assert bytes(await asyncio.wait_for(track.recv(), 1)) == CONFIG + KEY
        track.stop()
        await asyncio.sleep(0)
    asyncio.run(run())


def test_oversize_submission_is_never_held_by_callback_and_recovers_on_idr(monkeypatch):
    monkeypatch.setattr(webrtc, "MAX_SUBMIT_BYTES", 64)

    async def run():
        track = webrtc.ScrcpyH264Track(asyncio.get_running_loop())
        track._submit_on_loop(0, CONFIG, True, False)
        huge = KEY + b"x" * 1_000_000
        worker = threading.Thread(target=lambda: track.submit(1, huge, keyframe=True))
        worker.start()
        worker.join(timeout=2)
        assert not worker.is_alive()
        with track._submit_lock:
            assert track._pending_callbacks == 0
            assert track._pending_bytes == 0
            assert track._overflow_notice_scheduled
        await asyncio.sleep(0)
        assert track.need_keyframe and track.frames.empty()
        track.submit(2, KEY, keyframe=True)
        await asyncio.sleep(0)
        assert bytes(await asyncio.wait_for(track.recv(), 1)) == CONFIG + KEY
        track.stop()
        await asyncio.sleep(0)
    asyncio.run(run())


def test_stop_racing_producer_disables_new_submission_and_unblocks_recv(monkeypatch):
    monkeypatch.setattr(webrtc, "MAX_SUBMIT_CALLBACKS", 4)
    monkeypatch.setattr(webrtc, "MAX_SUBMIT_BYTES", 96)

    async def run():
        track = webrtc.ScrcpyH264Track(asyncio.get_running_loop())
        track._submit_on_loop(0, CONFIG, True, False)
        started = threading.Event()

        def produce():
            started.set()
            for i in range(5000):
                track.submit(i + 1, KEY + b"a" * 18, keyframe=True)

        worker = threading.Thread(target=produce)
        worker.start()
        assert await asyncio.to_thread(started.wait, 2)
        track.stop()  # atomically closes the producer gate
        await asyncio.to_thread(worker.join, 2)
        assert not worker.is_alive()
        with track._submit_lock:
            assert not track._accepting
            assert track._pending_callbacks <= 4
            assert track._pending_bytes <= 96
        track.submit(99999, KEY, keyframe=True)
        await asyncio.sleep(0)
        assert track.closed
        assert track._pending_callbacks == track._pending_bytes == 0
        with pytest.raises(MediaStreamError):
            await asyncio.wait_for(track.recv(), 1)
    asyncio.run(run())


def test_submission_failure_returns_reserved_budget_and_does_not_touch_queue():
    class ClosedLoop:
        def call_soon_threadsafe(self, *args):
            raise RuntimeError("Event loop is closed")

    track = webrtc.ScrcpyH264Track(ClosedLoop())
    track.submit(1, KEY, keyframe=True)
    assert track._pending_callbacks == 0
    assert track._pending_bytes == 0
    assert track.frames.empty()
    assert not track._accepting
    track.stop()
    assert track.closed
    track.stop()  # idempotent even if the owning loop never accepted stop
