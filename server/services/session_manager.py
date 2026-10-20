"""V2-02 session coordination, retaining one authoritative LiveRegistry.

All mutations are small and synchronized; no device operation or worker join
occurs while holding the coordinator lock. Dynamic registry provider preserves
the V1 test-injection seam and never spawns an alternate registry.
"""
from threading import RLock
from weakref import WeakKeyDictionary

from ..core.session_state import InvalidSessionTransition, SessionPhase, SessionState


class SessionManager:
    def __init__(self, registry_provider):
        self._registry_provider = registry_provider
        self._lock = RLock()
        self._records = WeakKeyDictionary()

    def _records_for(self, registry):
        return self._records.setdefault(registry, {})

    def _current(self, registry, device_id, session):
        record = self._records_for(registry).get(device_id)
        if record is None or record[0] is not session:
            return None
        return record[1]

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
                return True
            if state.phase is SessionPhase.CLEANING:
                state.transition(SessionPhase.DIRTY, reason=reason)
            return False

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
