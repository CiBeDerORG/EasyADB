"""Zero-transcode scrcpy H.264 -> aiortc encoded-packet video track.

The track belongs to one explicit EasyADB WS session. Phone packet PTS are
microseconds; aiortc's H264 packetizer converts these to RTP's 90 kHz clock.
No decoder, FFmpeg remuxer, global capture or background reconnect is used.
"""
import asyncio
import threading
from collections import deque
from fractions import Fraction

from av import Packet
from aiortc import MediaStreamTrack
from aiortc.mediastreams import MediaStreamError

MAX_PENDING_FRAMES = 48
MAX_PENDING_BYTES = 16 * 1024 * 1024
# A second bound covers submitted payloads BEFORE they reach the asyncio
# frame queue. A single callback drains this bounded cross-thread mailbox.
MAX_SUBMIT_CALLBACKS = 48
MAX_SUBMIT_BYTES = 16 * 1024 * 1024
MAX_CONFIG_BYTES = 256 * 1024
PHONE_CLOCK_RATE = 1_000_000
RTP_CLOCK_RATE = 90_000
SENTINEL = object()


class ScrcpyH264Track(MediaStreamTrack):
    kind = "video"

    def __init__(self, loop):
        super().__init__()
        self.loop = loop
        self.frames = asyncio.Queue(maxsize=MAX_PENDING_FRAMES)
        self.config = None
        self.need_keyframe = True
        self.last_pts = None
        self._pts_offset = 0
        self._new_segment = True
        self.closed = False
        self.dropped_frames = 0
        self.sent_frames = 0
        self._queued_bytes = 0
        self._submit_lock = threading.Lock()
        self._accepting = True
        self._stop_scheduled = False
        self._pending_callbacks = 0
        self._pending_bytes = 0
        self._pending = deque()
        self._pending_sequence = 0
        self._drain_scheduled = False
        self._overflow_notice_scheduled = False
        self._rejected_submissions = 0
        self._reset_notice_scheduled = False

    def reset_stream(self):
        """Begin a new encoder segment without closing this WebRTC track.

        scrcpy sends a new session header when rotation restarts its encoder.
        Serialize this marker with submit() and immediately release the old
        pending payloads. The new segment's one-shot SPS/PPS must fit even
        when the event loop has not drained a full previous segment.
        """
        with self._submit_lock:
            if not self._accepting:
                return
            self._discard_pending_locked()
            self._reset_notice_scheduled = True
            self._append_pending_locked("reset")

    def _reset_on_loop(self):
        if self.closed:
            return
        while not self.frames.empty():
            self.frames.get_nowait()
        self._queued_bytes = 0
        self.config = None
        self.need_keyframe = True
        # Keep the outgoing clock, but let the new encoder segment establish
        # its own source offset. Subsequent frame intervals remain intact.
        self._pts_offset = 0
        self._new_segment = True

    def submit(self, pts_us, payload, *, config=False, keyframe=False):
        """Reserve the count/byte budget BEFORE retaining an ADB payload.

        Neither asyncio.Queue nor track codec state is touched by the reader.
        Reset, backpressure and media share one ordered, bounded mailbox;
        the loop callback itself never captures a screen payload.
        """
        if config and len(payload) > MAX_CONFIG_BYTES:
            payload = b""  # preserve old behavior: invalidate oversized config
        size = len(payload)
        with self._submit_lock:
            if not self._accepting:
                return
            if (self._overflow_notice_scheduled
                    or self._pending_callbacks >= MAX_SUBMIT_CALLBACKS
                    or size > MAX_SUBMIT_BYTES
                    or self._pending_bytes + size > MAX_SUBMIT_BYTES):
                self._rejected_submissions += 1
                if not self._overflow_notice_scheduled:
                    self._overflow_notice_scheduled = True
                    self._append_pending_locked("overflow")
                return
            self._pending_callbacks += 1
            self._pending_bytes += size
            self._append_pending_locked("media", (pts_us, payload, config, keyframe))

    def _discard_pending_locked(self):
        # Delivery holds this same lock through its final payload release, so
        # no unaccounted in-flight bytes can survive this synchronous reset.
        self._pending.clear()
        self._pending_callbacks = 0
        self._pending_bytes = 0
        self._reset_notice_scheduled = False
        self._overflow_notice_scheduled = False

    def _append_pending_locked(self, kind, data=None):
        self._pending_sequence += 1
        self._pending.append((self._pending_sequence, kind, data))
        self._schedule_drain_locked()

    def _schedule_drain_locked(self):
        if self._drain_scheduled:
            return
        self._drain_scheduled = True
        try:
            self.loop.call_soon_threadsafe(self._drain_on_loop)
        except RuntimeError:
            self._drain_scheduled = False
            self._accepting = False
            self._discard_pending_locked()

    def _drain_on_loop(self):
        with self._submit_lock:
            cutoff = self._pending[-1][0] if self._pending else 0
        try:
            while True:
                with self._submit_lock:
                    if not self._pending or self._pending[0][0] > cutoff:
                        break
                    # Pop, bounded in-memory delivery and budget release are
                    # atomic with reset/stop. No await or I/O occurs here.
                    # Release this lock between packets so readers can reset.
                    self._deliver_next_locked()
        finally:
            with self._submit_lock:
                self._drain_scheduled = False
                if self._pending:
                    # New producer work gets its own loop turn; rapid resets
                    # still retain at most one lightweight drain callback.
                    self._schedule_drain_locked()

    def _deliver_next_locked(self):
        _, kind, data = self._pending.popleft()
        if kind == "media":
            try:
                if self._accepting and not self.closed:
                    self._submit_on_loop(*data)
            finally:
                self._pending_callbacks -= 1
                self._pending_bytes -= len(data[1])
                # Do not leave a large local payload alive after unlocking.
                del data
            return
        self.dropped_frames += self._rejected_submissions
        self._rejected_submissions = 0
        if kind == "reset":
            self._reset_notice_scheduled = False
            self._reset_on_loop()
        else:
            self._overflow_notice_scheduled = False
            self._on_backpressure()

    def _on_backpressure(self):
        if self.closed:
            return
        # Existing queued frames depend on possibly missing deltas. Flush and
        # wait for a fresh IDR with the retained bounded SPS/PPS config.
        while not self.frames.empty():
            self.frames.get_nowait()
        self._queued_bytes = 0
        self.need_keyframe = True

    def _submit_on_loop(self, pts_us, payload, config, keyframe):
        if self.closed:
            return
        if config:
            # scrcpy's codec-config packet has SPS/PPS with Annex B start codes.
            self.config = payload if 0 < len(payload) <= MAX_CONFIG_BYTES else None
            return
        if self.frames.full() or self._queued_bytes + len(payload) + (len(self.config or b"") if keyframe else 0) > MAX_PENDING_BYTES:
            # Never build latency by replaying stale frames. A delta after a drop
            # is undecodable: discard until the next IDR with fresh SPS/PPS.
            while not self.frames.empty():
                self.frames.get_nowait()
            self.need_keyframe = True
            self._queued_bytes = 0
            self.dropped_frames += 1
        if self.need_keyframe and not keyframe:
            self.dropped_frames += 1
            return
        if keyframe:
            if not self.config:
                self.dropped_frames += 1
                return
            payload = self.config + payload
            self.need_keyframe = False
        if len(payload) > MAX_PENDING_BYTES:
            self.need_keyframe = True
            self.dropped_frames += 1
            return
        minimum_pts = 0
        if self.last_pts is not None:
            # A one-microsecond clamp collapses many frames onto the same
            # 90 kHz RTP timestamp after an encoder clock restart. Offset the
            # whole segment and advance by at least one actual RTP tick.
            previous_tick = self.last_pts * RTP_CLOCK_RATE // PHONE_CLOCK_RATE
            minimum_pts = ((previous_tick + 1) * PHONE_CLOCK_RATE
                           + RTP_CLOCK_RATE - 1) // RTP_CLOCK_RATE
        if self._new_segment:
            self._pts_offset = max(0, minimum_pts - pts_us)
            self._new_segment = False
        pts_us = max(minimum_pts, pts_us + self._pts_offset)
        self.last_pts = pts_us
        packet = Packet(payload)
        packet.pts = pts_us
        packet.time_base = Fraction(1, PHONE_CLOCK_RATE)
        self.frames.put_nowait(packet)
        self._queued_bytes += packet.size

    async def recv(self):
        if self.closed:
            raise MediaStreamError
        item = await self.frames.get()
        if item is SENTINEL:
            raise MediaStreamError
        self._queued_bytes = max(0, self._queued_bytes - item.size)
        self.sent_frames += 1
        return item

    def stop(self):
        # Stop may race the ADB reader on a different OS thread. Block new
        # reservations immediately, and schedule teardown at most once.
        with self._submit_lock:
            if self._stop_scheduled:
                return
            # _accepting may already be false because call_soon_threadsafe
            # observed a closed loop; stop still must finalize closed state.
            self._accepting = False
            self._stop_scheduled = True
            self._discard_pending_locked()
            try:
                self.loop.call_soon_threadsafe(self._stop_on_loop)
            except RuntimeError:
                self.closed = True

    def _stop_on_loop(self):
        if self.closed:
            return
        self.closed = True
        super().stop()
        while not self.frames.empty():
            self.frames.get_nowait()
        self._queued_bytes = 0
        self.frames.put_nowait(SENTINEL)
