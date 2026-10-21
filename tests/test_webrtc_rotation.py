"""Encoder rotation keeps one track and starts a fresh bounded H.264 segment."""
import asyncio
from fractions import Fraction
import threading

import av
from aiortc.codecs.h264 import H264Decoder, H264Encoder, H264PayloadDescriptor
from aiortc.jitterbuffer import JitterFrame
from aiortc.mediastreams import MediaStreamError
import pytest

import server.m2_webrtc as webrtc
from server.m2_webrtc import (MAX_CONFIG_BYTES, MAX_SUBMIT_BYTES,
                              MAX_SUBMIT_CALLBACKS, ScrcpyH264Track)


CONFIG = (b"\x00\x00\x00\x01\x67\x42\xc0\x1f\xda\x02\x80"
          b"\x00\x00\x00\x01\x68\xce\x3c\x80")
NEW_CONFIG = (b"\x00\x00\x00\x01\x67\x42\xc0\x1f\xda\x03\x80"
              b"\x00\x00\x00\x01\x68\xce\x3c\x80")
KEY = b"\x00\x00\x00\x01\x65\x88\x80"
DELTA = b"\x00\x00\x00\x01\x41\x9a\x22"


class ObservedLoop:
    """Count scheduled callbacks without retaining their screen payloads."""

    def __init__(self, loop):
        self.loop = loop
        self.callbacks = []

    def call_soon_threadsafe(self, callback, *args):
        self.callbacks.append(callback.__name__)
        return self.loop.call_soon_threadsafe(callback, *args)


async def stop_track(track):
    track.stop()
    await asyncio.sleep(0)


def test_reset_flushes_old_frames_and_waits_for_new_config_and_idr():
    async def run():
        track = ScrcpyH264Track(asyncio.get_running_loop())
        track.submit(0, CONFIG, config=True)
        track.submit(1_000_000, KEY, keyframe=True)
        await asyncio.wait_for(track.recv(), 1)
        track.submit(1_030_000, DELTA)
        await asyncio.sleep(0)
        assert track.frames.qsize() == 1
        track_id = track.id

        track.reset_stream()
        await asyncio.sleep(0)
        assert track.frames.empty() and track._queued_bytes == 0
        assert track.config is None and track.need_keyframe
        assert track.readyState == "live" and not track.closed and track.id == track_id

        waiting = asyncio.create_task(track.recv())
        track.submit(0, KEY, keyframe=True)  # old config cannot be reused
        track.submit(10, DELTA)
        await asyncio.sleep(0)
        assert not waiting.done()
        track.submit(0, NEW_CONFIG, config=True)
        track.submit(20, DELTA)  # new config alone is not a decodable frame
        await asyncio.sleep(0)
        assert not waiting.done()
        track.submit(30, KEY, keyframe=True)
        packet = await asyncio.wait_for(waiting, 1)
        assert bytes(packet) == NEW_CONFIG + KEY
        assert not track.need_keyframe and track.readyState == "live"
        await stop_track(track)
    asyncio.run(run())


def test_old_callbacks_cannot_restore_config_or_frames_after_latest_reset():
    async def run():
        loop = ObservedLoop(asyncio.get_running_loop())
        track = ScrcpyH264Track(loop)
        # No await: all producer callbacks remain queued until both resets.
        track.submit(0, CONFIG, config=True)
        track.submit(1_000_000, KEY, keyframe=True)
        track.reset_stream()
        track.submit(0, b"obsolete intermediate config", config=True)
        track.submit(0, KEY, keyframe=True)
        track.reset_stream()
        track.submit(0, NEW_CONFIG, config=True)
        track.submit(0, KEY, keyframe=True)
        assert loop.callbacks == ["_drain_on_loop"]
        await asyncio.sleep(0)
        assert track.config == NEW_CONFIG and track.frames.qsize() == 1
        assert bytes(await asyncio.wait_for(track.recv(), 1)) == NEW_CONFIG + KEY
        assert track._pending_callbacks == track._pending_bytes == 0
        assert not track._reset_notice_scheduled
        await stop_track(track)
    asyncio.run(run())


@pytest.mark.parametrize("payload_size", [32, 1024 * 1024])
def test_rapid_reader_resets_keep_original_callback_and_byte_bounds(payload_size):
    async def run():
        loop = ObservedLoop(asyncio.get_running_loop())
        track = ScrcpyH264Track(loop)
        payload = KEY + b"x" * payload_size

        def producer():
            for pts in range(1000):
                track.reset_stream()
                track.submit(pts, payload, keyframe=True)

        # Hold the event loop while the actual reader thread bursts resets.
        reader = threading.Thread(target=producer)
        reader.start()
        reader.join(timeout=2)
        assert not reader.is_alive()
        assert loop.callbacks == ["_drain_on_loop"]
        assert len(track._pending) == 2  # latest reset + latest media only
        assert track._pending_callbacks <= MAX_SUBMIT_CALLBACKS
        assert track._pending_bytes <= MAX_SUBMIT_BYTES
        await asyncio.sleep(0)
        assert track._pending_callbacks == track._pending_bytes == 0
        assert track.frames.empty() and track.config is None and track.need_keyframe
        assert not track.closed

        track.submit(0, NEW_CONFIG, config=True)
        track.submit(1, KEY, keyframe=True)
        assert bytes(await asyncio.wait_for(track.recv(), 1)) == NEW_CONFIG + KEY
        await stop_track(track)
    asyncio.run(run())


@pytest.mark.parametrize("limit", ["count", "bytes", "small"])
def test_reset_reclaims_full_backlog_before_one_shot_new_config(monkeypatch, limit):
    if limit == "small":
        monkeypatch.setattr(webrtc, "MAX_SUBMIT_CALLBACKS", 3)
        monkeypatch.setattr(webrtc, "MAX_SUBMIT_BYTES", 80)

    async def run():
        loop = ObservedLoop(asyncio.get_running_loop())
        track = ScrcpyH264Track(loop)
        track._submit_on_loop(0, CONFIG, True, False)
        track._submit_on_loop(1_000_000, KEY, False, True)
        observations = []
        payload = (DELTA + b"x" * (webrtc.MAX_SUBMIT_BYTES - len(DELTA))
                   if limit == "bytes" else DELTA)
        count = 1 if limit == "bytes" else webrtc.MAX_SUBMIT_CALLBACKS

        def produce_rotation():
            for index in range(count):
                track.submit(1_030_000 + index, payload)
            track.submit(2_000_000, DELTA)  # also enqueue an overflow notice
            observations.append((track._pending_callbacks, track._pending_bytes,
                                 track._overflow_notice_scheduled))
            track.reset_stream()
            observations.append((track._pending_callbacks, track._pending_bytes,
                                 track._overflow_notice_scheduled))
            # Real encoders can emit config only once. No retry in this test.
            track.submit(0, NEW_CONFIG, config=True)
            track.submit(0, KEY, keyframe=True)

        reader = threading.Thread(target=produce_rotation)
        reader.start()
        reader.join(timeout=2)
        assert not reader.is_alive()
        assert observations == [(count, len(payload) * count, True), (0, 0, False)]
        assert loop.callbacks == ["_drain_on_loop"]
        assert track._pending_callbacks == 2
        assert track._pending_bytes == len(NEW_CONFIG) + len(KEY)
        assert len(track._pending) == 3
        await asyncio.sleep(0)
        assert track.frames.qsize() == 1 and track.config == NEW_CONFIG
        assert bytes(await asyncio.wait_for(track.recv(), 1)) == NEW_CONFIG + KEY
        assert track._pending_callbacks == track._pending_bytes == 0
        assert not track._reset_notice_scheduled and not track._overflow_notice_scheduled
        assert track.dropped_frames >= 1 and track.readyState == "live"
        await stop_track(track)
    asyncio.run(run())


def test_reset_cannot_overtake_in_flight_full_budget_delivery(monkeypatch):
    async def run():
        track = ScrcpyH264Track(asyncio.get_running_loop())
        track._submit_on_loop(0, CONFIG, True, False)
        track._submit_on_loop(1_000_000, KEY, False, True)
        await track.recv()
        payload = DELTA + b"x" * (MAX_SUBMIT_BYTES - len(DELTA))
        delivery_started = threading.Event()
        reset_attempted = threading.Event()
        reader_lock_results = []
        original_submit = track._submit_on_loop

        def observe_delivery(pts, data, config, keyframe):
            if data is payload:
                delivery_started.set()
                assert reset_attempted.wait(2)
                # Reset must not release the budget while this full payload
                # is still owned by delivery, then admit another 16 MiB.
                assert reader_lock_results == [False]
                assert track._pending_callbacks == 1
                assert track._pending_bytes == MAX_SUBMIT_BYTES
            original_submit(pts, data, config, keyframe)

        monkeypatch.setattr(track, "_submit_on_loop", observe_delivery)

        def produce_rotation():
            if not delivery_started.wait(2):
                return
            acquired = track._submit_lock.acquire(blocking=False)
            reader_lock_results.append(acquired)
            if acquired:
                track._submit_lock.release()
            reset_attempted.set()
            track.reset_stream()
            track.submit(0, NEW_CONFIG, config=True)
            track.submit(0, KEY, keyframe=True)

        reader = threading.Thread(target=produce_rotation)
        reader.start()
        track.submit(1_030_000, payload)
        await asyncio.to_thread(reader.join, 3)
        assert not reader.is_alive() and reader_lock_results == [False]
        await asyncio.sleep(0)
        assert track.config == NEW_CONFIG and track.frames.qsize() == 1
        assert bytes(await asyncio.wait_for(track.recv(), 1)) == NEW_CONFIG + KEY
        assert track._pending_callbacks == track._pending_bytes == 0
        await stop_track(track)
    asyncio.run(run())


def test_rotating_one_track_does_not_reset_another_device():
    async def run():
        a = ScrcpyH264Track(asyncio.get_running_loop())
        b = ScrcpyH264Track(asyncio.get_running_loop())
        for track in (a, b):
            track.submit(0, CONFIG, config=True)
            track.submit(1_000_000, KEY, keyframe=True)
        await asyncio.sleep(0)
        a.reset_stream()
        await asyncio.sleep(0)
        assert a.frames.empty() and a.config is None
        assert b.config == CONFIG and b.frames.qsize() == 1
        packet = await asyncio.wait_for(b.recv(), 1)
        assert bytes(packet) == CONFIG + KEY and packet.pts == 1_000_000
        assert b.readyState == "live" and not b.need_keyframe
        await stop_track(a)
        await stop_track(b)
    asyncio.run(run())


def test_stop_racing_pending_reset_keeps_recv_terminal():
    async def run():
        loop = ObservedLoop(asyncio.get_running_loop())
        track = ScrcpyH264Track(loop)
        waiting = asyncio.create_task(track.recv())
        await asyncio.sleep(0)
        track.reset_stream()
        track.submit(0, NEW_CONFIG, config=True)
        track.submit(0, KEY, keyframe=True)
        track.stop()
        track.reset_stream()
        track.submit(1, KEY, keyframe=True)
        with pytest.raises(MediaStreamError):
            await asyncio.wait_for(waiting, 1)
        assert track.closed and track.readyState == "ended"
        assert loop.callbacks == ["_drain_on_loop", "_stop_on_loop"]
        assert track._pending_callbacks == track._pending_bytes == 0
        assert not track._reset_notice_scheduled
        with pytest.raises(MediaStreamError):
            await track.recv()
    asyncio.run(run())


def test_reset_on_closed_loop_disables_submissions_without_leaking_budget():
    class ClosedLoop:
        def call_soon_threadsafe(self, *args):
            raise RuntimeError("Event loop is closed")

    track = ScrcpyH264Track(ClosedLoop())
    track.reset_stream()
    assert not track._accepting and not track._reset_notice_scheduled
    track.submit(0, NEW_CONFIG, config=True)
    track.submit(0, KEY, keyframe=True)
    assert track._pending_callbacks == track._pending_bytes == 0
    assert track.frames.empty()
    track.stop()
    track.reset_stream()
    assert track.closed


def test_reset_pts_keeps_rtp_clock_forward_and_new_segment_frame_spacing():
    async def run():
        track = ScrcpyH264Track(asyncio.get_running_loop())
        packer = H264Encoder()
        outgoing = []
        for index, base_pts in enumerate((5_000_000, 0, 10_000_000, 0)):
            if index:
                track.reset_stream()
            track.submit(0, CONFIG if index % 2 == 0 else NEW_CONFIG, config=True)
            track.submit(base_pts, KEY, keyframe=True)
            track.submit(base_pts + 30_000, DELTA)
            key = await asyncio.wait_for(track.recv(), 1)
            delta = await asyncio.wait_for(track.recv(), 1)
            assert delta.pts - key.pts == 30_000
            key_payloads, key_rtp = packer.pack(key)
            delta_payloads, delta_rtp = packer.pack(delta)
            assert key_payloads and delta_payloads
            assert delta_rtp - key_rtp == 2700
            outgoing.extend((key_rtp, delta_rtp))
        assert all(right > left for left, right in zip(outgoing, outgoing[1:]))
        assert track.readyState == "live"
        await stop_track(track)
    asyncio.run(run())


@pytest.mark.parametrize("config", [b"", b"x" * (MAX_CONFIG_BYTES + 1)])
def test_invalid_new_config_cannot_reuse_previous_orientation_config(config):
    async def run():
        track = ScrcpyH264Track(asyncio.get_running_loop())
        track.submit(0, CONFIG, config=True)
        track.submit(100, KEY, keyframe=True)
        await asyncio.wait_for(track.recv(), 1)
        track.reset_stream()
        track.submit(0, config, config=True)
        track.submit(0, KEY, keyframe=True)
        track.submit(100, DELTA)
        await asyncio.sleep(0)
        assert track.frames.empty() and track.config is None and track.need_keyframe
        track.submit(0, NEW_CONFIG, config=True)
        track.submit(200, KEY, keyframe=True)
        assert bytes(await asyncio.wait_for(track.recv(), 1)) == NEW_CONFIG + KEY
        await stop_track(track)
    asyncio.run(run())


def encoded_segment(width, height):
    """Generate two small frames for this test, never production transcoding."""
    codec = av.CodecContext.create("libx264", "w")
    codec.width, codec.height = width, height
    codec.pix_fmt = "yuv420p"
    codec.time_base = Fraction(1, 30)
    codec.framerate = Fraction(30, 1)
    codec.options = {"preset": "ultrafast", "tune": "zerolatency",
                     "bf": "0", "g": "30", "scenecut": "0"}
    codec.open()
    encoded = []
    for pts in range(2):
        frame = av.VideoFrame(width, height, "yuv420p")
        frame.pts, frame.time_base = pts, codec.time_base
        for index, plane in enumerate(frame.planes):
            plane.update(bytes([32 + pts if index == 0 else 128]) * plane.buffer_size)
        encoded.extend(codec.encode(frame))
    encoded.extend(codec.encode(None))
    assert len(encoded) == 2 and encoded[0].is_keyframe and not encoded[1].is_keyframe
    units = list(H264Encoder._split_bitstream(bytes(encoded[0])))
    prefix = b"\x00\x00\x00\x01"
    config = b"".join(prefix + unit for unit in units if unit[0] & 31 in (7, 8))
    key = b"".join(prefix + unit for unit in units if unit[0] & 31 not in (7, 8))
    assert config and key
    return config, key, bytes(encoded[1])


def test_real_h264_portrait_landscape_portrait_decodes_on_the_same_track():
    async def run():
        track = ScrcpyH264Track(asyncio.get_running_loop())
        packer = H264Encoder()
        decoder = H264Decoder()
        track_id = track.id
        decoded_sizes = []
        previous_timestamp = None
        for index, (width, height) in enumerate(((96, 160), (160, 96), (96, 160))):
            config, key, delta = encoded_segment(width, height)
            if index:
                track.reset_stream()
            track.submit(0, config, config=True)
            track.submit(0, key, keyframe=True)
            track.submit(33_333, delta)
            for _ in range(2):
                packet = await asyncio.wait_for(track.recv(), 1)
                payloads, timestamp = packer.pack(packet)
                if previous_timestamp is not None:
                    assert timestamp > previous_timestamp
                previous_timestamp = timestamp
                annex_b = b"".join(H264PayloadDescriptor.parse(payload)[1]
                                   for payload in payloads)
                frames = decoder.decode(JitterFrame(annex_b, timestamp))
                assert frames, "real encoded frame must decode, not just packetize"
                decoded_sizes.extend((frame.width, frame.height) for frame in frames)
            assert track.id == track_id and track.readyState == "live"
        assert decoded_sizes == [(96, 160)] * 2 + [(160, 96)] * 2 + [(96, 160)] * 2
        await stop_track(track)
    asyncio.run(run())
