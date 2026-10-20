"""Uniform device operation coordination for the incremental V1 migration.

The same DeviceManager RLock is shared with probe/connect and live reservation.
When acquiring multiple locks, always acquire sorted unique IDs. Any registry
lock must be acquired AFTER the device lock(s), never in the opposite order.
Do not hold these locks while waiting for unrelated background tasks.
"""
from contextlib import ExitStack, contextmanager


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
