"""V2-04 bounded admission: short critical section, no ADB or polling."""
from threading import RLock


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
