"""Authenticated M2 live WebSocket presentation handler.

Exact M3 protocol and teardown are preserved; dependency aliases resolve from
the owning application only for this explicit user-opened WebSocket session.
"""
import asyncio
import contextvars
import functools
import json
import logging
import queue
import secrets
import threading
import time
from urllib.parse import urlsplit

from fastapi import WebSocket, WebSocketDisconnect

from ..m2_touch import InvalidTouch
from ..m2_video_probe import VideoProbeError
from ..services.live_admission import prepare_live_session
from ..services.session_cleanup import cleanup_live_session


LIVE_TAKEOVER_TIMEOUT = 35


async def _owned_result(pending, on_cancel=None):
    """Drain an owned operation before propagating cancellation of its waiter."""
    cancellation = None
    while True:
        try:
            return await asyncio.shield(pending), cancellation
        except asyncio.CancelledError as exc:
            if on_cancel is not None:
                on_cancel()
            cancellation = exc
            if pending.cancelled():
                raise  # a cancelled child has no result; never busy-loop
        except Exception:
            if cancellation is not None:
                raise cancellation
            raise


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
    session_manager = source.session_manager
    resource_budget = source.resource_budget
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
    worker_launch_attempted = False
    budget_claimed = False
    request = None
    replacement_notice = None
    pending_client_left = False
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
        loop = asyncio.get_running_loop()
        owner_task = asyncio.current_task()
        admission_cancelled = threading.Event()
        admission_changed = asyncio.Event()

        async def send_replaced():
            message = {"type": "replaced", "message": "该设备的实时画面已由其他页面接管"}
            if request.stream is not None:
                message["session_id"] = request.stream.session_id
            try:
                await asyncio.wait_for(websocket.send_json(message), LIVE_WS_SEND_TIMEOUT)
            except (WebSocketDisconnect, RuntimeError, OSError, asyncio.TimeoutError):
                pass

        def revoke_on_loop():
            nonlocal replacement_notice
            if owner_task.done() or request.cancelled.is_set():
                return
            requested_stop.set()
            admission_cancelled.set()
            # The coordinator has already revoked this exact owner's commands.
            # Stop its track on its own event loop, without waiting for ADB join.
            track = getattr(request.stream, "webrtc_track", None)
            if track is not None:
                track.stop()
            if receiver is not None:
                receiver.cancel()
            if replacement_notice is None:
                replacement_notice = asyncio.create_task(send_replaced())
            owner_task.cancel()

        def schedule(callback):
            try:
                loop.call_soon_threadsafe(callback)
            except RuntimeError:
                pass  # this request's event loop has already shut down

        request = session_manager.begin_request(
            device_id, on_replaced=lambda: schedule(revoke_on_loop),
            on_changed=lambda: schedule(admission_changed.set),
        )

        async def watch_pending_start():
            nonlocal pending_client_left
            try:
                while True:
                    raw = await websocket.receive_text()
                    if raw == "stop" or len(raw) > 32768:
                        break
            except (WebSocketDisconnect, RuntimeError, OSError):
                pass
            pending_client_left = True
            request.cancelled.set()
            admission_cancelled.set()
            requested_stop.set()
            owner_task.cancel()

        # A page that closes/stops during device validation or old-owner
        # cleanup must not leave a request that starts after the page is gone.
        watchdog = asyncio.create_task(watch_pending_start(), name="live-pending-start")
        prepare = functools.partial(
            prepare_live_session, device_id,
            selected_serial=initial.get("selected_serial"), profile=profile,
            quality_settings=quality_settings, experiment=experiment,
            screen_off=screen_off, store=store, manager=manager,
            display_lab=display_lab, session_manager=session_manager,
            live_video=LiveVideo, selected_address=selected_address,
            is_connected=is_connected, cancelled=admission_cancelled, request=request,
        )
        takeover_deadline = None
        while True:
            admission_changed.clear()
            # Use an executor Future, not a separate to_thread Task: cancelling
            # all request Tasks must not discard a late resource reservation.
            admission = loop.run_in_executor(None, contextvars.copy_context().run, prepare)
            prepared, cancellation = await _owned_result(admission, admission_cancelled.set)
            stream = prepared.stream
            if cancellation is not None:
                raise cancellation  # finally cleans THIS unstarted reservation
            if prepared.superseded:
                request.replaced.set()
                replacement_notice = asyncio.create_task(send_replaced())
                return
            if prepared.error:
                await websocket.send_json({"type": "error", "message": prepared.error})
                return
            if not prepared.waiting:
                break
            if takeover_deadline is None:
                takeover_deadline = loop.time() + LIVE_TAKEOVER_TIMEOUT
                await asyncio.wait_for(websocket.send_json({
                    "type": "waiting", "reason": "takeover",
                    "message": "正在等待旧画面完成清理…",
                }), LIVE_WS_SEND_TIMEOUT)
            try:
                await asyncio.wait_for(admission_changed.wait(),
                                       max(0, takeover_deadline - loop.time()))
            except asyncio.TimeoutError:
                await asyncio.wait_for(websocket.send_json({
                    "type": "error", "code": "takeover_timeout",
                    "message": "旧会话资源尚未完全清理，请稍后重试",
                }), LIVE_WS_SEND_TIMEOUT)
                return
        if stream is None or requested_stop.is_set():
            return
        # Only one task may read the WebSocket. Retire the pending-start
        # watcher before starting normal SDP/control command handling.
        watchdog.cancel()
        await asyncio.gather(watchdog, return_exceptions=True)
        watchdog = None
        if not session_manager.is_latest_request(device_id, request):
            return
        serial = prepared.serial
        unlock_secret = prepared.unlock_secret
        adb_check_ms = prepared.adb_check_ms
        if VIDEO_ENGINE == "webrtc":
            # Media objects belong to the event loop; admission creates none.
            from ..m2_webrtc import ScrcpyH264Track
            stream.webrtc_track = ScrcpyH264Track(asyncio.get_running_loop())
        else:
            worker_launch_attempted = True
            try:
                stream.start()
            except (RuntimeError, OSError):
                await websocket.send_json({"type": "error", "message": "视频会话未能启动，请稍后重试"})
                return

        # Bound parallel SDP/ICE and scrcpy startup without a global device lock.
        if not resource_budget.acquire_start(device_id, stream.session_id):
            await websocket.send_json({
                "type": "error", "code": "start_budget_full",
                "session_id": stream.session_id,
                "message": "当前 WebRTC 启动并发已满，请稍后手动重试"
            })
            return
        budget_claimed = True
        session_manager.starting(device_id, stream)
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
            nonlocal manual_stop, last_browser_ack, pc, unlock_task, last_manual_unlock_at, worker_launch_attempted
            control_enabled = False
            last_move = 0.0
            last_input = 0.0
            try:
                while True:
                    raw = await websocket.receive_text()
                    if raw == "stop":
                        session_manager.stopping(device_id, stream, reason="manual")
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
                    current = await asyncio.to_thread(store.get, device_id)
                    if (not current or selected_address(current) != serial
                            or manager.serial_for(current) != serial or requested_stop.is_set()
                            or not session_manager.is_latest_request(device_id, request)):
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
                            if requested_stop.is_set() or not session_manager.is_latest_request(device_id, request):
                                break
                            answer = await asyncio.wait_for(pc.createAnswer(), timeout=12)
                            if requested_stop.is_set() or not session_manager.is_latest_request(device_id, request):
                                break
                            await asyncio.wait_for(pc.setLocalDescription(answer), timeout=15)
                            if requested_stop.is_set() or not session_manager.is_latest_request(device_id, request):
                                break
                            await asyncio.wait_for(websocket.send_json({
                                "type": "webrtc_answer", "session_id": stream.session_id,
                                "sdp": pc.localDescription.sdp
                            }), LIVE_WS_SEND_TIMEOUT)
                            if requested_stop.is_set() or not session_manager.is_latest_request(device_id, request):
                                break
                            worker_launch_attempted = True
                            try:
                                stream.start()
                            except (RuntimeError, OSError):
                                await websocket.send_json({
                                    "type": "error", "session_id": stream.session_id,
                                    "message": "视频会话未能启动，请稍后重试"
                                })
                                break
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
                            manual_secret = await asyncio.to_thread(store.get_unlock_secret, device_id)
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
                if VIDEO_ENGINE == "webrtc" and getattr(stream, "thread", None) is None and time.monotonic() - getattr(stream, "_born", time.monotonic()) > 25:
                    requested_stop.set()
                    await asyncio.to_thread(stream.stop)
                    return
                if time.monotonic() - last_browser_ack >= LIVE_HEARTBEAT_TIMEOUT:
                    requested_stop.set()
                    await asyncio.to_thread(stream.stop)
                    return

        receiver = asyncio.create_task(receive_commands())
        watchdog = asyncio.create_task(watch_browser())
        next_diagnostic = 0.0
        while True:
            # Stop takes priority over queued diagnostic/control events. The
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
                    **await asyncio.to_thread(stream.diagnostics),
                    "session_phase": (session_manager.snapshot(device_id, stream) or {}).get("phase"),
                    "start_budget": resource_budget.snapshot(),
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
            current = await asyncio.to_thread(store.get, device_id)
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
                if budget_claimed:
                    resource_budget.release_start(device_id, stream.session_id)
                    budget_claimed = False
                session_manager.running(device_id, stream)
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
            elif kind == "resize":
                # A scrcpy encoder session changed size inside this same live
                # owner. Preserve its peer, startup permit and one-time unlock.
                if (requested_stop.is_set()
                        or not session_manager.is_latest_request(device_id, request)):
                    break
                await asyncio.wait_for(websocket.send_json({
                    "type": "resize", "session_id": stream.session_id,
                    "width": payload["width"], "height": payload["height"],
                }), LIVE_WS_SEND_TIMEOUT)
            elif kind == "screen_power_notice":
                await asyncio.wait_for(websocket.send_json({
                    "type": "screen_power_notice", "session_id": stream.session_id, **payload
                }), LIVE_WS_SEND_TIMEOUT)
            elif kind == "lab_notice":
                display_lab._log(device_id, "虚拟屏幕结果", serial, payload.get("message", "无"))
                await asyncio.wait_for(websocket.send_json({
                    "type": "lab_notice", "session_id": stream.session_id, **payload
                }), LIVE_WS_SEND_TIMEOUT)
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
    except asyncio.CancelledError:
        if not pending_client_left and not (request is not None and request.replaced.is_set()):
            raise
    except (WebSocketDisconnect, RuntimeError, OSError, asyncio.TimeoutError):
        pass
    finally:
        # V2-04 admission: even a session without its first keyframe must free
        # the startup permit on stop/failure.  Resource quota != dirty slot.
        if budget_claimed and stream is not None:
            resource_budget.release_start(device_id, stream.session_id)
            budget_claimed = False
        if stream:
            session_manager.cleaning(device_id, stream)
        cleanup = asyncio.create_task(cleanup_live_session(
            device_id=device_id, stream=stream, pc=pc,
            registry=live_registry, close_peer=_close_webrtc_peer,
            requested_stop=requested_stop, watchdog=watchdog,
            receiver=receiver, unlock_task=unlock_task,
            worker_launch_attempted=worker_launch_attempted,
            on_late_worker=lambda: session_manager.late_cleanup(device_id, stream),
        ))
        # A repeated request cancellation cannot abandon stop/join or discard
        # their proof before SessionManager records the final resource state.
        cleanup_cancellation = None
        try:
            try:
                report, cleanup_cancellation = await _owned_result(cleanup)
            except asyncio.CancelledError:
                # A shutdown may directly cancel the cleanup Task itself. With
                # no report, retain this owner as DIRTY, never infer success.
                if stream:
                    session_manager.complete(device_id, stream, clean=False,
                        reason="资源清理任务被取消，清理尚未确认")
                raise
            if stream:
                replaced = request is not None and request.replaced.is_set()
                if report.cleaned:
                    # Only verified cleanup may release this exact stream.
                    session_manager.complete(device_id, stream, clean=True)
                    if manual_stop and not replaced:
                        try:
                            await asyncio.wait_for(websocket.send_json({
                                "type": "ended", "session_id": stream.session_id,
                                "reason": "manual", "cleanup_complete": True
                            }), LIVE_WS_SEND_TIMEOUT)
                        except (WebSocketDisconnect, RuntimeError, OSError, asyncio.TimeoutError):
                            pass
                else:
                    session_manager.complete(device_id, stream, clean=False,
                        reason=report.reason)
                    # A takeover notice never claims that cleanup succeeded.
                    # The new page remains waiting on the old DIRTY owner.
                    if not replaced:
                        try:
                            await asyncio.wait_for(websocket.send_json({
                                "type": "error",
                                "message": "视频会话尚未完全清理，设备会话保持占用；不会同时启动第二路视频"
                            }), LIVE_WS_SEND_TIMEOUT)
                        except (WebSocketDisconnect, RuntimeError, OSError, asyncio.TimeoutError):
                            pass
        finally:
            try:
                if replacement_notice is not None:
                    _, notice_cancellation = await _owned_result(replacement_notice)
                    cleanup_cancellation = cleanup_cancellation or notice_cancellation
            finally:
                if request is not None:
                    session_manager.finish_request(device_id, request)
            # Retire callbacks before awaiting close; a captured late revoke
            # must not cancel or message an already finalized request.
            try:
                await asyncio.wait_for(websocket.close(), LIVE_WS_SEND_TIMEOUT)
            except (RuntimeError, OSError, asyncio.TimeoutError):
                pass
        if (cleanup_cancellation is not None and not pending_client_left
                and not (request is not None and request.replaced.is_set())):
            raise cleanup_cancellation

