"""Zero-transcode scrcpy H.264 -> aiortc encoded-packet video track.

The track belongs to one explicit EasyADB WS session. Phone packet PTS are
microseconds; aiortc's H264 packetizer converts these to RTP's 90 kHz clock.
No decoder, FFmpeg remuxer, global capture or background reconnect is used.
"""
import asyncio
from fractions import Fraction

from av import Packet
from aiortc import MediaStreamTrack
from aiortc.mediastreams import MediaStreamError

MAX_PENDING_FRAMES = 48
MAX_PENDING_BYTES = 16 * 1024 * 1024
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

    def submit(self, pts_us, payload, *, config=False, keyframe=False):
        """Called by the blocking ADB reader; never touches asyncio state there."""
        if self.closed:
            return
        try:
            self.loop.call_soon_threadsafe(self._submit_on_loop, pts_us, payload, config, keyframe)
        except RuntimeError:
            pass  # the owning event loop is already closed

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
        if self.closed:
            return
        # MediaStreamTrack can be stopped by the aiortc task or the ADB worker.
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
