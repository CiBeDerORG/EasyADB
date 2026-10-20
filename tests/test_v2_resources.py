"""V2-04 resource admission and per-WebRTC-track byte budget tests."""
from concurrent.futures import ThreadPoolExecutor
import asyncio

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
