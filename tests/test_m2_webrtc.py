"""No phone needed: exercise actual aiortc pre-encoded H264 packet path."""
import asyncio

import pytest
from aiortc.codecs.h264 import H264Encoder
from aiortc.mediastreams import MediaStreamError

from server.m2_webrtc import MAX_PENDING_FRAMES, ScrcpyH264Track


CONFIG = (b"\x00\x00\x00\x01\x67\x42\xc0\x1f\xda\x02\x80"
          b"\x00\x00\x00\x01\x68\xce\x3c\x80")
KEY = b"\x00\x00\x00\x01\x65\x88\x80"
DELTA = b"\x00\x00\x00\x01\x41\x9a\x22"


def test_encoded_h264_rtp_pack_without_decode_or_reencode():
    async def check():
        track = ScrcpyH264Track(asyncio.get_running_loop())
        track.submit(0, CONFIG, config=True)
        track.submit(2_000_000, DELTA)  # no IDR yet: must not send
        track.submit(2_100_000, KEY, keyframe=True)
        track.submit(2_150_000, DELTA)
        key = await asyncio.wait_for(track.recv(), 1)
        delta = await asyncio.wait_for(track.recv(), 1)
        assert bytes(key) == CONFIG + KEY
        assert bytes(delta) == DELTA
        assert key.pts == 2_100_000 and delta.pts == 2_150_000
        assert str(key.time_base) == "1/1000000"
        payloads, rtp_pts = H264Encoder().pack(key)
        assert payloads and rtp_pts == 189000  # 2.1s * 90000 Hz
        assert track.sent_frames == 2 and track.dropped_frames == 1
        track.stop()
        await asyncio.sleep(0)
        with pytest.raises(MediaStreamError):
            await track.recv()
    asyncio.run(check())


def test_overflow_drops_stale_delta_until_next_idr():
    async def check():
        track = ScrcpyH264Track(asyncio.get_running_loop())
        track._submit_on_loop(0, CONFIG, True, False)
        track._submit_on_loop(10, KEY, False, True)
        for index in range(1, MAX_PENDING_FRAMES):
            track._submit_on_loop(10 + index, DELTA, False, False)
        assert track.frames.qsize() == MAX_PENDING_FRAMES
        track._submit_on_loop(1000, DELTA, False, False)
        assert track.frames.empty() and track.need_keyframe
        track._submit_on_loop(2000, KEY, False, True)
        key = await asyncio.wait_for(track.recv(), 1)
        assert bytes(key) == CONFIG + KEY and key.pts == 2000
        track.stop()
        await asyncio.sleep(0)
    asyncio.run(check())


def test_multiple_tracks_never_share_codec_config_or_frames():
    async def check():
        a = ScrcpyH264Track(asyncio.get_running_loop())
        b = ScrcpyH264Track(asyncio.get_running_loop())
        a._submit_on_loop(0, CONFIG, True, False)
        a._submit_on_loop(1, KEY, False, True)
        b._submit_on_loop(1, KEY, False, True)
        assert b.frames.empty() and b.need_keyframe
        assert bytes(await a.recv()) == CONFIG + KEY
        a.stop(); b.stop()
        await asyncio.sleep(0)
    asyncio.run(check())
