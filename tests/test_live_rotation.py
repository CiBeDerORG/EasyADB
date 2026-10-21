"""Read real scrcpy v5 session/media packets without ADB or a media worker."""
import socket
import struct

import pytest

from server.m2_live import LiveVideo, MAX_FRAME_BYTES, StreamStopped
from server.m2_touch import InvalidTouch
from server.m2_video_probe import VideoProbeError
from server.m2_webrtc import MAX_CONFIG_BYTES


CONFIG = b"\x00\x00\x00\x01\x67\x42\xc0\x1f\xda\x02\x80\x00\x00\x00\x01\x68\xce\x3c\x80"
KEY = b"\x00\x00\x00\x01\x65\x88\x80"
DELTA = b"\x00\x00\x00\x01\x41\x9a\x22"


def packet(payload, pts=0, *, config=False, key=False):
    flags = (1 << 62 if config else 0) | (1 << 61 if key else 0)
    return struct.pack(">QI", pts | flags, len(payload)) + payload


def session(width, height, *, client_resize=False):
    # Official v5.0.1 Streamer.writeSessionMeta: one header, no payload.
    return struct.pack(">III", 0x80000000 | int(client_resize), width, height)


def segment(pts=10):
    return [packet(CONFIG, config=True), packet(KEY, pts, key=True), packet(DELTA, pts + 1)]


class RecordingTrack:
    """Record reader-to-track boundaries; codec behavior has separate tests."""

    def __init__(self):
        self.calls = []

    def reset_stream(self):
        self.calls.append(("reset",))

    def submit(self, pts, payload, *, config=False, keyframe=False):
        self.calls.append(("packet", pts, payload, config, keyframe))

    def stop(self):
        self.calls.append(("stop",))


class ControlSocket:
    def __init__(self, on_send=None):
        self.messages = []
        self.on_send = on_send

    def sendall(self, data):
        self.messages.append(data)
        if self.on_send is not None:
            self.on_send(data)


class VideoSocket:
    def __init__(self, stream, data, *, before_read=None, fragment=None, stop_at_end=True):
        self.stream, self.data = stream, data
        self.offset = 12  # first_header is handed off by the real startup parser
        self.before_read = before_read
        self.fragment = fragment
        self.stop_at_end = stop_at_end
        self.requests = []

    def settimeout(self, timeout):
        assert timeout > 0

    def recv(self, amount):
        self.requests.append(amount)
        if self.before_read is not None:
            self.before_read(self.offset)
        if self.offset == len(self.data):
            if self.stop_at_end:
                self.stream.stop_event.set()
                raise socket.timeout()  # the actual _socket_read observes stop
            return b""
        size = min(amount, self.fragment) if self.fragment is not None else amount
        block = self.data[self.offset:self.offset + size]
        self.offset += len(block)
        return block


def make_stream(size=(720, 1600), *, screen_off=False):
    stream = LiveVideo("test-only:5555", "baseline", screen_off=screen_off)
    stream.webrtc_track = RecordingTrack()
    stream.touch_size = size
    return stream


def drain(stream, packets, *, initial=(720, 1600), **socket_options):
    data = b"".join(packets)
    sock = VideoSocket(stream, data, **socket_options)
    with pytest.raises(StreamStopped):
        stream._stream_to_webrtc(sock, data[:12], *initial, b"Rotation test")
    assert sock.offset == len(data)
    return sock


def events(stream, kind):
    return [payload for name, payload in stream.events.queue if name == kind]


@pytest.mark.parametrize("initial", [(720, 1600), (1600, 720)])
def test_portrait_landscape_round_trip_keeps_one_session_and_initialization(initial):
    rotated = initial[::-1]
    stream = make_stream(initial, screen_off=True)
    stream.control_sock = ControlSocket()
    owner, track = stream.session_id, stream.webrtc_track
    ready_times = []

    def observe(_):
        if stream._ready_at is not None:
            ready_times.append(stream._ready_at)

    drain(stream, segment() + [session(*rotated)] + segment(1)
          + [session(*initial, client_resize=True)] + segment(2),
          initial=initial, before_read=observe, fragment=5)
    assert stream.session_id == owner and stream.webrtc_track is track
    assert len(events(stream, "init")) == 1
    assert (events(stream, "init")[0]["width"], events(stream, "init")[0]["height"]) == initial
    assert events(stream, "resize") == [
        {"width": rotated[0], "height": rotated[1]},
        {"width": initial[0], "height": initial[1]},
    ]
    assert len(events(stream, "screen_power_notice")) == 1
    assert stream.control_sock.messages == [b"\x0a\x00"]
    assert ready_times and set(ready_times) == {stream._ready_at}
    assert [call[0] for call in track.calls] == [
        "packet", "packet", "packet", "reset",
        "packet", "packet", "packet", "reset", "packet", "packet", "packet",
    ]
    assert stream.touch_size == initial
    assert not events(stream, "error") and not events(stream, "end")
    assert not stream.finished.is_set() and not stream.cleanup_complete


def test_headers_before_first_frame_use_latest_size_and_require_fresh_config():
    stream = make_stream()
    prefix = [packet(CONFIG, config=True), session(1600, 720), session(1080, 2400),
              packet(KEY, 1, key=True)]
    boundary = sum(map(len, prefix))

    def observe(offset):
        if offset == boundary:
            assert not events(stream, "init") and stream._ready_at is None
            assert stream.touch_size == (1080, 2400)

    drain(stream, prefix + segment(2), before_read=observe)
    assert [(p["width"], p["height"]) for p in events(stream, "init")] == [(1080, 2400)]
    assert not events(stream, "resize")
    assert [call[0] for call in stream.webrtc_track.calls].count("reset") == 2


def test_same_size_encoder_restart_resets_codec_without_replaying_init_or_resize():
    stream = make_stream()
    drain(stream, segment() + [session(720, 1600)] + segment(1)
          + [packet(CONFIG, config=True), packet(KEY, 2, key=True)])
    assert len(events(stream, "init")) == 1
    assert not events(stream, "resize")
    assert [call[0] for call in stream.webrtc_track.calls].count("reset") == 1


@pytest.mark.parametrize("incomplete", ["no_config", "oversized_config", "no_keyframe"])
def test_rotation_does_not_announce_dimensions_before_new_config_and_keyframe(incomplete):
    stream = make_stream()
    suffix = {
        "no_config": [packet(KEY, 1, key=True), packet(DELTA, 2)],
        "oversized_config": [packet(b"x" * (MAX_CONFIG_BYTES + 1), config=True),
                              packet(KEY, 1, key=True)],
        "no_keyframe": [packet(CONFIG, config=True), packet(DELTA, 1)],
    }[incomplete]
    drain(stream, segment() + [session(1600, 720)] + suffix)
    assert len(events(stream, "init")) == 1
    assert not events(stream, "resize")
    assert stream.touch_size == (1600, 720)


def touch(stream, action, size, point=(50, 300)):
    return {"type": "touch", "session_id": stream.session_id, "action": action,
            "width": size[0], "height": size[1], "x": point[0], "y": point[1]}


def test_rotation_releases_old_finger_then_accepts_only_new_touch_dimensions():
    stream = make_stream()
    stream.control_sock = ControlSocket()
    stream.send_touch(touch(stream, "down", (720, 1600)))
    prefix = segment() + [session(1600, 720)]
    after_header = sum(map(len, prefix))
    checked = []

    def observe(offset):
        if offset == after_header:
            assert stream.touch_size == (1600, 720)
            assert not stream.touch_pressed and stream.touch_point is None
            cancel = struct.unpack(">BBQiiHHHII", stream.control_sock.messages[-1])
            assert cancel[0:2] == (2, 3)
            assert cancel[3:7] == (50, 300, 720, 1600)
            with pytest.raises(InvalidTouch):
                stream.send_touch(touch(stream, "down", (720, 1600)))
            stream.send_touch(touch(stream, "down", (1600, 720)))
            stream.send_touch(touch(stream, "up", (1600, 720)))
            checked.append(True)

    drain(stream, prefix + segment(1), before_read=observe)
    assert checked == [True]
    assert [struct.unpack(">BBQiiHHHII", data)[1] for data in stream.control_sock.messages] == [0, 3, 0, 1]
    assert not stream.touch_pressed and stream.touch_point is None


@pytest.mark.parametrize("size", [(0, 720), (8193, 720), (720, 0), (720, 8193)])
def test_invalid_session_dimensions_fail_before_reset_touch_or_payload_read(size):
    stream = make_stream()
    stream.control_sock = ControlSocket()
    stream.send_touch(touch(stream, "down", (720, 1600)))
    data = session(*size) + b"must not read"
    sock = VideoSocket(stream, data)
    with pytest.raises(VideoProbeError, match="尺寸更新无效"):
        stream._stream_to_webrtc(sock, data[:12], 720, 1600, b"Test")
    assert sock.offset == 12 and not sock.requests
    assert stream.touch_size == (720, 1600) and stream.touch_pressed
    assert len(stream.control_sock.messages) == 1
    assert not stream.webrtc_track.calls and stream.events.empty()


@pytest.mark.parametrize("length", [0, MAX_FRAME_BYTES + 1])
def test_rotation_preserves_media_packet_length_validation(length):
    stream = make_stream()
    data = session(1600, 720) + struct.pack(">QI", 1, length) + b"must not read"
    sock = VideoSocket(stream, data)
    with pytest.raises(VideoProbeError, match="媒体包大小异常"):
        stream._stream_to_webrtc(sock, data[:12], 720, 1600, b"Test")
    assert sock.offset == 24 and sock.requests == [12]
    assert stream.webrtc_track.calls == [("reset",)]
    assert stream.events.empty()


@pytest.mark.parametrize("stop_when", ["before_header", "during_finger_release"])
def test_stop_during_rotation_cannot_reset_or_announce_another_segment(stop_when):
    stream = make_stream()
    stream.control_sock = ControlSocket()
    stream.send_touch(touch(stream, "down", (720, 1600)))
    if stop_when == "before_header":
        stream.stop_event.set()
    else:
        stream.control_sock.on_send = lambda _: stream.stop_event.set()
    data = session(1600, 720) + b"".join(segment(1))
    sock = VideoSocket(stream, data)
    with pytest.raises(StreamStopped):
        stream._stream_to_webrtc(sock, data[:12], 720, 1600, b"Test")
    assert sock.offset == 12 and not sock.requests
    assert not stream.webrtc_track.calls and stream.events.empty()
    assert stream.touch_size == (720, 1600)
    if stop_when == "during_finger_release":
        assert not stream.touch_pressed and stream.touch_point is None


def test_real_transport_eof_after_rotation_remains_an_error():
    stream = make_stream()
    data = session(1600, 720) + packet(CONFIG, config=True) + b"truncated"
    sock = VideoSocket(stream, data, stop_at_end=False)
    with pytest.raises(VideoProbeError, match="socket 已关闭"):
        stream._stream_to_webrtc(sock, data[:12], 720, 1600, b"Test")
    assert sock.offset == len(data) and not stream.stop_event.is_set()
    assert stream.webrtc_track.calls[0] == ("reset",)
    assert stream.events.empty()
