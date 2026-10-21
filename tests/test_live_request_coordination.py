"""Latest explicit requests coordinate through the real registry and manager."""
from threading import Event, Thread

import pytest

from server.m2_live import LiveRegistry
from server.services.session_manager import SessionManager


class Worker:
    def __init__(self, session_id):
        self.session_id = session_id
        self.stop_event = Event()
        self.finished = Event()
        self.cleanup_complete = False
        self.peer_cleanup_complete = True

    def prove_cleanup(self):
        self.cleanup_complete = True
        self.peer_cleanup_complete = True
        self.finished.set()


@pytest.fixture
def runtime():
    registry = LiveRegistry()
    return registry, SessionManager(lambda: registry)


def request(manager, device_id="phone", *, replaced=None, changed=None):
    return manager.begin_request(device_id, on_replaced=replaced, on_changed=changed)


def reserve_request(manager, device_id, session_id, **callbacks):
    ticket = request(manager, device_id, **callbacks)
    assert manager.publish_request(device_id, ticket)
    stream = Worker(session_id)
    assert manager.reserve_latest(device_id, ticket, stream) == "reserved"
    return ticket, stream


def test_unpublished_or_invalid_request_never_disturbs_the_current_session(runtime):
    registry, manager = runtime
    replaced = []
    active, stream = reserve_request(manager, "phone", "active", replaced=lambda: replaced.append(True))
    unchecked = request(manager)
    assert unchecked.stream is None
    assert not unchecked.replaced.is_set() and not unchecked.cancelled.is_set()
    assert manager.reserve_latest("phone", unchecked, Worker("unchecked")) == "superseded"
    assert not manager.finish_request("phone", unchecked)
    assert manager.is_latest_request("phone", active)
    assert not active.replaced.is_set() and not stream.stop_event.is_set()
    assert registry.sessions == {"phone": stream}
    assert not replaced


def test_latest_waiter_wins_without_replacing_the_unclean_resource(runtime):
    registry, manager = runtime
    replaced, changed = [], []
    first, old = reserve_request(manager, "phone", "A", replaced=lambda: replaced.append("A"))
    second = request(manager, replaced=lambda: replaced.append("B"), changed=lambda: changed.append("B"))
    assert manager.publish_request("phone", second)
    assert first.replaced.is_set() and old.stop_event.is_set()
    assert registry.sessions["phone"] is old
    assert manager.reserve_latest("phone", second, Worker("B")) == "waiting"
    third = request(manager, changed=lambda: changed.append("C"))
    assert manager.publish_request("phone", third)
    assert second.replaced.is_set()
    assert manager.reserve_latest("phone", second, Worker("late-B")) == "superseded"
    assert manager.reserve_latest("phone", first, Worker("late-A")) == "superseded"
    assert manager.reserve_latest("phone", third, Worker("C")) == "waiting"
    assert second.stream is None and third.stream is None
    assert replaced == ["A", "B"]
    assert not manager.finish_request("phone", second)
    assert manager.is_latest_request("phone", third)
    assert registry.sessions["phone"] is old
    old.prove_cleanup()
    assert manager.complete("phone", old, clean=True)
    assert changed == ["C"]
    newest = Worker("C")
    assert manager.reserve_latest("phone", third, newest) == "reserved"
    assert registry.sessions == {"phone": newest}
    assert third.stream is newest
    assert not manager.late_cleanup("phone", old)
    assert not manager.finish_request("phone", first)
    assert manager.is_latest_request("phone", third)
    assert not newest.stop_event.is_set()


def test_published_high_water_survives_finish_and_rejects_late_validation(runtime):
    registry, manager = runtime
    slow = request(manager)
    newer = request(manager)
    assert slow.sequence < newer.sequence
    assert manager.publish_request("phone", newer)
    assert manager.finish_request("phone", newer)
    assert not manager.publish_request("phone", slow)
    assert manager.reserve_latest("phone", slow, Worker("late")) == "superseded"
    assert not registry.sessions
    future = request(manager)
    assert manager.publish_request("phone", future)
    assert manager.is_latest_request("phone", future)


def test_request_order_is_per_device_even_when_validation_finishes_out_of_order(runtime):
    _, manager = runtime
    earlier_other = request(manager, "other")
    newer_phone = request(manager)
    assert manager.publish_request("phone", newer_phone)
    assert manager.publish_request("other", earlier_other)
    assert manager.is_latest_request("phone", newer_phone)
    assert manager.is_latest_request("other", earlier_other)


def test_publish_and_same_candidate_reservation_are_idempotent(runtime):
    registry, manager = runtime
    replaced = []
    first, old = reserve_request(manager, "phone", "A", replaced=lambda: replaced.append(True))
    second = request(manager)
    assert manager.publish_request("phone", second)
    assert manager.publish_request("phone", second)
    assert replaced == [True] and first.replaced.is_set()
    old.prove_cleanup()
    assert manager.complete("phone", old, clean=True)
    candidate = Worker("B")
    assert manager.reserve_latest("phone", second, candidate) == "reserved"
    assert manager.starting("phone", candidate)
    assert manager.reserve_latest("phone", second, candidate) == "reserved"
    assert manager.snapshot("phone")["phase"] == "starting"
    assert manager.reserve_latest("phone", second, Worker("unrelated")) == "superseded"
    assert registry.sessions["phone"] is candidate


def test_finishing_only_retires_its_ticket_and_keeps_resource_proof_required(runtime):
    registry, manager = runtime
    changed = []
    ticket, stream = reserve_request(manager, "phone", "A", replaced=lambda: None,
                                     changed=lambda: changed.append(True))
    assert manager.finish_request("phone", ticket)
    assert ticket.cancelled.is_set()
    assert ticket.on_replaced is None and ticket.on_changed is None
    assert not manager.finish_request("phone", ticket)
    assert not manager.publish_request("phone", ticket)
    assert manager.reserve_latest("phone", ticket, Worker("late")) == "superseded"
    assert registry.sessions["phone"] is stream
    assert not manager.complete("phone", stream, clean=True)
    assert manager.snapshot("phone")["phase"] == "dirty"
    stream.prove_cleanup()
    assert manager.late_cleanup("phone", stream)
    assert not registry.sessions and not changed


def test_cancelled_ticket_cannot_publish_or_acquire_a_resource(runtime):
    registry, manager = runtime
    unpublished = request(manager)
    unpublished.cancelled.set()
    assert not manager.publish_request("phone", unpublished)
    published = request(manager)
    assert manager.publish_request("phone", published)
    published.cancelled.set()
    assert not manager.is_latest_request("phone", published)
    assert not manager.publish_request("phone", published)
    assert manager.reserve_latest("phone", published, Worker("cancelled")) == "superseded"
    assert not registry.sessions


@pytest.mark.parametrize("missing_proof", ["worker", "resources", "peer"])
def test_dirty_session_keeps_its_slot_until_every_proof_is_present(runtime, missing_proof):
    registry, manager = runtime
    _, old = reserve_request(manager, "phone", "A")
    old.prove_cleanup()
    if missing_proof == "worker":
        old.finished.clear()
    elif missing_proof == "resources":
        old.cleanup_complete = False
    else:
        old.peer_cleanup_complete = False
    changed = []
    latest = request(manager, changed=lambda: changed.append(True))
    assert manager.publish_request("phone", latest)
    assert not manager.complete("phone", old, clean=True)
    assert manager.snapshot("phone")["phase"] == "dirty"
    assert manager.reserve_latest("phone", latest, Worker("B")) == "waiting"
    assert not manager.late_cleanup("phone", old)
    assert registry.sessions == {"phone": old} and not changed
    old.prove_cleanup()
    assert manager.late_cleanup("phone", old)
    assert changed == [True]
    assert manager.snapshot("phone")["phase"] == "released"
    assert manager.reserve_latest("phone", latest, Worker("B")) == "reserved"


def test_verified_old_resource_may_be_replaced_before_its_late_callback(runtime):
    registry, manager = runtime
    _, old = reserve_request(manager, "phone", "A")
    latest = request(manager)
    assert manager.publish_request("phone", latest)
    old.prove_cleanup()
    newer = Worker("B")
    assert manager.reserve_latest("phone", latest, newer) == "reserved"
    assert not manager.late_cleanup("phone", old)
    assert registry.sessions == {"phone": newer}
    assert manager.snapshot("phone")["session_id"] == "B"


def test_twenty_slots_distinguish_waiting_for_same_device_from_global_capacity(runtime):
    registry, manager = runtime
    _, old = reserve_request(manager, "phone", "A")
    others = {f"other-{n}": Worker(f"other-{n}") for n in range(19)}
    for device_id, stream in others.items():
        assert manager.reserve(device_id, stream)
    assert len(registry.sessions) == 20 == registry.MAX_LIVE_SESSIONS
    latest = request(manager)
    assert manager.publish_request("phone", latest)
    assert manager.reserve_latest("phone", latest, Worker("B")) == "waiting"
    overflow = request(manager, "extra")
    assert manager.publish_request("extra", overflow)
    assert manager.reserve_latest("extra", overflow, Worker("overflow")) == "full"
    assert overflow.stream is None
    assert len(registry.sessions) == 20
    old.prove_cleanup()
    assert manager.late_cleanup("phone", old)
    assert manager.reserve_latest("phone", latest, Worker("B")) == "reserved"
    assert len(registry.sessions) == 20
    for device_id, stream in others.items():
        assert registry.sessions[device_id] is stream
        assert not stream.stop_event.is_set()


def test_request_identity_does_not_cross_device_or_manager(runtime):
    registry, manager = runtime
    active, stream = reserve_request(manager, "phone", "A")
    other = SessionManager(lambda: registry)
    foreign = request(other)
    assert not manager.publish_request("phone", foreign)
    assert manager.reserve_latest("phone", foreign, Worker("foreign")) == "superseded"
    assert not other.finish_request("phone", active)
    assert not active.cancelled.is_set()
    assert not manager.publish_request("other", active)
    assert not manager.finish_request("other", active)
    assert manager.is_latest_request("phone", active)
    assert registry.sessions == {"phone": stream}


def test_registry_replacement_keeps_request_scopes_isolated():
    original = current = LiveRegistry()
    manager = SessionManager(lambda: current)
    replaced = []
    old, old_stream = reserve_request(manager, "phone", "old", replaced=lambda: replaced.append(True))
    current = LiveRegistry()
    latest, stream = reserve_request(manager, "phone", "new")
    assert not manager.is_latest_request("phone", old)
    assert not manager.publish_request("phone", old)
    assert manager.reserve_latest("phone", old, Worker("late-old")) == "superseded"
    assert manager.finish_request("phone", old)
    assert manager.is_latest_request("phone", latest)
    assert current.sessions == {"phone": stream}
    assert original.sessions == {"phone": old_stream}
    assert not replaced and not stream.stop_event.is_set()
    current = original
    assert not manager.is_latest_request("phone", old)
    assert not manager.publish_request("phone", old)


@pytest.mark.parametrize("notification", ["replaced", "changed"])
def test_notifications_run_outside_both_coordinator_and_registry_locks(runtime, notification):
    registry, manager = runtime
    observations = []
    threads = []

    def callback():
        entered = Event()
        def inspect():
            manager.summary()
            with registry.lock:
                entered.set()
        thread = Thread(target=inspect, daemon=True)
        threads.append(thread)
        thread.start()
        observations.append(entered.wait(1))

    _, old = reserve_request(manager, "phone", "A", replaced=callback if notification == "replaced" else None)
    latest = request(manager, changed=callback if notification == "changed" else None)
    assert manager.publish_request("phone", latest)
    if notification == "changed":
        old.prove_cleanup()
        assert manager.late_cleanup("phone", old)
    for thread in threads:
        thread.join(1)
        assert not thread.is_alive()
    assert observations == [True]


def test_publish_cannot_interleave_latest_check_and_resource_reservation(runtime, monkeypatch):
    registry, manager = runtime
    first = request(manager)
    assert manager.publish_request("phone", first)
    second = request(manager)
    entered, release, publishing, published = Event(), Event(), Event(), Event()
    reserve = manager.reserve
    outcomes = {}

    def blocked_reserve(device_id, stream):
        entered.set()
        assert release.wait(3)
        return reserve(device_id, stream)

    monkeypatch.setattr(manager, "reserve", blocked_reserve)
    candidate = Worker("A")
    def acquire():
        outcomes["reserve"] = manager.reserve_latest("phone", first, candidate)
    reserving = Thread(target=acquire)
    def publish():
        publishing.set()
        outcomes["publish"] = manager.publish_request("phone", second)
        published.set()
    replacing = Thread(target=publish)
    reserving.start()
    try:
        assert entered.wait(1)
        replacing.start()
        assert publishing.wait(1)
        assert not published.is_set()
    finally:
        release.set()
        reserving.join(2)
        if replacing.ident is not None:
            replacing.join(2)
    assert not reserving.is_alive() and not replacing.is_alive()
    assert outcomes == {"reserve": "reserved", "publish": True}
    assert registry.sessions == {"phone": candidate}
    assert first.stream is candidate and candidate.stop_event.is_set()
    assert first.replaced.is_set() and manager.is_latest_request("phone", second)


@pytest.mark.parametrize("notification", ["replaced", "changed"])
def test_failed_notification_does_not_undo_resource_or_request_state(runtime, notification, caplog):
    registry, manager = runtime
    def broken():
        raise RuntimeError("closed mock event loop")
    first, old = reserve_request(manager, "phone", "A", replaced=broken if notification == "replaced" else None)
    latest = request(manager, changed=broken if notification == "changed" else None)
    assert manager.publish_request("phone", latest)
    assert first.replaced.is_set() and old.stop_event.is_set()
    assert registry.sessions["phone"] is old
    if notification == "changed":
        old.prove_cleanup()
        assert manager.late_cleanup("phone", old)
        assert not registry.sessions
        assert manager.snapshot("phone")["phase"] == "released"
    assert manager.is_latest_request("phone", latest)
    assert "Live request notification failed" in caplog.text
