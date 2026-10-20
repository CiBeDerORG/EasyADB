"""Authenticated M2 live WebSocket presentation handler.

Exact M3 protocol and teardown are preserved; dependency aliases resolve from
the owning application only for this explicit user-opened WebSocket session.
"""
import asyncio
import json
import logging
import queue
import secrets
import time
from urllib.parse import urlsplit

from fastapi import WebSocket, WebSocketDisconnect

from ..display_lab import LabError
from ..m2_touch import InvalidTouch
from ..m2_video_probe import VideoProbeError
from ..services.operations import device_lock


async def handle_live_video(websocket: WebSocket, device_id: str, source):
    """Same-origin, explicitly authenticated WebSocket. Token in FIRST MESSAGE,
    not URL/query string/handshake; no ambient cookie-based device access.
    """
    # Resolve at request entry: existing tests may replace app-level runtime
    # objects and helpers; no second registry or ADB manager is ever created.
    TOKEN = source.TOKEN
    VIDEO_ENGINE = source.VIDEO_ENGINE
    store = source.store
    manager = source.manager
    live_registry = source.live_registry
    display_lab = source.display_lab
    LiveVideo = source.LiveVideo
    resolve_live_quality = source.resolve_live_quality
    EXPERIMENTAL_RESOLUTIONS = source.EXPERIMENTAL_RESOLUTIONS
    VIRTUAL_DPI_CHOICES = source.VIRTUAL_DPI_CHOICES
    selected_address = source.selected_address
    automatic_unlock = source.automatic_unlock
    is_connected = source.is_connected
    adb = source.adb
    confirm_live_adb_loss = source.confirm_live_adb_loss
    _close_webrtc_peer = source._close_webrtc_peer
    LIVE_HEARTBEAT_TIMEOUT = source.LIVE_HEARTBEAT_TIMEOUT
    LIVE_HEARTBEAT_CHECK_INTERVAL = source.LIVE_HEARTBEAT_CHECK_INTERVAL
    LIVE_WS_SEND_TIMEOUT = source.LIVE_WS_SEND_TIMEOUT

    origin = websocket.headers.get("origin", "")
    host = websocket.headers.get("host", "")
    origin_url = urlsplit(origin)
    if not host or not origin or origin_url.scheme not in ("http", "https") or origin_url.netloc != host:
        await websocket.close(code=1008, reason="来源地址不匹配")
        return
    await websocket.accept()
    stream = None
    pc = None  # one WebRTC peer per authenticated, explicitly started WS
    receiver = None
    watchdog = None
    unlock_task = None
    last_manual_unlock_at = 0.0
    requested_stop = asyncio.Event()
    touch_ready = asyncio.Event()
    manual_stop = False
    try:
        try:
            initial = await asyncio.wait_for(websocket.receive_json(), timeout=8)
        except (asyncio.TimeoutError, ValueError, TypeError):
            await websocket.close(code=1008, reason="未收到有效认证信息")
            return
        supplied = initial.get("token") if isinstance(initial, dict) else None
        if not isinstance(supplied, str) or not secrets.compare_digest(supplied, TOKEN):
            await websocket.close(code=1008, reason="访问密钥错误")
            return
        if VIDEO_ENGINE == "webcodecs":
            await websocket.send_json({"type": "error", "message": "WebCodecs 接口已预留，尚未实现；请在 .env 选择 webrtc"})
            return
        if initial.get("player") == "webcodecs":
            await websocket.send_json({"type": "error", "message": "WebCodecs 尚未实现，请在 .env 选择 webrtc"})
            return
        if initial.get("player", "webrtc") != VIDEO_ENGINE:
            await websocket.send_json({"type": "error", "message": "播放器与服务器 EASYADB_VIDEO_ENGINE 配置不一致，请刷新网页"})
            return
        profile = initial.get("profile")
        try:
            if profile != "custom" and "quality" in initial:
                raise ValueError("预设档位不可覆盖视频参数")
            quality_settings = resolve_live_quality(profile, initial.get("quality"))
        except ValueError as exc:
            # Reject malformed, oversized/unsupported or arbitrary options
            # BEFORE any ADB call, device lookup or new scrcpy worker.
            await websocket.send_json({"type": "error", "message": str(exc)})
            return
        # This is a per-session physical-panel option, never a persisted ADB
        # device mutation. Reject truthy strings/numbers instead of coercing.
        screen_off = initial.get("screen_off", False)
        if type(screen_off) is not bool:
            await websocket.send_json({"type": "error", "message": "息屏选项必须为布尔值"})
            return
        experiment = initial.get("display_experiment")
        if experiment is not None:
            if not isinstance(experiment, dict):
                await websocket.send_json({"type": "error", "message": "显示源实验参数无效"})
                return
            mode = experiment.get("mode")
            if mode == "new_resolution":
                if (set(experiment) not in ({"mode", "width", "height"},
                                             {"mode", "width", "height", "dpi"})
                        or type(experiment["width"]) is not int
                        or type(experiment["height"]) is not int
                        or type(experiment.get("dpi", 240)) is not int
                        or experiment.get("dpi", 240) not in VIRTUAL_DPI_CHOICES
                        or (experiment["width"], experiment["height"]) not in EXPERIMENTAL_RESOLUTIONS
                        or profile != "custom" or quality_settings["max_size"] != 0):
                    await websocket.send_json({"type": "error", "message": "实验性虚拟屏幕分辨率无效"})
                    return
            else:
                if set(experiment) not in ({"mode"}, {"mode", "display_id"}):
                    await websocket.send_json({"type": "error", "message": "显示源实验参数无效"})
                    return
                target = experiment.get("display_id")
                if (mode not in ("new", "new_settings", "display")
                        or (mode == "display" and (type(target) is not int or not 1 <= target <= 255))
                        or (mode != "display" and target is not None)):
                    await websocket.send_json({"type": "error", "message": "不支持的实验显示源"})
                    return
        if experiment is not None and screen_off:
            await websocket.send_json({"type": "error", "message": "虚拟/副屏实验不能同时启用主屏物理息屏"})
            return
        device = store.get(device_id)
        serial = selected_address(device) if device else None
        if not serial or serial != initial.get("selected_serial") or manager.serial_for(device) != serial:
            await websocket.send_json({"type": "error", "message": "请先手动连接当前选择的设备"})
            return
        adb_checked_at = time.monotonic()
        if not await asyncio.to_thread(is_connected, serial):
            await websocket.send_json({"type": "error", "message": "当前选择的 ADB 地址已离线"})
            return
        adb_check_ms = round((time.monotonic() - adb_checked_at) * 1000)
        # The saved credential is resolved server-side only, never sent to browser,
        # and is bound to this explicitly authenticated, selected device/session.
        try:
            unlock_secret = store.get_unlock_secret(device_id) if not experiment else None
        except ValueError:
            await websocket.send_json({"type": "error", "message": "开屏密码配置无效，请重新设置"})
            return
        if unlock_secret:
            screen_off = False  # Automatic wake/unlock overrides deferred physical screen-off.
        # Atomic with route mutation: another browser cannot switch the
        # selected serial between validation and reserving this live session.
        error = None
        with device_lock(manager, device_id):
            current = store.get(device_id)
            if not current or selected_address(current) != serial or manager.serial_for(current) != serial:
                error = "当前选择的 IP 已改变，请重新开启投屏"
            else:
                if experiment and experiment["mode"] in ("new", "new_settings", "new_resolution") and display_lab.has_pending(device_id):
                    error = "请先恢复系统副屏模拟设置，再创建 scrcpy 虚拟屏幕"
                elif experiment and experiment["mode"] == "display":
                    try:
                        found = display_lab.scan(serial)["display_ids"]
                        if experiment["display_id"] not in found:
                            error = "指定 Display ID 不存在，请重新扫描显示器"
                    except LabError as exc:
                        error = str(exc)
                # Preserve legacy constructor paths when screen-off is not selected
                # (existing M2 tests and clients still use the original shape).
                candidate = None
                if not error:
                    options = {}
                    if profile == "custom":
                        options["quality"] = quality_settings
                    if experiment:
                        options["display_source"] = experiment
                    if screen_off:
                        options["screen_off"] = True
                    if VIDEO_ENGINE == "webrtc":
                        options["video_engine"] = "webrtc"
                    candidate = LiveVideo(serial, profile=profile, **options)
                if candidate is None:
                    pass
                elif not live_registry.reserve(device_id, candidate):
                    error = "这台设备已有实时投屏会话，请先停止原会话"
                else:
                    stream = candidate
                    if VIDEO_ENGINE == "webrtc":
                        # Do not start capture until the offer is authenticated
                        # and an SDP answer has been sent to this same WS.
                        from ..m2_webrtc import ScrcpyH264Track
                        stream.webrtc_track = ScrcpyH264Track(asyncio.get_running_loop())
                    else:
                        try:
                            stream.start()
                        except (RuntimeError, OSError):
                            live_registry.release(device_id, candidate)
                            stream = None
                            error = "视频会话未能启动，请稍后重试"

        if error:
            await websocket.send_json({"type": "error", "message": error})
            return
        if experiment:
            display_lab._log(device_id, {"new": "A1", "new_settings": "A2",
                                "new_resolution": "实验性分辨率", "display": "B3"}[experiment["mode"]],
                             serial, "启动实验视频：" + str(experiment))
        await asyncio.wait_for(websocket.send_json({
            "type": "starting", "session_id": stream.session_id,
            "selected_serial": serial, "adb_check_ms": adb_check_ms,
            "player": VIDEO_ENGINE
        }), LIVE_WS_SEND_TIMEOUT)

        last_browser_ack = time.monotonic()

        async def run_unlock_attempt(password, source):
            # The browser sends only a session-scoped intent; the actual
            # credential never enters WebSocket JSON or the device log.
            try:
                result = await asyncio.to_thread(automatic_unlock, stream, password)
                explanations = {
                    "submitted": "已发送开屏密码与回车；是否解锁成功请查看设备",
                    "already_unlocked": "设备已处于解锁状态，无需输入密码",
                    "unknown_lock_state": "亮屏后仍无法从 Android/EMUI 确认锁屏状态，未输入密码；请提供锁屏状态诊断结果",
                    "unknown_after_swipe": "上滑后未能确认密码输入页仍处于锁屏状态，未输入密码；请提供锁屏状态诊断结果",
                    "unknown_screen_size": "无法获取屏幕尺寸，未执行解锁",
                    "skipped": "当前投屏已停止或显示源不支持解锁"
                }
                if not requested_stop.is_set():
                    await websocket.send_json({
                        "type": "unlock_notice", "session_id": stream.session_id,
                        "source": source, "status": result,
                        "message": explanations.get(result, "本次解锁操作已结束"),
                        "error": result not in ("submitted", "already_unlocked")
                    })
            except (InvalidTouch, VideoProbeError, OSError, ValueError):
                if not requested_stop.is_set():
                    await websocket.send_json({
                        "type": "unlock_notice", "session_id": stream.session_id,
                        "source": source, "status": "failed", "error": True,
                        "message": "解锁操作未完成，请查看手机状态和 ADB / scrcpy 控制权限"
                    })

        async def receive_commands():
            nonlocal manual_stop, last_browser_ack, pc, unlock_task, last_manual_unlock_at
            control_enabled = False
            last_move = 0.0
            last_input = 0.0
            try:
                while True:
                    raw = await websocket.receive_text()
                    if raw == "stop":
                        manual_stop = True
                        break
                    if len(raw) > 32768:
                        break  # allow one bounded WebRTC SDP offer, not arbitrary commands
                    try:
                        message = json.loads(raw)
                    except ValueError:
                        continue
                    if not isinstance(message, dict) or message.get("type") not in (
                        "control_enable", "control_disable", "touch", "input_text", "nav_key",
                        "wake", "unlock", "heartbeat", "webrtc_offer"
                    ):
                        continue  # NEVER interpret arbitrary device/ADB commands
                    if message.get("session_id") != stream.session_id:
                        break  # old or cross-session control attempt: terminate THIS WS
                    current = store.get(device_id)
                    if (not current or selected_address(current) != serial
                            or manager.serial_for(current) != serial or requested_stop.is_set()):
                        break  # no implicit connect, IP fallback or stale-target injection
                    kind = message["type"]
                    if kind == "webrtc_offer":
                        if (VIDEO_ENGINE != "webrtc" or pc is not None or
                                set(message) != {"type", "session_id", "sdp"} or
                                not isinstance(message["sdp"], str) or
                                not 100 <= len(message["sdp"]) <= 24000 or
                                "m=video " not in message["sdp"] or
                                "a=recvonly" not in message["sdp"]):
                            break
                        try:
                            from aiortc import (RTCPeerConnection, RTCConfiguration,
                                                RTCSessionDescription, RTCRtpSender)
                            pc = RTCPeerConnection(RTCConfiguration(iceServers=[]))
                            stream.peer_cleanup_complete = False
                            sender = pc.addTrack(stream.webrtc_track)
                            transceiver = next(t for t in pc.getTransceivers() if t.sender is sender)
                            h264 = [c for c in RTCRtpSender.getCapabilities("video").codecs
                                    if c.mimeType.lower() == "video/h264"]
                            if not h264:
                                raise RuntimeError("服务器 WebRTC 不支持 H.264")
                            transceiver.setCodecPreferences(h264)
                            @pc.on("connectionstatechange")
                            async def on_peer_state():
                                # Closing our own PC is an expected part of a
                                # manual stop, never a second teardown trigger.
                                if not requested_stop.is_set() and pc.connectionState in ("failed", "closed"):
                                    requested_stop.set()
                                    await asyncio.to_thread(stream.stop)
                            await asyncio.wait_for(pc.setRemoteDescription(
                                RTCSessionDescription(sdp=message["sdp"], type="offer")), timeout=12)
                            answer = await asyncio.wait_for(pc.createAnswer(), timeout=12)
                            await asyncio.wait_for(pc.setLocalDescription(answer), timeout=15)
                            await asyncio.wait_for(websocket.send_json({
                                "type": "webrtc_answer", "session_id": stream.session_id,
                                "sdp": pc.localDescription.sdp
                            }), LIVE_WS_SEND_TIMEOUT)
                            stream.start()
                            last_browser_ack = time.monotonic()
                        except Exception:
                            await websocket.send_json({"type": "error", "session_id": stream.session_id,
                                "message": "WebRTC SDP/ICE 协商失败，请检查浏览器 H.264 支持及 NAS UDP 网络"})
                            break
                        continue
                    if kind == "heartbeat":
                        # Diagnostic receipt proof for THIS session, not a
                        # phone keepalive. Malformed/stale heartbeat fails closed.
                        if set(message) != {"type", "session_id"}:
                            break
                        last_browser_ack = time.monotonic()
                        continue
                    if kind == "wake":
                        if set(message) != {"type", "session_id"}:
                            await websocket.send_json({"type": "wake_error", "session_id": stream.session_id,
                                                       "message": "唤醒请求字段无效"})
                            continue
                        if experiment:
                            await websocket.send_json({"type": "wake_error", "session_id": stream.session_id,
                                                       "message": "副屏实验不支持此主屏唤醒指令"})
                            continue
                        try:
                            await asyncio.to_thread(stream.wake_display)
                            await websocket.send_json({"type": "wake_accepted",
                                                       "session_id": stream.session_id,
                                                       "message": "已发送物理屏幕开启及 Android WAKEUP；请以设备状态为准"})
                        except InvalidTouch as exc:
                            await websocket.send_json({"type": "wake_error", "session_id": stream.session_id,
                                                       "message": str(exc)})
                        except VideoProbeError as exc:
                            offline = await confirm_live_adb_loss(device_id, serial)
                            await websocket.send_json({
                                "type": "wake_error", "session_id": stream.session_id,
                                "code": "adb_disconnected" if offline else "wake_failed",
                                "message": ("ADB 已断开，请手动连接" if offline else str(exc))
                            })
                            if offline or stream.stop_event.is_set():
                                break
                        continue
                    if kind == "unlock":
                        # Explicit per-card (or group-per-card) retry; never accept
                        # a password, serial or arbitrary ADB command in the payload.
                        if set(message) != {"type", "session_id"}:
                            await websocket.send_json({
                                "type": "unlock_notice", "session_id": stream.session_id,
                                "source": "manual", "status": "invalid", "error": True,
                                "message": "主动解锁请求字段无效"
                            })
                            continue
                        if experiment or not touch_ready.is_set():
                            await websocket.send_json({
                                "type": "unlock_notice", "session_id": stream.session_id,
                                "source": "manual", "status": "not_ready", "error": True,
                                "message": "主屏控制通道尚未就绪，不能主动解锁"
                            })
                            continue
                        if unlock_task is not None and not unlock_task.done():
                            await websocket.send_json({
                                "type": "unlock_notice", "session_id": stream.session_id,
                                "source": "manual", "status": "busy", "error": True,
                                "message": "当前设备已有一次解锁尝试在执行，请等待其结果"
                            })
                            continue
                        now_unlock = time.monotonic()
                        if now_unlock - last_manual_unlock_at < 3.0:
                            await websocket.send_json({
                                "type": "unlock_notice", "session_id": stream.session_id,
                                "source": "manual", "status": "cooldown", "error": True,
                                "message": "请至少间隔 3 秒再尝试主动解锁"
                            })
                            continue
                        try:
                            manual_secret = store.get_unlock_secret(device_id)
                        except ValueError:
                            manual_secret = None
                        if not manual_secret:
                            await websocket.send_json({
                                "type": "unlock_notice", "session_id": stream.session_id,
                                "source": "manual", "status": "unconfigured", "error": True,
                                "message": "本设备未配置有效开屏密码，请在 ADB 端口右上角的投屏参数中设置"
                            })
                            continue
                        last_manual_unlock_at = now_unlock
                        await websocket.send_json({
                            "type": "unlock_notice", "session_id": stream.session_id,
                            "source": "manual", "status": "running",
                            "message": "已开始主动解锁：亮屏、确认锁屏、输入密码并回车"
                        })
                        unlock_task = asyncio.create_task(run_unlock_attempt(manual_secret, "manual"))
                        continue
                    if kind == "control_enable":
                        if set(message) != {"type", "session_id"} or not touch_ready.is_set():
                            await websocket.send_json({"type": "touch_error", "message": "等待本轮视频与控制通道就绪"})
                            continue
                        control_enabled = True
                        await websocket.send_json({"type": "control_enabled",
                                                   "session_id": stream.session_id})
                    elif kind == "control_disable":
                        control_enabled = False
                        try:
                            await asyncio.to_thread(stream.release_touch)
                        except (OSError, ValueError):
                            break
                        await websocket.send_json({"type": "control_disabled",
                                                   "session_id": stream.session_id})
                    elif kind == "touch":
                        if not control_enabled or not touch_ready.is_set():
                            await websocket.send_json({"type": "touch_error", "message": "请先手动启用鼠标控制"})
                            continue
                        try:
                            # Always validate down/up. Avoid a flood of MOVE
                            # messages, but never throttle the final release.
                            if message.get("action") == "move" and time.monotonic()-last_move < 1/60:
                                continue
                            await asyncio.to_thread(stream.send_touch, message)
                            if message.get("action") == "move":
                                last_move = time.monotonic()
                        except InvalidTouch as exc:
                            await websocket.send_json({"type": "touch_error", "message": str(exc)})
                        except VideoProbeError as exc:
                            # A failed control socket may be caused by an ADB
                            # link loss. Check once, not from a background timer.
                            offline = await confirm_live_adb_loss(device_id, serial)
                            await websocket.send_json({
                                "type": "touch_error", "session_id": stream.session_id,
                                "code": "adb_disconnected" if offline else "control_failed",
                                "message": ("ADB 连接已中断，请手动重新连接"
                                            if offline else str(exc))
                            })
                            break
                    elif kind in ("input_text", "nav_key"):
                        # Never use clipboard, arbitrary adb shell, or global
                        # keyboard listeners. Only explicitly enabled session.
                        if not control_enabled or not touch_ready.is_set():
                            await websocket.send_json({"type": "input_error", "session_id": stream.session_id,
                                                       "message": "请先手动启用远程控制"})
                            continue
                        if time.monotonic() - last_input < 0.10:
                            await websocket.send_json({"type": "input_error", "session_id": stream.session_id,
                                                       "message": "输入过于频繁，请稍后再试"})
                            continue
                        try:
                            if kind == "input_text":
                                await asyncio.to_thread(stream.send_text, message)
                            else:
                                await asyncio.to_thread(stream.send_nav, message)
                            last_input = time.monotonic()
                            # Acknowledge a successful socket write, not Android
                            # text-field acceptance. Never echo input content.
                            await websocket.send_json({"type": "input_accepted",
                                                       "session_id": stream.session_id, "kind": kind})
                        except InvalidTouch as exc:
                            await websocket.send_json({"type": "input_error", "session_id": stream.session_id,
                                                       "message": str(exc)})
                        except VideoProbeError as exc:
                            offline = await confirm_live_adb_loss(device_id, serial)
                            await websocket.send_json({
                                "type": "input_error", "session_id": stream.session_id,
                                "code": "adb_disconnected" if offline else "control_failed",
                                "message": ("ADB 连接已中断，请手动重新连接"
                                            if offline else str(exc))
                            })
                            break
            except (WebSocketDisconnect, RuntimeError):
                pass
            finally:
                requested_stop.set()
                await asyncio.to_thread(stream.stop)

        async def watch_browser():
            # A half-open TCP connection need not produce WebSocketDisconnect.
            # Bound orphan sessions even when the browser dies without a FIN.
            while not requested_stop.is_set():
                await asyncio.sleep(LIVE_HEARTBEAT_CHECK_INTERVAL)
                if requested_stop.is_set():
                    return
                if VIDEO_ENGINE == "webrtc" and stream.thread is None and time.monotonic() - stream._born > 25:
                    requested_stop.set()
                    await asyncio.to_thread(stream.stop)
                    return
                if time.monotonic() - last_browser_ack >= LIVE_HEARTBEAT_TIMEOUT:
                    requested_stop.set()
                    await asyncio.to_thread(stream.stop)
                    return

        receiver = asyncio.create_task(receive_commands())
        watchdog = asyncio.create_task(watch_browser())
        # Transport payload-only accounting for THIS authenticated live session.
        # Excludes HTTP and network protocol framing/headers.
        ws_video_bytes = 0
        ws_video_chunks = 0
        next_diagnostic = 0.0
        while True:
            # Stop receives priority over queued old video fragments. The
            # browser waits for an "ended" message sent after cleanup/release.
            if requested_stop.is_set():
                if manual_stop:
                    await asyncio.wait_for(websocket.send_json({"type": "stopping",
                                               "session_id": stream.session_id}), LIVE_WS_SEND_TIMEOUT)
                break
            # Diagnostics exist only during this explicitly opened WebSocket;
            # metadata only; no extra ADB work or phone-screen bytes in logs.
            now = time.monotonic()
            if now >= next_diagnostic and not stream.finished.is_set():
                await asyncio.wait_for(websocket.send_json({
                    "type": "diagnostic", "session_id": stream.session_id,
                    **stream.diagnostics(), "ws_video_bytes": ws_video_bytes,
                    "ws_video_chunks": ws_video_chunks,
                    "webrtc_sent_frames": (stream.webrtc_track.sent_frames
                        if getattr(stream, "webrtc_track", None) is not None else None),
                    "webrtc_dropped_frames": (stream.webrtc_track.dropped_frames
                        if getattr(stream, "webrtc_track", None) is not None else None)
                }), LIVE_WS_SEND_TIMEOUT)
                next_diagnostic = now + 1.0
            if stream.finished.is_set() and stream.events.empty():
                # An early worker end might have lost its error event when the
                # bounded queue was full. Verify the selected ADB once.
                if not requested_stop.is_set() and await confirm_live_adb_loss(device_id, serial):
                    await asyncio.wait_for(websocket.send_json({
                        "type": "error", "code": "adb_disconnected",
                        "session_id": stream.session_id,
                        "message": "当前 ADB 连接已中断，投屏已停止，请手动重新连接"
                    }), LIVE_WS_SEND_TIMEOUT)
                break
            current = store.get(device_id)
            if not current or selected_address(current) != serial or manager.serial_for(current) != serial:
                await asyncio.wait_for(websocket.send_json({
                    "type": "error", "message": "设备连接地址已变更，投屏已停止"
                }), LIVE_WS_SEND_TIMEOUT)
                break
            try:
                kind, payload = await asyncio.to_thread(stream.events.get, True, 0.35)
            except queue.Empty:
                continue
            if kind == "init":
                # Publish control readiness BEFORE exposing init to the browser.
                # Otherwise a fast auto-control/unlock request races with this
                # flag and receives a spurious "not ready" rejection.
                if payload.get("control_available"):
                    touch_ready.set()
                await asyncio.wait_for(websocket.send_json({
                    "type": "init", "session_id": stream.session_id,
                    "player": VIDEO_ENGINE,
                    
                    "requested": quality_settings, **payload
                }), LIVE_WS_SEND_TIMEOUT)
                if payload.get("control_available"):
                    if unlock_secret and unlock_task is None and not experiment:
                        await websocket.send_json({
                            "type": "unlock_notice", "session_id": stream.session_id,
                            "source": "auto", "status": "running",
                            "message": "正在尝试启动自动解锁；如未成功，可使用悬浮菜单的主动解锁"
                        })
                        unlock_task = asyncio.create_task(run_unlock_attempt(unlock_secret, "auto"))
            elif kind == "screen_power_notice":
                await asyncio.wait_for(websocket.send_json({
                    "type": "screen_power_notice", "session_id": stream.session_id, **payload
                }), LIVE_WS_SEND_TIMEOUT)
            elif kind == "lab_notice":
                display_lab._log(device_id, "虚拟屏幕结果", serial, payload.get("message", "无"))
                await asyncio.wait_for(websocket.send_json({
                    "type": "lab_notice", "session_id": stream.session_id, **payload
                }), LIVE_WS_SEND_TIMEOUT)
            elif kind == "bytes":
                await asyncio.wait_for(websocket.send_bytes(payload), LIVE_WS_SEND_TIMEOUT)
                ws_video_bytes += len(payload)
                ws_video_chunks += 1
            elif kind == "error":
                # Only unexpected live transport/encoder errors trigger a
                # one-shot get-state, never continuous ADB polling.
                await asyncio.to_thread(stream.stop)
                offline = await confirm_live_adb_loss(device_id, serial)
                await asyncio.wait_for(websocket.send_json({
                    "type": "error", "session_id": stream.session_id,
                    "code": "adb_disconnected" if offline else "stream_failed",
                    "message": ("当前 ADB 连接已中断，投屏已停止，请手动重新连接"
                                if offline else payload)
                }), LIVE_WS_SEND_TIMEOUT)
                break
            elif kind == "end":
                break
    except (WebSocketDisconnect, RuntimeError, OSError, asyncio.TimeoutError):
        pass
    finally:
        # Also suppress pc.close() connectionstatechange callbacks from trying
        # to initiate a second teardown while the first cleanup is in progress.
        requested_stop.set()
        if watchdog:
            watchdog.cancel()
            await asyncio.gather(watchdog, return_exceptions=True)
        if stream:
            await asyncio.to_thread(stream.stop)
            if unlock_task:
                unlock_task.cancel()
                await asyncio.gather(unlock_task, return_exceptions=True)
            # SDP/ICE negotiation runs in the receiver task. Stop it before
            # closing the peer; otherwise it can race against pc.close().
            if receiver:
                receiver.cancel()
                await asyncio.gather(receiver, return_exceptions=True)
            if pc is not None:
                # Keep a strong reference on this registry-owned session.
                # Timeout only bounds the WS wait, never cancels peer teardown.
                stream.peer_close_task = asyncio.create_task(
                    _close_webrtc_peer(pc, stream, device_id, live_registry))
                try:
                    await asyncio.wait_for(asyncio.shield(stream.peer_close_task), 10)
                except asyncio.TimeoutError:
                    logging.getLogger(__name__).warning(
                        "WebRTC peer close still pending for device %s session %s; "
                        "will release only after verified late cleanup",
                        device_id, stream.session_id)
            if VIDEO_ENGINE == "webrtc" and getattr(stream, "thread", None) is None:
                # SDP failure never launched ADB or allocated a worker resource.
                stream.cleanup_complete = True
                stream.finished.set()
                if stream.webrtc_track is not None:
                    stream.webrtc_track.stop()
            await asyncio.to_thread(stream.join, 20)
            if live_registry.is_cleaned(stream):
                # Ended(cleanup_complete=true) only after all session-owned
                # video/control/ADB resources were verifiably released.
                live_registry.release(device_id, stream)
                if manual_stop:
                    try:
                        await asyncio.wait_for(websocket.send_json({
                            "type": "ended", "session_id": stream.session_id,
                            "reason": "manual", "cleanup_complete": True
                        }), LIVE_WS_SEND_TIMEOUT)
                    except (WebSocketDisconnect, RuntimeError, OSError, asyncio.TimeoutError):
                        pass
            elif manual_stop:
                # Fail closed: registry continues to reserve a worker whose
                # cleanup has not finished. reserve() retires it once finished.
                try:
                    await asyncio.wait_for(websocket.send_json({
                        "type": "error",
                        "message": "视频会话尚未完全清理，设备会话保持占用；不会同时启动第二路视频"
                    }), LIVE_WS_SEND_TIMEOUT)
                except (WebSocketDisconnect, RuntimeError, OSError, asyncio.TimeoutError):
                    pass
        try:
            await asyncio.wait_for(websocket.close(), LIVE_WS_SEND_TIMEOUT)
        except (RuntimeError, OSError, asyncio.TimeoutError):
            pass

