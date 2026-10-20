"""V2-02: SessionManager ownership and fail-closed slot release."""
from threading import Event
from server.m2_live import LiveRegistry
from server.services.session_manager import SessionManager


class Worker:
    def __init__(self, sid):
        self.session_id = sid
        self.finished = Event()
        self.cleanup_complete = False
        self.peer_cleanup_complete = True


def test_coordinator_never_frees_dirty_or_foreign_session():
    registry = LiveRegistry()
    manager = SessionManager(lambda: registry)
    a, newer = Worker("old"), Worker("new")
    assert manager.reserve("phone", a)
    assert manager.starting("phone", a)
    assert manager.running("phone", a)
    assert not manager.reserve("phone", newer)
    manager.stopping("phone", a)
    manager.cleaning("phone", a)
    a.finished.set()
    assert not manager.complete("phone", a, clean=True)
    assert manager.snapshot("phone")["phase"] == "dirty"
    assert registry.sessions["phone"] is a
    assert not manager.reserve("phone", newer)
    a.cleanup_complete = True
    assert manager.late_cleanup("phone", a)
    assert manager.snapshot("phone")["phase"] == "released"
    assert "phone" not in registry.sessions
    assert manager.reserve("phone", newer)
    assert not manager.late_cleanup("phone", a)
    assert registry.sessions["phone"] is newer
    assert manager.snapshot("phone")["session_id"] == "new"


def test_duplicate_stop_and_cross_device_state_isolation():
    registry = LiveRegistry()
    manager = SessionManager(lambda: registry)
    a, b = Worker("session-A"), Worker("session-B")
    assert manager.reserve("A", a) and manager.reserve("B", b)
    assert manager.starting("A", a) and manager.starting("B", b)
    assert manager.running("A", a) and manager.running("B", b)
    assert manager.stopping("A", a)
    assert not manager.stopping("A", a)
    assert manager.snapshot("B")["phase"] == "running"
    manager.cleaning("A", a)
    assert manager.snapshot("A")["phase"] == "cleaning"
    assert manager.summary()["running"] == 1


def test_registry_replacement_does_not_keep_stale_test_state():
    current = LiveRegistry()
    manager = SessionManager(lambda: current)
    assert manager.reserve("A", Worker("first"))
    current = LiveRegistry()
    assert manager.snapshot("A") is None
    assert manager.reserve("A", Worker("second"))
    assert manager.snapshot("A")["session_id"] == "second"
