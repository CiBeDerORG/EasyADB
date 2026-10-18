"""Bounded scrcpy v5.0.1 H.264 video transport experiment.

This deliberately receives and validates encoded packets; it does NOT decode
frames, record personal screen contents, open a WebSocket or control the phone.
Call only from an authenticated, explicit user action on the selected ADB
serial. Never reconnect or try the alternate address.
"""
import os
import re
import secrets
import socket
import struct
import subprocess
import tempfile
import time
from pathlib import Path

VERSION = "5.0.1"
EXPECTED_SHA256 = "764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536"
SERVER_FILE = Path(os.getenv("EASYADB_SCRCPY_SERVER", "/opt/easyadb/scrcpy/server"))
DEVICE_NAME_BYTES = 64
HEADER_BYTES = 12
MAX_PACKET_BYTES = 8 * 1024 * 1024
MAX_SAMPLE_BYTES = 32 * 1024 * 1024
PROBE_SECONDS = 16
# Bounded profiles only; changing this never changes the saved M1 connection.
PROFILES = {
    "baseline": {"max_size": 1600, "video_bit_rate": 8_000_000, "max_fps": 30},
    "native": {"max_size": 0, "video_bit_rate": 16_000_000, "max_fps": 30},
}


class VideoProbeError(Exception):
    """Expected device transport, codec, or protocol experiment failure."""


def _run_adb(serial, *args, timeout=12):
    try:
        result = subprocess.run(["adb", "-s", serial, *args], text=True,
                                capture_output=True, check=False, timeout=timeout)
    except (subprocess.TimeoutExpired, OSError) as exc:
        raise VideoProbeError("ADB 视频实验命令未能完成") from exc
    if result.returncode:
        raise VideoProbeError("ADB 视频实验命令失败，请确认当前地址仍已连接")
    return result.stdout.strip()


def _read_exact(sock, count, deadline):
    chunks = bytearray()
    while len(chunks) < count:
        remain = deadline - time.monotonic()
        if remain <= 0:
            raise VideoProbeError("等候 scrcpy 编码数据超时")
        sock.settimeout(min(1.5, remain))
        try:
            block = sock.recv(count - len(chunks))
        except socket.timeout:
            # A slow encoder may not emit anything for a short interval.
            # Respect the overall deadline rather than prematurely failing.
            continue
        except OSError as exc:
            raise VideoProbeError("scrcpy 视频连接中断") from exc
        if not block:
            raise VideoProbeError("scrcpy 视频流提前结束")
        chunks.extend(block)
    return bytes(chunks)


def read_scrcpy_sample(sock, deadline, max_packets=48, handshake_done=False):
    """Parse v5.0.1 first socket: dummy, 64B name, codec, session, packets.

    The production connect helper already reads the dummy byte as a genuine
    readiness check. The default keeps direct parser callers backwards
    compatible and allows standalone protocol tests.
    """
    if not handshake_done and _read_exact(sock, 1, deadline) != b"\x00":
        raise VideoProbeError("scrcpy 连接握手字节无效")
    device_name = _read_exact(sock, DEVICE_NAME_BYTES, deadline).split(b"\x00", 1)[0].decode(
        "utf-8", errors="replace")
    codec = _read_exact(sock, 4, deadline)
    if codec != b"h264":
        raise VideoProbeError("未收到预期的 H.264 视频编码标识")
    header = _read_exact(sock, HEADER_BYTES, deadline)
    flags, width, height = struct.unpack(">III", header)
    if not flags & 0x80000000 or not 0 < width <= 8192 or not 0 < height <= 8192:
        raise VideoProbeError("scrcpy 首个视频会话尺寸头无效")

    configs = 0
    frames = 0
    key_frames = 0
    bytes_received = 0
    session_changes = 0
    first_pts = None
    last_pts = None
    # A quiet screen might produce few frames. Receiving one frame proves an
    # encoded stream arrived; two distinct media packets prove sustained output.
    for _ in range(max_packets):
        try:
            header = _read_exact(sock, HEADER_BYTES, deadline)
        except VideoProbeError:
            if frames:
                break
            raise
        pts_flags, length = struct.unpack(">QI", header)
        if pts_flags & (1 << 63):  # session/rotation event; NOT media payload
            flags, width, height = struct.unpack(">III", header)
            if not 0 < width <= 8192 or not 0 < height <= 8192:
                raise VideoProbeError("视频会话尺寸更新无效")
            session_changes += 1
            continue
        if not 0 < length <= MAX_PACKET_BYTES:
            raise VideoProbeError("scrcpy 视频包长度超出安全范围")
        bytes_received += length
        if bytes_received > MAX_SAMPLE_BYTES:
            raise VideoProbeError("本轮视频实验已达到最大读取量")
        # Do not store, log, return or persist any actual phone-screen data.
        _read_exact(sock, length, deadline)
        if pts_flags & (1 << 62):
            configs += 1
        else:
            pts = pts_flags & ((1 << 61) - 1)
            first_pts = pts if first_pts is None else first_pts
            last_pts = pts
            frames += 1
            if pts_flags & (1 << 61):
                key_frames += 1
            if frames >= 3:
                break
    if not frames:
        raise VideoProbeError("没有收到可用的 H.264 视频帧")
    return {
        "device_name": device_name,
        "codec": "h264",
        "encoded_width": width,
        "encoded_height": height,
        "configuration_packets": configs,
        "media_packets": frames,
        "key_frames": key_frames,
        "session_changes": session_changes,
        "sample_bytes": bytes_received,
        "sample_pts_span_us": max(0, last_pts - first_pts) if frames >= 2 else None,
        "stream_received": True,
        "continuous_frames": frames >= 2,
        "web_decode_verified": False,
        "note": "FNOS 已收到真实编码视频包；浏览器实时解码尚未实现",
    }


def _connect_forwarded(port, child, deadline):
    """Wait for the ANDROID localabstract server, not just the adb TCP port.

    The adb forward listener is established before scrcpy starts listening.
    TCP connect() may therefore succeed while the remote side immediately
    returns EOF. Official scrcpy verifies the dummy byte and retries THIS
    temporary local socket until it is ready. Never issue adb connect or
    switch the selected device route here.
    """
    while time.monotonic() < deadline:
        if child.poll() is not None:
            raise VideoProbeError("手机端 scrcpy 进程在视频握手前已退出")
        sock = None
        ready = False
        try:
            remain = deadline - time.monotonic()
            if remain <= 0:
                break
            sock = socket.create_connection(("127.0.0.1", port),
                                            timeout=min(0.4, remain))
            sock.settimeout(min(0.5, max(0.05, deadline - time.monotonic())))
            # An adb forwarding listener accepting TCP does NOT prove the
            # target scrcpy localabstract socket is listening yet.
            marker = sock.recv(1)
            if marker == b"\x00":
                ready = True
                return sock
            if marker:
                raise VideoProbeError("scrcpy 就绪握手字节不正确，请检查固定协议版本")
            # EOF: the Android socket has not started listening. Try a fresh
            # host-side connection, limited by the same one-shot deadline.
        except (OSError, socket.timeout):
            pass
        finally:
            if sock is not None and not ready:
                sock.close()
        if child.poll() is not None:
            raise VideoProbeError("手机端 scrcpy 进程在视频握手前已退出")
        remain = deadline - time.monotonic()
        if remain > 0:
            time.sleep(min(0.1, remain))
    raise VideoProbeError("手机端 scrcpy 视频 socket 在限时内未就绪（ADB 本地端口可连接不代表手机端已启动）")


def _server_failure_hint(server_log):
    """Return a fixed-category diagnosis; never return raw Android log lines."""
    try:
        server_log.flush()
        server_log.seek(0)
        message = server_log.read(16384).decode("utf-8", errors="replace").lower()
    except (OSError, ValueError):
        return "手机端日志不可读取"
    if "does not match the client" in message or "server version" in message and "match" in message:
        return "scrcpy server/client 版本不匹配"
    if "permission denied" in message or "securityexception" in message:
        return "手机端权限或屏幕捕获授权异常"
    if "mediacodec" in message or "encoder" in message or "codecexception" in message:
        return "手机端视频编码器初始化异常"
    if "could not find or load main class" in message or "classnotfoundexception" in message:
        return "手机端 scrcpy jar 加载异常"
    if "exception" in message or "[server] error:" in message:
        return "手机端 scrcpy 抛出异常（日志原文未返回，保护隐私）"
    return "无可识别的手机端错误日志"


def probe_video(serial, profile="baseline", server_file=None):
    """Single bounded user-triggered probe with per-probe ADB tunnel cleanup."""
    if profile not in PROFILES:
        raise VideoProbeError("未知视频实验档位")
    if not re.fullmatch(r"(?:[0-9]{1,3}\.){3}[0-9]{1,3}:[0-9]{1,5}", serial):
        raise VideoProbeError("设备连接地址无效")
    server = Path(server_file) if server_file is not None else SERVER_FILE
    if not server.is_file():
        raise VideoProbeError("容器内缺少已固定版本的 scrcpy-server，请重新构建 M2 镜像")
    settings = PROFILES[profile]
    scid = f"{secrets.randbelow(0x7FFFFFFE) + 1:08x}"
    remote = f"/data/local/tmp/easyadb-scrcpy-{scid}.jar"
    abstract = f"localabstract:scrcpy_{scid}"
    port = None
    child = None
    started = time.monotonic()
    try:
        _run_adb(serial, "push", str(server), remote)
        value = _run_adb(serial, "forward", "tcp:0", abstract)
        if not value.isdigit() or not 1 <= int(value) <= 65535:
            raise VideoProbeError("ADB 未返回可用的临时本地转发端口")
        port = int(value)
        cmd = [
            "adb", "-s", serial, "shell", f"CLASSPATH={remote}", "app_process", "/",
            "com.genymobile.scrcpy.Server", VERSION, f"scid={scid}",
            "video=true", "audio=false", "control=false", "tunnel_forward=true",
            "send_device_meta=true", "send_frame_meta=true", "send_stream_meta=true",
            "send_dummy_byte=true", "cleanup=true", "power_on=false",
            "downsize_on_error=false", "video_codec=h264",
            f"max_size={settings['max_size']}",
            f"video_bit_rate={settings['video_bit_rate']}",
            f"max_fps={settings['max_fps']}",
        ]
        # File-backed temporary capture avoids a PIPE filling and blocking the
        # device server. It is removed automatically and never logs raw screen.
        with tempfile.TemporaryFile(mode="w+b") as server_log:
            try:
                child = subprocess.Popen(cmd, stdin=subprocess.DEVNULL,
                                         stdout=server_log, stderr=subprocess.STDOUT)
            except OSError as exc:
                raise VideoProbeError("无法启动手机端 scrcpy 进程") from exc
            deadline = time.monotonic() + PROBE_SECONDS
            try:
                with _connect_forwarded(port, child, deadline) as video:
                    result = read_scrcpy_sample(video, deadline, handshake_done=True)
            except VideoProbeError as exc:
                # If the Android server terminated, report a concrete stage and
                # a safe error category instead of silently swallowing stderr.
                exit_code = child.poll()
                if exit_code is not None:
                    raise VideoProbeError(
                        f"{exc}；手机端进程退出码 {exit_code}；{_server_failure_hint(server_log)}"
                    ) from None
                raise
        return {
            "profile": profile,
            "selected_serial": serial,
            "scrcpy_version": VERSION,
            "requested": settings,
            "elapsed_ms": round((time.monotonic() - started) * 1000),
            **result,
        }
    finally:
        # Close the dedicated host-side adb shell; shutdown the socket first
        # above so a scrcpy process waiting on the media channel can exit.
        if child is not None and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=2)
        if port is not None:
            try:
                _run_adb(serial, "forward", "--remove", f"tcp:{port}", timeout=5)
            except VideoProbeError:
                pass
        try:
            _run_adb(serial, "shell", "rm", "-f", remote, timeout=5)
        except VideoProbeError:
            pass
