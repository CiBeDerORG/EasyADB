"""Single-device, explicitly started scrcpy H264 -> FFmpeg fMP4 -> MSE transport.

No background ADB polling, automatic device reconnection, control messages or
recording. Every stream is owned by exactly one authenticated WebSocket.
"""
import os
import queue
import secrets
import select
import socket
import struct
import subprocess
import tempfile
import threading
import time
from pathlib import Path

from .m2_touch import InvalidTouch, encode_touch
from .m2_keys import encode_text, encode_key
from .m2_quality import resolve_live_quality
from .m2_resources import ProcessMeter
from .display_lab import display_ids
from .m2_control_diag import classify_control_log
from .m2_video_probe import (
    DEVICE_NAME_BYTES, HEADER_BYTES, MAX_PACKET_BYTES, SERVER_FILE,
    VERSION, VideoProbeError, _connect_forwarded, _read_exact, _run_adb,
)

MAX_INIT_BYTES = 1024 * 1024
MAX_QUEUE_ITEMS = 48
MAX_QUEUE_WAIT = 3.0
MAX_FRAME_BYTES = 8 * 1024 * 1024

# Shared by production and the FFmpeg -> MSE integration smoke test.
# -c:v copy retains the phone's original H.264 encoded video.
FFMPEG_MSE_ARGS = (
    "-hide_banner", "-loglevel", "error", "-nostdin",
    # scrcpy intentionally uses variable frame rate: unchanged screens are
    # normally repeated only every ~100ms (device/encoder-dependent). Without
    # this FFmpeg stamps every arrival at a fixed 1/30s, so the MSE timeline
    # advances much faster than actual wall time and repeatedly starves.
    # Raw Annex B loses scrcpy's original packet PTS; FFmpeg input arrival
    # timestamps are a bounded interim approximation until a PTS-aware muxer.
    "-use_wallclock_as_timestamps", "1",
    "-f", "h264", "-r", "30", "-i", "pipe:0",
    "-map", "0:v:0", "-an", "-c:v", "copy",
    "-movflags", "+empty_moov+default_base_moof+frag_every_frame",
    "-flush_packets", "1",
    "-f", "mp4", "pipe:1",
)


class StreamStopped(Exception):
    pass


def parse_init_segments(blob):
    """Wait for ftyp + moov and derive real avc1.* from the encoder avcC box.

    Returns (bytes_consumed, init_segment, mime), or None if incomplete.
    Fragments may immediately follow moov in the same input buffer.
    """
    offset = 0
    names = []
    while True:
        if len(blob) - offset < 8:
            return None
        size, name = struct.unpack_from(">I4s", blob, offset)
        if size < 8 or size > MAX_INIT_BYTES:
            raise VideoProbeError("视频 MP4 初始化段尺寸异常")
        if len(blob) - offset < size:
            return None
        names.append(name)
        end = offset + size
        if name == b"moov":
            if not names or names[0] != b"ftyp":
                raise VideoProbeError("视频 MP4 缺少初始 ftyp")
            avcc = blob.find(b"avcC", offset, end)
            if avcc < 4 or avcc + 8 > end:
                raise VideoProbeError("视频 MP4 缺少 H.264 avcC 编码信息")
            if blob[avcc + 4] != 1:
                raise VideoProbeError("视频 H.264 avcC 版本异常")
            codec = "avc1." + bytes(blob[avcc + 5:avcc + 8]).hex().upper()
            return end, bytes(blob[:end]), f'video/mp4; codecs="{codec}"'
        if name not in (b"ftyp", b"free"):
            raise VideoProbeError("视频 MP4 初始化段顺序异常")
        offset = end
        if offset > MAX_INIT_BYTES:
            raise VideoProbeError("视频 MP4 初始化段过大")


# FFmpeg writes the byte stream in arbitrary pipe read boundaries: one MP4
# media fragment may span multiple reads (and one read may contain many).
# Coalesce complete moof+mdat pairs so the browser normally appends once per
# encoded frame, not once for each OS pipe read. Never wait to combine frames.
MAX_MP4_FRAGMENT_BYTES = MAX_FRAME_BYTES + 2 * MAX_INIT_BYTES


class Fmp4FragmentAssembler:
    def __init__(self):
        self.buffer = bytearray()
        self.prefix = []
        self.prefix_bytes = 0
        self.awaiting_mdat = False

    def feed(self, data):
        """Return complete ordered fragments. Input may split ANY box byte."""
        if data:
            self.buffer.extend(data)
        if len(self.buffer) > MAX_MP4_FRAGMENT_BYTES:
            raise VideoProbeError("MP4 媒体分片过大")
        completed = []
        while len(self.buffer) >= 8:
            size, name = struct.unpack_from(">I4s", self.buffer)
            header_size = 8
            if size == 1:
                if len(self.buffer) < 16:
                    break
                size = struct.unpack_from(">Q", self.buffer, 8)[0]
                header_size = 16
            if size < header_size or size > MAX_MP4_FRAGMENT_BYTES:
                raise VideoProbeError("MP4 媒体盒尺寸无效")
            if len(self.buffer) < size:
                break
            box = bytes(self.buffer[:size])
            del self.buffer[:size]
            if name == b"moof":
                if self.awaiting_mdat:
                    raise VideoProbeError("MP4 分片缺少 mdat")
                self.awaiting_mdat = True
                self.prefix.append(box)
                self.prefix_bytes += len(box)
            elif name == b"mdat":
                if not self.awaiting_mdat:
                    raise VideoProbeError("MP4 媒体数据缺少 moof")
                completed.append(b"".join((*self.prefix, box)))
                self.prefix.clear()
                self.prefix_bytes = 0
                self.awaiting_mdat = False
            elif name in (b"styp", b"free", b"sidx", b"emsg", b"prft"):
                # Optional pre-fragment metadata belongs with the next frame.
                self.prefix.append(box)
                self.prefix_bytes += len(box)
            elif name == b"mfra":
                # Trailing FFmpeg index only appears when the stream closes;
                # no live video sample depends on it.
                if self.awaiting_mdat:
                    raise VideoProbeError("MP4 结束索引前缺少 mdat")
            else:
                raise VideoProbeError("MP4 视频流含不支持的媒体盒")
            if self.prefix_bytes > MAX_MP4_FRAGMENT_BYTES:
                raise VideoProbeError("MP4 媒体分片前缀过大")
        return completed


def _socket_read(sock, amount, stop, timeout=1.0, adb_proc=None):
    """Cancel-aware exact reads for continuous sessions, unlike bounded probe."""
    out = bytearray()
    while len(out) < amount:
        if stop.is_set():
            raise StreamStopped()
        # Existing local child state, NOT a new adb command or background poll.
        # Covers a dead scrcpy/adb shell process even if the forwarded TCP
        # connection does not promptly deliver FIN/EOF.
        if adb_proc is not None and adb_proc.poll() is not None:
            raise VideoProbeError("本轮 ADB/scrcpy 视频进程已退出")
        sock.settimeout(timeout)
        try:
            block = sock.recv(amount - len(out))
        except socket.timeout:
            continue
        except OSError as exc:
            if stop.is_set():
                raise StreamStopped() from exc
            raise VideoProbeError("手机端视频 socket 中断") from exc
        if not block:
            raise VideoProbeError("手机端视频 socket 已关闭")
        out.extend(block)
    return bytes(out)


class LiveVideo:
    def __init__(self, serial, profile, server_file=None, quality=None, display_source=None, screen_off=False):
        self.settings = resolve_live_quality(profile, quality)
        self.serial = serial
        self.profile = profile
        self.display_source = display_source  # None keeps the original primary screen.
        self.screen_off = screen_off is True and display_source is None
        # Opaque ID for this user-started session. Used for lifecycle messages
        # and future control-channel binding; it never selects an ADB target.
        self.session_id = secrets.token_hex(12)
        self.server_file = Path(server_file) if server_file is not None else SERVER_FILE
        self.stop_event = threading.Event()
        self.finished = threading.Event()  # worker terminated, not necessarily fully cleaned
        self.cleanup_complete = False  # only true after all owned resources are released
        self._close_failed = False
        self.events = queue.Queue(MAX_QUEUE_ITEMS)
        self.thread = None
        self.video_sock = None
        self.control_sock = None
        self.touch_size = None
        self.touch_pressed = False
        self.touch_point = None
        self._touch_lock = threading.Lock()
        self.adb_proc = None
        self.ffmpeg_proc = None
        self._resource_lock = threading.Lock()
        self._resource_meter = ProcessMeter()
        self._adb_log_fd = None  # dup of THIS worker's private stdout, never logcat
        self._control_attempted = False
        self._control_warning = None
        # Session-local, read-only telemetry. No ADB polling, videos or tokens.
        self._born = time.monotonic()
        self._metric_lock = threading.Lock()
        self._phase = "等待启动"
        self._phone_packets = 0
        self._phone_last = None
        self._mux_chunks = 0
        self._mux_last = None
        self._media_fragments = 0
        self._ready_at = None

    def _phase_set(self, phase):
        with self._metric_lock:
            self._phase = phase

    def _record_phone_packet(self):
        with self._metric_lock:
            self._phone_packets += 1
            self._phone_last = time.monotonic()

    def _record_mux_chunk(self):
        with self._metric_lock:
            self._mux_chunks += 1
            self._mux_last = time.monotonic()

    def _record_media_fragments(self, count):
        with self._metric_lock:
            self._media_fragments += count

    def diagnostics(self):
        """Safe stage/age counters for an explicitly opened stream only."""
        now = time.monotonic()
        with self._resource_lock:
            pids = [getattr(p, "pid", None) for p in (self.adb_proc, self.ffmpeg_proc)]
        resources = self._resource_meter.sample(pids, now)
        # Only after explicit user input. os.pread does not change the shared
        # shell log write offset; raw shell output never leaves this server.
        with self._touch_lock:
            attempted = self._control_attempted
        if attempted and self._control_warning is None:
            with self._resource_lock:
                fd = self._adb_log_fd
                if fd is not None:
                    try:
                        size = os.fstat(fd).st_size
                        chunk = os.pread(fd, min(size, 65536), max(0, size - 65536))
                        warning = classify_control_log(chunk)
                        if warning:
                            self._control_warning = warning
                    except (OSError, ValueError):
                        pass
        with self._metric_lock:
            return {
                **resources,
                "control_warning": self._control_warning,
                "stage": self._phase,
                "elapsed_ms": round((now - self._born) * 1000),
                "phone_packets": self._phone_packets,
                "phone_idle_ms": (round((now - self._phone_last) * 1000)
                                  if self._phone_last is not None else None),
                "mux_chunks": self._mux_chunks,
                "media_fragments": self._media_fragments,
                "mux_idle_ms": (round((now - self._mux_last) * 1000)
                                if self._mux_last is not None else None),
                "init_ready_ms": (round((self._ready_at - self._born) * 1000)
                                   if self._ready_at is not None else None),
            }

    def start(self):
        if self.thread is not None:
            raise RuntimeError("已启动")
        self.thread = threading.Thread(target=self._run, daemon=True, name="easyadb-m2-live")
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        with self._resource_lock:
            sock = self.video_sock
            adb_proc = self.adb_proc
            mux = self.ffmpeg_proc
        # One stop gate closes touch, text and keys together. Since stop_event
        # was set first, no fresh command may race this final finger release.
        with self._touch_lock:
            control = self.control_sock
            try:
                if control and self.touch_pressed:
                    try:
                        self._release_touch_locked()
                    except (OSError, InvalidTouch):
                        # Broken control socket must not block video/ADB cleanup.
                        pass
            finally:
                self.control_sock = None
                self.touch_size = None
                self.touch_pressed = False
                self.touch_point = None
                if control:
                    try:
                        control.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
                    try:
                        control.close()
                    except OSError:
                        self._close_failed = True
        if sock:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                sock.close()
            except OSError:
                self._close_failed = True
        for proc in (mux, adb_proc):
            if proc is not None and proc.poll() is None:
                try:
                    proc.terminate()
                except OSError:
                    pass

    def send_touch(self, payload):
        """Bounded write on this session's pinned control socket only."""
        with self._touch_lock:
            if self.stop_event.is_set() or self.finished.is_set() or not self.control_sock or not self.touch_size:
                raise InvalidTouch("当前投屏控制通道尚未就绪")
            if not isinstance(payload, dict) or payload.get("session_id") != self.session_id:
                raise InvalidTouch("触摸请求不属于当前视频会话")
            packet, next_pressed = encode_touch(payload, self.touch_size, self.touch_pressed)
            self._control_attempted = True
            try:
                self.control_sock.sendall(packet)
            except (OSError, socket.timeout) as exc:
                self.stop_event.set()
                raise VideoProbeError("scrcpy 控制通道已断开，本轮投屏必须重新开始") from exc
            self.touch_pressed = next_pressed
            self.touch_point = (payload["x"], payload["y"]) if next_pressed else None

    def _send_input(self, payload, encoder):
        """Send one allowlisted message on this live session's control socket.

        Serialize text/key writes with touch, never reuse a stale control socket.
        The caller already checked the same WS opt-in and current selected route.
        """
        with self._touch_lock:
            if self.stop_event.is_set() or self.finished.is_set() or not self.control_sock or not self.touch_size:
                raise InvalidTouch("当前投屏控制通道尚未就绪")
            if not isinstance(payload, dict) or payload.get("session_id") != self.session_id:
                raise InvalidTouch("输入请求不属于当前视频会话")
            packet = encoder(payload)  # strict schema/key whitelist BEFORE any write
            self._control_attempted = True
            try:
                self.control_sock.sendall(packet)
            except (OSError, socket.timeout) as exc:
                self.stop_event.set()
                raise VideoProbeError("scrcpy 控制通道已断开，本轮投屏必须重新开始") from exc

    def set_display_power(self, on):
        """scrcpy v5 control type 10 + boolean: affects physical panel, not encoding.

        No implicit ADB connect, no POWER toggle and no new media/control session.
        A successful socket write is not proof the OEM accepted display power.
        """
        if type(on) is not bool:
            raise InvalidTouch("无效的屏幕电源参数")
        with self._touch_lock:
            if (self.stop_event.is_set() or self.finished.is_set()
                    or not self.control_sock or not self.touch_size or self.display_source):
                raise InvalidTouch("当前主屏投屏控制通道不可用")
            self._control_attempted = True
            try:
                self.control_sock.sendall(bytes((10, 1 if on else 0)))
            except (OSError, socket.timeout) as exc:
                self.stop_event.set()
                raise VideoProbeError("屏幕电源指令发送失败，本轮投屏需重新开始") from exc

    def wake_display(self):
        """Explicit user action: restore panel power, then request Android WAKEUP.

        WAKEUP (224) is idempotent; unlike POWER it cannot accidentally sleep an
        already awake phone. Both operations target this session's fixed serial.
        """
        self.set_display_power(True)
        _run_adb(self.serial, "shell", "input", "keyevent", "224", timeout=7)

    def send_text(self, payload):
        self._send_input(payload, encode_text)

    def send_nav(self, payload):
        self._send_input(payload, encode_key)

    def _release_touch_locked(self):
        """Use only while holding _touch_lock. Clears state even if socket fails."""
        if not self.touch_pressed or not self.control_sock or not self.touch_size or not self.touch_point:
            return
        x, y = self.touch_point
        width, height = self.touch_size
        packet, _ = encode_touch({
            "type": "touch", "session_id": self.session_id, "action": "cancel",
            "x": x, "y": y, "width": width, "height": height,
        }, (width, height), True)
        try:
            self.control_sock.sendall(packet)
        finally:
            self.touch_pressed = False
            self.touch_point = None

    def release_touch(self):
        """Explicit disable releases only this session's currently held finger."""
        with self._touch_lock:
            self._release_touch_locked()

    def join(self, timeout=8):
        if self.thread:
            self.thread.join(timeout=timeout)

    def _emit(self, item):
        deadline = time.monotonic() + MAX_QUEUE_WAIT
        while not self.stop_event.is_set():
            try:
                self.events.put(item, timeout=0.2)
                return
            except queue.Full:
                if time.monotonic() >= deadline:
                    raise VideoProbeError("浏览器读取视频过慢，已终止本轮会话")
        raise StreamStopped()

    def _stream_to_ffmpeg(self, video, mux, first_header):
        """Consume only matching scrcpy v5.0.1 H264 Annex B media packets."""
        header = first_header
        first_config = False
        while not self.stop_event.is_set():
            pts, length = struct.unpack(">QI", header)
            if pts & (1 << 63):
                _, width, height = struct.unpack(">III", header)
                # fMP4 track dimensions are fixed for this first-stage spike.
                raise VideoProbeError(
                    "手机画面尺寸发生变化；首版请停止后重新开始投屏")
            if not 0 < length <= MAX_FRAME_BYTES:
                raise VideoProbeError("scrcpy H.264 媒体包大小异常")
            payload = _socket_read(video, length, self.stop_event, adb_proc=self.adb_proc)
            if not pts & (1 << 62):
                self._record_phone_packet()
            if pts & (1 << 62):
                first_config = True
            elif not first_config and not (pts & (1 << 61)):
                # Wait for codec initialization and a safe random-access frame.
                header = _socket_read(video, HEADER_BYTES, self.stop_event, adb_proc=self.adb_proc)
                continue
            if first_config or (pts & (1 << 61)):
                try:
                    mux.stdin.write(payload)
                    mux.stdin.flush()
                except (OSError, BrokenPipeError, ValueError) as exc:
                    raise VideoProbeError("FFmpeg 已停止接收 H.264 数据") from exc
            header = _socket_read(video, HEADER_BYTES, self.stop_event, adb_proc=self.adb_proc)
        raise StreamStopped()

    def _run(self):
        scid = f"{secrets.randbelow(0x7FFFFFFE) + 1:08x}"
        remote = f"/data/local/tmp/easyadb-live-{scid}.jar"
        abstract = f"localabstract:scrcpy_{scid}"
        port = None
        remote_pushed = False
        feeder = None
        failure = None
        try:
            if self.stop_event.is_set():
                raise StreamStopped()
            if not self.server_file.is_file():
                raise VideoProbeError("缺少官方固定版本 scrcpy-server，需重新构建 M2 镜像")
            before_ids = None
            if self.display_source and self.display_source["mode"] in ("new", "new_settings"):
                try:
                    before_ids = display_ids(_run_adb(self.serial, "shell", "dumpsys", "display"))
                except VideoProbeError:
                    before_ids = [0]
            with tempfile.TemporaryFile(mode="w+b") as adb_log, tempfile.TemporaryFile(mode="w+b") as mux_log:
                with self._resource_lock:
                    self._adb_log_fd = os.dup(adb_log.fileno())
                self._phase_set("推送 scrcpy-server")
                _run_adb(self.serial, "push", str(self.server_file), remote)
                remote_pushed = True
                self._phase_set("创建 ADB 视频转发")
                port_text = _run_adb(self.serial, "forward", "tcp:0", abstract)
                if not port_text.isdigit() or not 1 <= int(port_text) <= 65535:
                    raise VideoProbeError("创建视频专用 ADB 转发失败")
                port = int(port_text)
                settings = self.settings
                cmd = [
                    "adb", "-s", self.serial, "shell", f"CLASSPATH={remote}",
                    "app_process", "/", "com.genymobile.scrcpy.Server", VERSION,
                    f"scid={scid}", "video=true", "audio=false", "control=true",
                    "tunnel_forward=true", "send_device_meta=true",
                    "send_frame_meta=true", "send_stream_meta=true",
                    "send_dummy_byte=true", "cleanup=true", "power_on=false",
                    "clipboard_autosync=false",
                    "downsize_on_error=false", "video_codec=h264",
                    f"max_size={settings['max_size']}",
                    f"video_bit_rate={settings['video_bit_rate']}",
                    f"max_fps={settings['max_fps']}",
                ]
                if self.display_source:
                    mode = self.display_source["mode"]
                    if mode in ("new", "new_settings"):
                        cmd.append("new_display=1920x1080/240")
                    elif mode == "display":
                        cmd.append("display_id=" + str(self.display_source["display_id"]))
                adb_proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL,
                                            stdout=adb_log, stderr=subprocess.STDOUT)
                with self._resource_lock:
                    self.adb_proc = adb_proc
                self._phase_set("等待 scrcpy 握手")
                video = _connect_forwarded(port, adb_proc, time.monotonic() + 16)
                with self._resource_lock:
                    self.video_sock = video
                # v5.0.1 forward socket order: video, audio(if on), control.
                # Dummy 0x00 appears only on the FIRST socket (video).
                # The Android server does not send its device metadata until
                # the second (control) socket has also been accepted.
                self._phase_set("建立本轮 scrcpy 控制通道")
                try:
                    control = socket.create_connection(("127.0.0.1", port), timeout=3)
                    control.settimeout(2)
                except OSError as exc:
                    raise VideoProbeError("scrcpy 控制通道连接失败") from exc
                with self._touch_lock:
                    if self.stop_event.is_set():
                        control.close()
                        raise StreamStopped()
                    self.control_sock = control
                if self.display_source and self.display_source["mode"] in ("new", "new_settings"):
                    # Bounded discovery during user-started session startup only.
                    created = None
                    for _ in range(8):
                        if self.stop_event.is_set():
                            raise StreamStopped()
                        try:
                            current_ids = display_ids(_run_adb(self.serial, "shell", "dumpsys", "display"))
                            added = sorted(set(current_ids) - set(before_ids or [0]))
                            if added:
                                created = added[-1]
                                break
                        except VideoProbeError:
                            pass
                        time.sleep(0.35)
                    notice = {"mode": self.display_source["mode"], "display_id": created}
                    if created is None:
                        notice["message"] = "已请求创建虚拟屏幕，但未识别新增 Display ID；请检查画面"
                    elif self.display_source["mode"] == "new_settings":
                        try:
                            _run_adb(self.serial, "shell", "am", "start", "--display", str(created),
                                     "-a", "android.settings.SETTINGS")
                            notice["message"] = "已尝试在新增屏幕打开设置，请查看画面确认"
                        except VideoProbeError:
                            notice["message"] = "新增屏幕已创建，系统拒绝在该屏幕启动设置"
                    else:
                        notice["message"] = "检测到新增 Display ID，请查看是否出现桌面"
                    self._emit(("lab_notice", notice))
                name = _socket_read(video, DEVICE_NAME_BYTES, self.stop_event, adb_proc=self.adb_proc).split(b"\0", 1)[0]
                codec = _socket_read(video, 4, self.stop_event, adb_proc=self.adb_proc)
                if codec != b"h264":
                    raise VideoProbeError("scrcpy 未输出预期 H.264 编码")
                header = _socket_read(video, HEADER_BYTES, self.stop_event, adb_proc=self.adb_proc)
                flags, width, height = struct.unpack(">III", header)
                if not flags & 0x80000000 or not 0 < width <= 8192 or not 0 < height <= 8192:
                    raise VideoProbeError("scrcpy 视频初始化尺寸无效")
                first_header = _socket_read(video, HEADER_BYTES, self.stop_event, adb_proc=self.adb_proc)
                with self._touch_lock:
                    self.touch_size = (width, height)
                self._phase_set("等待 FFmpeg 初始化段")

                # No transcoding; only repack existing H264 bytes into fMP4.
                mux = subprocess.Popen(
                    ["ffmpeg", *FFMPEG_MSE_ARGS],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                   stderr=mux_log, bufsize=0)
                with self._resource_lock:
                    self.ffmpeg_proc = mux

                def feed():
                    try:
                        self._stream_to_ffmpeg(video, mux, first_header)
                    except StreamStopped:
                        pass
                    except VideoProbeError as exc:
                        if not self.stop_event.is_set():
                            try:
                                self._emit(("error", str(exc)))
                            except (VideoProbeError, StreamStopped):
                                pass
                            finally:
                                # Do not wait for FFmpeg stdout/EOF to eventually
                                # notice a dead ADB media socket. Stop all input
                                # immediately; the owner thread runs final cleanup.
                                self.stop_event.set()
                    finally:
                        if mux.stdin:
                            try:
                                mux.stdin.close()
                            except OSError:
                                pass

                feeder = threading.Thread(target=feed, daemon=True, name="easyadb-m2-feeder")
                feeder.start()
                init_buffer = bytearray()
                fragmenter = Fmp4FragmentAssembler()
                has_init = False
                init_started = time.monotonic()
                while not self.stop_event.is_set():
                    if adb_proc.poll() is not None:
                        raise VideoProbeError("本轮 ADB/scrcpy 视频进程已退出")
                    if not has_init and time.monotonic() - init_started > 25:
                        raise VideoProbeError("FFmpeg 25 秒内未生成 MP4 初始化段，请检查编码器或屏幕状态")
                    # Avoid indefinitely blocking on a quiet/failed encoder,
                    # so stop/route switch can release its session promptly.
                    ready, _, _ = select.select([mux.stdout], [], [], 0.5)
                    if not ready:
                        continue
                    data = os.read(mux.stdout.fileno(), 32768)
                    if not data:
                        if not self.stop_event.is_set():
                            mux_log.flush()
                            mux_log.seek(0)
                            raw = mux_log.read(10000).decode("utf-8", "replace").lower()
                            msg = ("FFmpeg H.264 转封装失败，请重新开始实验"
                                   if "error" in raw or mux.poll() not in (0, None)
                                   else "视频编码流已结束")
                            raise VideoProbeError(msg)
                        break
                    self._record_mux_chunk()
                    if not has_init:
                        init_buffer.extend(data)
                        if len(init_buffer) > MAX_INIT_BYTES:
                            raise VideoProbeError("MP4 初始化信息过大")
                        parsed = parse_init_segments(init_buffer)
                        if parsed is None:
                            continue
                        end, init, mime = parsed
                        with self._metric_lock:
                            self._ready_at = time.monotonic()
                            self._phase = "已生成 MP4 初始化段"
                        if self.screen_off:
                            # Stream is established before darkening the physical panel.
                            # This scrcpy control message keeps the encoder running.
                            self.set_display_power(False)
                            self._emit(("screen_power_notice", {"on": False,
                                "message": "已发送物理屏幕关闭指令；编码与浏览器画面继续运行"}))
                        self._emit(("init", {"mime": mime, "width": width, "height": height,
                                             "profile": self.profile, "requested": dict(self.settings),
                                             "codec": "h264", "control_available": True,
                                             "device": name.decode("utf-8", "replace")}))
                        self._emit(("bytes", init))
                        remainder = bytes(init_buffer[end:])
                        init_buffer.clear()
                        fragments = fragmenter.feed(remainder)
                        for fragment in fragments:
                            self._emit(("bytes", fragment))
                        if fragments:
                            self._record_media_fragments(len(fragments))
                        has_init = True
                        self._phase_set("持续传输")
                    else:
                        fragments = fragmenter.feed(data)
                        for fragment in fragments:
                            self._emit(("bytes", fragment))
                        if fragments:
                            self._record_media_fragments(len(fragments))
        except StreamStopped:
            pass
        except VideoProbeError as exc:
            failure = str(exc)
        except (OSError, subprocess.SubprocessError) as exc:
            failure = "实时视频启动或转封装失败，请检查手机端视频功能及 FFmpeg"
        finally:
            with self._resource_lock:
                fd = self._adb_log_fd
                self._adb_log_fd = None
                if fd is not None:
                    try:
                        os.close(fd)
                    except OSError:
                        pass
            self._phase_set("结束并清理视频会话")
            # finished means the worker is terminal; cleanup_complete is the
            # stronger promise required before the device slot can be reused.
            # Attempt EVERY owned-resource cleanup even when one step fails.
            cleaned = False
            cleanup_ok = True
            try:
                try:
                    self.stop()
                except (OSError, ValueError):
                    cleanup_ok = False
                if feeder:
                    feeder.join(timeout=3)
                    if feeder.is_alive():
                        cleanup_ok = False
                for proc in (self.ffmpeg_proc, self.adb_proc):
                    if proc is not None:
                        try:
                            proc.wait(timeout=3)
                        except subprocess.TimeoutExpired:
                            try:
                                proc.kill()
                                proc.wait(timeout=2)
                            except (OSError, subprocess.TimeoutExpired):
                                cleanup_ok = False
                        except (OSError, ValueError):
                            cleanup_ok = False
                if port is not None:
                    try:
                        _run_adb(self.serial, "forward", "--remove", f"tcp:{port}", timeout=5)
                    except VideoProbeError:
                        cleanup_ok = False
                if remote_pushed:
                    try:
                        _run_adb(self.serial, "shell", "rm", "-f", remote, timeout=5)
                    except VideoProbeError:
                        cleanup_ok = False
                cleaned = cleanup_ok and not self._close_failed
            finally:
                self.cleanup_complete = cleaned
                if failure:
                    try:
                        self.events.put_nowait(("error", failure))
                    except queue.Full:
                        pass
                if not cleaned:
                    try:
                        self.events.put_nowait(("error", "本轮资源清理未全部确认，设备会话保持占用以避免并发冲突"))
                    except queue.Full:
                        pass
                try:
                    self.events.put_nowait(("end", None))
                except queue.Full:
                    pass
                self.finished.set()



class LiveRegistry:
    """At most four explicit sessions, one per logical device; no auto startup."""
    MAX_LIVE_SESSIONS = 4
    def __init__(self):
        self.lock = threading.Lock()
        self.sessions = {}

    def reserve(self, device_id, session):
        with self.lock:
            old = self.sessions.get(device_id)
            if old is not None:
                # If a bounded WS cleanup timed out but the worker eventually
                # finished, retire it only AFTER its resources have gone.
                finished = getattr(old, "finished", None)
                if finished is None or not finished.is_set() or not getattr(old, "cleanup_complete", True):
                    return False
                self.sessions.pop(device_id, None)
            # Also bound directly-authenticated WS requests, not only UI.
            # Dirty worker slots count until they are verifiably cleaned.
            if len(self.sessions) >= self.MAX_LIVE_SESSIONS:
                return False
            self.sessions[device_id] = session
            return True

    @staticmethod
    def is_cleaned(session):
        finished = getattr(session, "finished", None)
        return bool(finished is not None and finished.is_set()
                    and getattr(session, "cleanup_complete", True))

    def release(self, device_id, session):
        with self.lock:
            if self.sessions.get(device_id) is session:
                self.sessions.pop(device_id, None)

    def stop_for(self, device_id):
        with self.lock:
            s = self.sessions.get(device_id)
        if s:
            s.stop()

    def stop_all(self):
        with self.lock:
            sessions = list(self.sessions.values())
        for s in sessions:
            s.stop()
        for s in sessions:
            s.join(timeout=8)
