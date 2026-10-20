"""Zero-transcode scrcpy H.264 -> aiortc encoded-packet video track.

The track belongs to one explicit EasyADB WS session. Phone packet PTS are
microseconds; aiortc's H264 packetizer converts these to RTP's 90 kHz clock.
No decoder, FFmpeg remuxer, global capture or background reconnect is used.
"""
import asyncio
import threading
from fractions import Fraction

from av import Packet
from aiortc import MediaStreamTrack
from aiortc.mediastreams import MediaStreamError

MAX_PENDING_FRAMES = 48
MAX_PENDING_BYTES = 16 * 1024 * 1024
# A second bound covers payloads captured by cross-thread callbacks BEFORE
# they reach the asyncio frame queue; a slow loop must not accumulate them.
MAX_SUBMIT_CALLBACKS = 48
MAX_SUBMIT_BYTES = 16 * 1024 * 1024
MAX_CONFIG_BYTES = 256 * 1024
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
        self.closed = False
        self.dropped_frames = 0
        self.sent_frames = 0
        self._queued_bytes = 0
        self._submit_lock = threading.Lock()
        self._accepting = True
        self._stop_scheduled = False
        self._pending_callbacks = 0
        self._pending_bytes = 0
        self._overflow_notice_scheduled = False
        self._rejected_submissions = 0

    def submit(self, pts_us, payload, *, config=False, keyframe=False):
        """Reserve callback/byte budget BEFORE capturing ADB payload on the loop.

        Neither asyncio.Queue nor track codec state is touched by the reader.
        Scheduling is serialized under the short lock, so the one overflow
        marker always follows the callbacks that preceded the dropped frame.
        """
        if config and len(payload) > MAX_CONFIG_BYTES:
            payload = b""  # preserve old behavior: invalidate oversized config
        size = len(payload)
        with self._submit_lock:
            if not self._accepting:
                return
            if (self._pending_callbacks >= MAX_SUBMIT_CALLBACKS
                    or size > MAX_SUBMIT_BYTES
                    or self._pending_bytes + size > MAX_SUBMIT_BYTES):
                self._rejected_submissions += 1
                if not self._overflow_notice_scheduled:
                    self._overflow_notice_scheduled = True
                    try:
                        # No rejected payload is captured by this callback.
                        self.loop.call_soon_threadsafe(self._on_backpressure)
                    except RuntimeError:
                        self._overflow_notice_scheduled = False
                        self._accepting = False
                return
            self._pending_callbacks += 1
            self._pending_bytes += size
            try:
                self.loop.call_soon_threadsafe(
                    self._deliver_on_loop, pts_us, payload, config, keyframe, size)
            except RuntimeError:
                self._pending_callbacks -= 1
                self._pending_bytes -= size
                self._accepting = False  # event loop already closed

    def _deliver_on_loop(self, pts_us, payload, config, keyframe, size):
        try:
            if not self.closed:
                self._submit_on_loop(pts_us, payload, config, keyframe)
        finally:
            # Even a rejected/failed enqueue must return its reserved budget.
            with self._submit_lock:
                self._pending_callbacks -= 1
                self._pending_bytes -= size

    def _on_backpressure(self):
        with self._submit_lock:
            dropped = self._rejected_submissions
            self._rejected_submissions = 0
            self._overflow_notice_scheduled = False
        if self.closed:
            return
        # Existing queued frames depend on possibly missing deltas. Flush and
        # wait for a fresh IDR with the retained bounded SPS/PPS config.
        while not self.frames.empty():
            self.frames.get_nowait()
        self._queued_bytes = 0
        self.need_keyframe = True
        self.dropped_frames += dropped

    def _submit_on_loop(self, pts_us, payload, config, keyframe):
        if self.closed:
            return
        if config:
            # scrcpy's codec-config packet has SPS/PPS with Annex B start codes.
            self.config = payload if len(payload) <= MAX_CONFIG_BYTES else None
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
        if self.last_pts is not None and pts_us <= self.last_pts:
            pts_us = self.last_pts + 1
        self.last_pts = pts_us
        packet = Packet(payload)
        packet.pts = pts_us
        packet.time_base = Fraction(1, 1_000_000)
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
            if not self._accepting or self._stop_scheduled:
                return
            self._accepting = False
            self._stop_scheduled = True
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
