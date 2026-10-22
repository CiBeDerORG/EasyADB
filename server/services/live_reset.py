"""Explicit reset of all previous live sessions after credential re-entry."""
import time

from ..core.exceptions import DomainError


def reset_live_sessions(*, session_manager, live_registry, timeout=35.0, poll_interval=0.05):
    """Revoke old browser owners, stop their streams, and wait for proof of cleanup.

    No registry slot is force-released. A stream leaves the registry only when
    the same cleanup proofs used by normal WebSocket teardown are satisfied.
    """
    revoked = session_manager.revoke_all_requests("token_reset")
    with live_registry.lock:
        targets = list(live_registry.sessions.items())
    for _device_id, stream in targets:
        try:
            stream.stop()
        except (OSError, RuntimeError, ValueError):
            # Keep fail-closed ownership; timeout below reports the uncleared slot.
            pass

    deadline = time.monotonic() + max(0.0, timeout)
    while True:
        with live_registry.lock:
            current = list(live_registry.sessions.items())
        for device_id, stream in current:
            if not live_registry.is_cleaned(stream):
                continue
            # Preserve SessionManager state when this was one of its sessions.
            if not session_manager.late_cleanup(device_id, stream):
                live_registry.release(device_id, stream)
        with live_registry.lock:
            remaining = list(live_registry.sessions)
        if not remaining:
            return {"cleared": len(targets), "revoked_requests": revoked, "remaining": 0}
        if time.monotonic() >= deadline:
            raise DomainError(
                409,
                "此前实时画面仍有 " + str(len(remaining)) + " 路资源未完成清理，请稍后重新加载设备",
            )
        time.sleep(poll_interval)
