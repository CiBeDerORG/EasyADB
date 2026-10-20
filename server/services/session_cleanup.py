"""V2-03: bounded, fail-closed shutdown for one explicit WebRTC session.

The peer close task is *shielded*: a WS timeout never cancels unfinished
DTLS/ICE cleanup. Only verified cleanup may release a LiveRegistry slot.
"""
import asyncio
import logging
from dataclasses import dataclass


@dataclass(frozen=True)
class CleanupReport:
    cleaned: bool
    worker_finished: bool
    worker_cleanup: bool
    peer_cleanup: bool
    peer_close_pending: bool
    problems: tuple[str, ...]

    @property
    def reason(self):
        return "; ".join(self.problems) or "worker or WebRTC peer cleanup was not verified"


async def _cancel(task):
    if task is not None:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def cleanup_live_session(*, device_id, stream, pc, registry, close_peer,
                               requested_stop, watchdog=None, receiver=None,
                               unlock_task=None, worker_launch_attempted=False,
                               peer_timeout=10, join_timeout=20):
    requested_stop.set()
    await _cancel(watchdog)
    if stream is None:
        return None
    problems = []
    try:
        await asyncio.to_thread(stream.stop)
    except (OSError, RuntimeError, ValueError):
        problems.append("worker stop raised")
    await _cancel(unlock_task)
    # Wait until offer negotiation has stopped before closing aiortc.
    await _cancel(receiver)
    peer_close_pending = False
    if pc is not None:
        stream.peer_close_task = asyncio.create_task(
            close_peer(pc, stream, device_id, registry))
        try:
            await asyncio.wait_for(asyncio.shield(stream.peer_close_task), peer_timeout)
        except asyncio.TimeoutError:
            peer_close_pending = True
            problems.append("WebRTC peer close unverified")
            logging.getLogger(__name__).warning(
                "WebRTC peer close pending for device %s session %s",
                device_id, stream.session_id)
    if not worker_launch_attempted:
        # SDP setup did not even attempt ADB/worker startup.
        stream.cleanup_complete = True
        stream.finished.set()
        if getattr(stream, "webrtc_track", None) is not None:
            stream.webrtc_track.stop()
    try:
        await asyncio.to_thread(stream.join, join_timeout)
    except (OSError, RuntimeError, ValueError):
        problems.append("worker join raised")
    if problems:
        stream.cleanup_complete = False
    worker_finished = bool(stream.finished.is_set())
    worker_cleanup = bool(getattr(stream, "cleanup_complete", False))
    peer_cleanup = bool(getattr(stream, "peer_cleanup_complete", False))
    cleaned = registry.is_cleaned(stream) and not peer_close_pending and not problems
    if not worker_finished:
        problems.append("worker thread not finished")
    if not worker_cleanup:
        problems.append("ADB/scrcpy resource cleanup unverified")
    if not peer_cleanup:
        problems.append("WebRTC peer resource cleanup unverified")
    return CleanupReport(cleaned, worker_finished, worker_cleanup,
                         peer_cleanup, peer_close_pending, tuple(problems))
