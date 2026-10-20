"""V2-04 bounded admission: short critical section, no ADB or polling."""
from threading import RLock
from weakref import WeakKeyDictionary


class ResourceBudget:
    def __init__(self, max_starting=3):
        if not isinstance(max_starting, int) or not 1 <= max_starting <= 20:
            raise ValueError("max_starting must be between 1 and 20")
        self.max_starting = max_starting
        self._starting = set()
        self._lock = RLock()

    def acquire_start(self, device_id, session_id):
        key = (device_id, session_id)
        with self._lock:
            if key in self._starting:
                return True
            if len(self._starting) >= self.max_starting:
                return False
            self._starting.add(key)
            return True

    def release_start(self, device_id, session_id):
        with self._lock:
            key = (device_id, session_id)
            found = key in self._starting
            self._starting.discard(key)
            return found

    def snapshot(self):
        with self._lock:
            return {"starting": len(self._starting), "max_starting": self.max_starting}


class ScopedResourceBudget:
    """One startup quota per authoritative LiveRegistry, including test overrides.

    Replacing the registry must never leave unrelated sessions consuming
    startup slots. Production's registry remains stable for the process lifetime.
    """
    def __init__(self, registry_provider, max_starting=3):
        self._provider = registry_provider
        self._max_starting = max_starting
        self._lock = RLock()
        self._scopes = WeakKeyDictionary()

    def _scope(self):
        registry = self._provider()
        with self._lock:
            budget = self._scopes.get(registry)
            if budget is None:
                budget = ResourceBudget(self._max_starting)
                self._scopes[registry] = budget
            return budget

    def acquire_start(self, device_id, session_id):
        return self._scope().acquire_start(device_id, session_id)

    def release_start(self, device_id, session_id):
        return self._scope().release_start(device_id, session_id)

    def snapshot(self):
        return self._scope().snapshot()
