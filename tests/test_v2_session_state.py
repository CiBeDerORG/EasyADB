"""V2-01: explicit session ownership and lifecycle invariants."""
from concurrent.futures import ThreadPoolExecutor
import pytest

from server.core.session_state import SessionPhase as Phase, SessionState, InvalidSessionTransition


def test_start_stop_clean_release_requires_resource_proof():
    s = SessionState("phone-A", "session-1")
    assert s.transition(Phase.STARTING)
    assert s.transition(Phase.RUNNING)
    assert s.transition(Phase.STOPPING)
    assert s.transition(Phase.CLEANING)
    with pytest.raises(InvalidSessionTransition, match="verified"):
        s.transition(Phase.RELEASED)
    assert s.phase is Phase.CLEANING
    assert s.transition(Phase.RELEASED, cleanup_verified=True)
    with pytest.raises(InvalidSessionTransition):
        s.transition(Phase.STARTING)


def test_dirty_stays_exclusive_until_explicit_recovery_and_proof():
    s = SessionState("phone-A", "session-2")
    s.transition(Phase.STOPPING)
    s.transition(Phase.CLEANING)
    with pytest.raises(InvalidSessionTransition):
        s.transition(Phase.DIRTY)
    s.transition(Phase.DIRTY, reason="ADB forward cleanup unverified")
    with pytest.raises(InvalidSessionTransition):
        s.transition(Phase.RUNNING)
    with pytest.raises(InvalidSessionTransition):
        s.transition(Phase.RELEASED, cleanup_verified=True)
    s.transition(Phase.CLEANING)
    s.transition(Phase.RELEASED, cleanup_verified=True)
    assert s.phase is Phase.RELEASED


def test_failed_start_can_be_stopped_and_cleaned():
    s = SessionState("phone", "session-3")
    s.transition(Phase.STARTING)
    s.transition(Phase.STOPPING, reason="encoder startup failed")
    s.transition(Phase.CLEANING)
    s.transition(Phase.RELEASED, cleanup_verified=True)
    assert s.snapshot()["phase"] == "released"


def test_invalid_skip_or_duplicate_release_fails_closed():
    s = SessionState("phone", "session-4")
    with pytest.raises(InvalidSessionTransition):
        s.transition(Phase.RUNNING)
    with pytest.raises(InvalidSessionTransition):
        s.transition(Phase.RELEASED, cleanup_verified=True)
    assert s.phase is Phase.RESERVED


def test_concurrent_duplicate_stop_is_idempotent():
    s = SessionState("phone", "session-5")
    s.transition(Phase.STARTING)
    s.transition(Phase.RUNNING)
    with ThreadPoolExecutor(max_workers=8) as pool:
        result = list(pool.map(lambda _: s.transition(Phase.STOPPING), range(24)))
    assert sum(result) == 1
    assert s.phase is Phase.STOPPING
