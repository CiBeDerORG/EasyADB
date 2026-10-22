"""Uniform device operation coordination for the incremental V1 migration.

The same DeviceManager RLock is shared with probe/connect and live reservation.
When acquiring multiple locks, always acquire sorted unique IDs. Any registry
lock must be acquired AFTER the device lock(s), never in the opposite order.
Do not hold these locks while waiting for unrelated background tasks.
"""
from contextlib import ExitStack, contextmanager
import threading

from ..core.exceptions import DomainError


def device_lock(manager, device_id):
    """Return the existing per-device RLock, not a second competing lock."""
    return manager._device_lock(device_id)


@contextmanager
def device_locks(manager, device_ids):
    """Atomically enter an ordered set of per-device operation guards."""
    with ExitStack() as stack:
        for device_id in sorted(set(device_ids)):
            stack.enter_context(device_lock(manager, device_id))
        yield


def require_clean_sessions(live_registry, device_ids, detail, *,
                           session_manager=None, allow_orphan_cleanup=False):
    """Reject unsafe mutations while a browser still owns live resources.

    Callers hold target device locks through the DB write. A page may already
    be gone while its exact old session remains DIRTY/cleaning; same-device
    mutations may allow that orphaned cleanup without freeing its registry
    slot. Deletion remains strict so a new device ID cannot bypass old owner.
    """
    for device_id in device_ids:
        active_request = bool(
            allow_orphan_cleanup
            and session_manager is not None
            and session_manager.has_active_request(device_id)
        )
        with live_registry.lock:
            session = live_registry.sessions.get(device_id)
            unclean = session is not None and not live_registry.is_cleaned(session)
        if not unclean:
            continue
        if allow_orphan_cleanup and session_manager is not None and not active_request:
            continue
        raise DomainError(409, detail)


# Group membership operations acquire this guard before any device RLocks.
_membership_guard = threading.RLock()


def membership_lock():
    return _membership_guard


class GroupBusy(Exception):
    """An explicit scan or an edit already owns the group."""


@contextmanager
def group_operation(guard, locks, group_name):
    """Lock order: group operation -> membership -> sorted device -> registry."""
    with guard:
        mutex = locks.setdefault(group_name, threading.Lock())
    if not mutex.acquire(blocking=False):
        raise GroupBusy(group_name)
    try:
        yield
    finally:
        mutex.release()
