"""V2-02 session coordination, retaining one authoritative LiveRegistry.

All mutations are small and synchronized; no device operation or worker join
occurs while holding the coordinator lock. Dynamic registry provider preserves
the V1 test-injection seam and never spawns an alternate registry.
"""
import logging
from threading import RLock
from weakref import WeakKeyDictionary

from ..core.session_state import InvalidSessionTransition, SessionPhase, SessionState
from .live_request import LiveRequest, LiveRequestScope


class SessionManager:
    def __init__(self, registry_provider):
        self._registry_provider = registry_provider
        self._lock = RLock()
        self._records = WeakKeyDictionary()
        self._request_owner = object()
        self._request_scopes = WeakKeyDictionary()

    def _records_for(self, registry):
        return self._records.setdefault(registry, {})

    def _current(self, registry, device_id, session):
        record = self._records_for(registry).get(device_id)
        if record is None or record[0] is not session:
            return None
        return record[1]

    def _requests_for(self, registry):
        scope = self._request_scopes.get(registry)
        if scope is None:
            scope = LiveRequestScope(self._request_owner)
            self._request_scopes[registry] = scope
        return scope

    def _owns_request(self, device_id, ticket):
        return (isinstance(ticket, LiveRequest)
                and ticket.scope.owner is self._request_owner
                and ticket.device_id == device_id)

    def _request_is_latest(self, registry, device_id, ticket):
        return (self._owns_request(device_id, ticket)
                and self._request_scopes.get(registry) is ticket.scope
                and ticket.scope.latest.get(device_id) is ticket
                and not ticket.cancelled.is_set()
                and not ticket.replaced.is_set())

    @staticmethod
    def _notify_request(device_id, callback):
        # Notifications may enter an event loop or call this coordinator.
        # They must never run with its lock held or undo a committed change.
        if callback is not None:
            try:
                callback()
            except Exception:
                logging.getLogger(__name__).exception(
                    "Live request notification failed for device %s", device_id)

    def begin_request(self, device_id, *, on_replaced, on_changed):
        registry = self._registry_provider()
        with self._lock:
            scope = self._requests_for(registry)
            scope.next_sequence += 1
            # Creating a ticket does not disturb a live session. The caller
            # publishes it only after authentication, options and device checks.
            return LiveRequest(device_id, scope.next_sequence, scope,
                               on_replaced, on_changed)

    def publish_request(self, device_id, ticket):
        registry = self._registry_provider()
        callback = None
        with self._lock:
            if (not self._owns_request(device_id, ticket)
                    or self._request_scopes.get(registry) is not ticket.scope
                    or ticket.cancelled.is_set() or ticket.replaced.is_set()):
                return False
            scope = ticket.scope
            if scope.latest.get(device_id) is ticket:
                return True
            if ticket.sequence <= scope.high_water.get(device_id, 0):
                return False
            previous = scope.latest.get(device_id)
            scope.high_water[device_id] = ticket.sequence
            scope.latest[device_id] = ticket
            if previous is not None:
                previous.replaced.set()
                # Revoke commands before scheduling the old handler's cleanup.
                # No stop/join/socket operation runs in this critical section.
                stop_event = getattr(previous.stream, "stop_event", None)
                if stop_event is not None:
                    stop_event.set()
                callback = previous.on_replaced
        self._notify_request(device_id, callback)
        return True

    def is_latest_request(self, device_id, ticket):
        registry = self._registry_provider()
        with self._lock:
            return self._request_is_latest(registry, device_id, ticket)

    def has_active_request(self, device_id):
        """Return whether a browser still owns an explicit live request."""
        registry = self._registry_provider()
        with self._lock:
            scope = self._request_scopes.get(registry)
            ticket = scope.latest.get(device_id) if scope is not None else None
            return self._request_is_latest(registry, device_id, ticket)

    def reserve_latest(self, device_id, ticket, candidate):
        registry = self._registry_provider()
        with self._lock:
            if not self._request_is_latest(registry, device_id, ticket):
                return "superseded"
            if ticket.stream is not None:
                # One ticket cannot change owners after a successful reserve.
                with registry.lock:
                    current = registry.sessions.get(device_id)
                return ("reserved" if ticket.stream is candidate and current is candidate
                        else "superseded")
            with registry.lock:
                previous = registry.sessions.get(device_id)
                if previous is not None and not registry.is_cleaned(previous):
                    # Observe the blocked owner before attempting reserve. A
                    # late peer may release directly, then notify through this
                    # manager; do not misreport that handoff as global capacity.
                    return "waiting"
            if self.reserve(device_id, candidate):
                ticket.stream = candidate
                return "reserved"
            with registry.lock:
                previous = registry.sessions.get(device_id)
                waiting = previous is not None and not registry.is_cleaned(previous)
            return "waiting" if waiting else "full"

    def finish_request(self, device_id, ticket):
        with self._lock:
            if not self._owns_request(device_id, ticket):
                return False
            ticket.cancelled.set()
            ticket.on_replaced = None
            ticket.on_changed = None
            current = ticket.scope.latest.get(device_id) is ticket
            if current:
                ticket.scope.latest.pop(device_id)
            # Keep high_water even after the newest request leaves: an older
            # validation thread must never revive its now-obsolete intent.
            return current

    def reserve(self, device_id, session):
        registry = self._registry_provider()
        with self._lock:
            if not registry.reserve(device_id, session):
                return False
            state = SessionState(device_id, session.session_id)
            self._records_for(registry)[device_id] = (session, state)
            return True

    def _mark(self, device_id, session, phase, reason=None):
        registry = self._registry_provider()
        with self._lock:
            state = self._current(registry, device_id, session)
            if state is None:
                return False
            try:
                return state.transition(phase, reason=reason)
            except InvalidSessionTransition:
                # A stop/cleanup already won the race. Never resurrect it.
                return False

    def starting(self, device_id, session):
        return self._mark(device_id, session, SessionPhase.STARTING)

    def running(self, device_id, session):
        return self._mark(device_id, session, SessionPhase.RUNNING)

    def stopping(self, device_id, session, reason=None):
        return self._mark(device_id, session, SessionPhase.STOPPING, reason=reason)

    def cleaning(self, device_id, session):
        self.stopping(device_id, session)
        return self._mark(device_id, session, SessionPhase.CLEANING)

    def complete(self, device_id, session, *, clean, reason="资源清理尚未确认"):
        registry = self._registry_provider()
        callback = None
        with self._lock:
            state = self._current(registry, device_id, session)
            if state is None:
                return False
            if state.phase not in (SessionPhase.CLEANING, SessionPhase.RELEASED, SessionPhase.DIRTY):
                self.cleaning(device_id, session)
            if clean and registry.is_cleaned(session):
                if state.phase is SessionPhase.DIRTY:
                    state.transition(SessionPhase.CLEANING)
                if state.phase is SessionPhase.CLEANING:
                    state.transition(SessionPhase.RELEASED, cleanup_verified=True)
                registry.release(device_id, session)
                scope = self._request_scopes.get(registry)
                ticket = scope.latest.get(device_id) if scope is not None else None
                if self._request_is_latest(registry, device_id, ticket):
                    callback = ticket.on_changed
            else:
                if state.phase is SessionPhase.CLEANING:
                    state.transition(SessionPhase.DIRTY, reason=reason)
                return False
        self._notify_request(device_id, callback)
        return True

    def late_cleanup(self, device_id, session):
        """Peer-close callback may arrive after the authenticated WS is gone."""
        registry = self._registry_provider()
        if not registry.is_cleaned(session):
            return False
        return self.complete(device_id, session, clean=True)

    def snapshot(self, device_id, session=None):
        registry = self._registry_provider()
        with self._lock:
            record = self._records_for(registry).get(device_id)
            if record is None or (session is not None and record[0] is not session):
                return None
            return record[1].snapshot()

    def summary(self):
        registry = self._registry_provider()
        with self._lock:
            records = list(self._records_for(registry).values())
        counts = {phase.value: 0 for phase in SessionPhase}
        for _, state in records:
            counts[state.snapshot()["phase"]] += 1
        return counts
