"""V2 session lifecycle: explicit, thread-safe, fail-closed state transitions."""
from dataclasses import dataclass, field
from enum import Enum
from threading import RLock
from time import monotonic


class SessionPhase(str, Enum):
    RESERVED = "reserved"
    STARTING = "starting"
    RUNNING = "running"
    STOPPING = "stopping"
    CLEANING = "cleaning"
    RELEASED = "released"
    DIRTY = "dirty"


_ALLOWED = {
    SessionPhase.RESERVED: frozenset((SessionPhase.STARTING, SessionPhase.STOPPING)),
    SessionPhase.STARTING: frozenset((SessionPhase.RUNNING, SessionPhase.STOPPING)),
    SessionPhase.RUNNING: frozenset((SessionPhase.STOPPING,)),
    SessionPhase.STOPPING: frozenset((SessionPhase.CLEANING,)),
    SessionPhase.CLEANING: frozenset((SessionPhase.RELEASED, SessionPhase.DIRTY)),
    SessionPhase.DIRTY: frozenset((SessionPhase.CLEANING,)),
    SessionPhase.RELEASED: frozenset(),
}


class InvalidSessionTransition(ValueError):
    pass


@dataclass
class SessionState:
    device_id: str
    session_id: str
    phase: SessionPhase = SessionPhase.RESERVED
    reason: str | None = None
    updated_at: float = field(default_factory=monotonic)
    _lock: RLock = field(default_factory=RLock, repr=False, compare=False)

    def transition(self, target: SessionPhase, *, reason=None, cleanup_verified=False):
        """Release only after independent cleanup verification, never by timeout."""
        target = SessionPhase(target)
        with self._lock:
            if target is self.phase:
                return False  # idempotent stop/cleanup notifications
            if target not in _ALLOWED[self.phase]:
                raise InvalidSessionTransition(f"{self.phase.value} -> {target.value}")
            if target is SessionPhase.RELEASED and not cleanup_verified:
                raise InvalidSessionTransition("release requires verified cleanup")
            if target is SessionPhase.DIRTY and not reason:
                raise InvalidSessionTransition("dirty state requires diagnostic reason")
            self.phase = target
            self.reason = reason
            self.updated_at = monotonic()
            return True

    def snapshot(self):
        with self._lock:
            return {"device_id": self.device_id, "session_id": self.session_id,
                    "phase": self.phase.value, "reason": self.reason,
                    "updated_at": self.updated_at}
