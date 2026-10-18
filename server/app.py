"""EasyADB: persistent multi-device wireless ADB connection management."""
import asyncio
import ipaddress
import json
import queue
from urllib.parse import urlsplit
import os
import re
import secrets
import sqlite3
import subprocess
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from .devices import DeviceManager, selected_address
from .store import DeviceStore
from .m2_preflight import inspect_device
from .m2_video_probe import probe_video, VideoProbeError
from .m2_live import LiveRegistry, LiveVideo
from .m2_quality import resolve_live_quality
from .m2_touch import InvalidTouch

TOKEN = os.getenv("EASYADB_TOKEN", "").strip()
if len(TOKEN) < 12 or TOKEN == "REPLACE_WITH_RANDOM_LONG_TOKEN":
    raise RuntimeError("Set EASYADB_TOKEN to a unique token of at least 12 characters")

ROOT = Path(__file__).resolve().parents[1]
DB_PATH = os.getenv("EASYADB_DB", str(ROOT / "data" / "devices.sqlite3"))
store = DeviceStore(DB_PATH)


def adb(*args, timeout=15, input_text=None):
    try:
        return subprocess.run(["adb", *args], input=input_text, capture_output=True,
                              text=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "ADB 操作超时，请检查设备网络和调试状态") from None
    except FileNotFoundError:
        raise HTTPException(503, "服务器未安装 ADB") from None


manager = DeviceManager(store, adb)
live_registry = LiveRegistry()

# Only active, user-started WebSocket sessions have a watchdog. The client
# acknowledges existing diagnostic events rather than running a hidden timer.
LIVE_HEARTBEAT_TIMEOUT = 45.0
LIVE_HEARTBEAT_CHECK_INTERVAL = 2.0
LIVE_WS_SEND_TIMEOUT = 10.0


@asynccontextmanager
async def lifespan(_app):
    store.initialize()
    try:
        yield
    finally:
        await asyncio.to_thread(live_registry.stop_all)


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

# Retain the first MVP endpoints for compatibility; M1 routes always use device IDs.
_legacy_serial = None
_legacy_lock = threading.Lock()


class Target(BaseModel):
    ip: str
    port: int


class PairTarget(Target):
    code: str


class PairExisting(BaseModel):
    port: int
    code: str
    selected_serial: str


class DeviceInput(Target):
    name: str
    group_name: str = ""



class RouteInput(BaseModel):
    route: str


class VideoProbeInput(BaseModel):
    profile: Literal['baseline', 'native'] = 'baseline'


class GroupInput(BaseModel):
    name: str
    ip_prefix: str | None = None


def clean_group(payload):
    name = payload.name.strip()
    if not 1 <= len(name) <= 64 or name == "未分组":
        raise HTTPException(400, "分组名称须为 1–64 字符，且不能使用保留名称「未分组」")
    prefix = (payload.ip_prefix or "").strip() or None
    if prefix:
        match = re.fullmatch(r"([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})\.\*", prefix)
        if not match:
            raise HTTPException(400, "IP 前缀格式应为 192.168.10.*")
        try:
            canonical = ipaddress.IPv4Address(match.group(1) + ".1")
        except ipaddress.AddressValueError:
            raise HTTPException(400, "IP 前缀包含无效的 IPv4 网段") from None
        prefix = str(canonical).rsplit(".", 1)[0] + ".*"
    return name, prefix


def authorize(x_easyadb_token: str | None = Header(default=None)):
    if not x_easyadb_token or not secrets.compare_digest(x_easyadb_token, TOKEN):
        raise HTTPException(401, "访问密钥不正确")


def address(ip, port):
    try:
        parsed = ipaddress.IPv4Address(ip.strip())
    except ipaddress.AddressValueError:
        raise HTTPException(400, "目前仅支持有效的 IPv4 地址") from None
    if not 1 <= port <= 65535:
        raise HTTPException(400, "端口必须在 1 到 65535 之间")
    return f"{parsed}:{port}"


def clean_input(payload):
    serial = address(payload.ip, payload.port)
    name = payload.name.strip()
    group = payload.group_name.strip()
    if not 1 <= len(name) <= 64:
        raise HTTPException(400, "设备名称长度必须为 1–64 字符")
    if len(group) > 64:
        raise HTTPException(400, "分组名称不能超过 64 字符")
    return {
        "name": name, "group_name": group,
        "ip": serial.rsplit(":", 1)[0], "port": payload.port,
    }


def get_device(device_id):
    device = store.get(device_id)
    if not device:
        raise HTTPException(404, "找不到该设备")
    return device


def is_connected(serial):
    result = adb("-s", serial, "get-state", timeout=6)
    return result.returncode == 0 and result.stdout.strip() == "device"


def capture(serial):
    try:
        result = subprocess.run(["adb", "-s", serial, "exec-out", "screencap", "-p"],
                                capture_output=True, timeout=20, check=False)
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "截图超时") from None
    except FileNotFoundError:
        raise HTTPException(503, "服务器未安装 ADB") from None
    if result.returncode != 0 or not result.stdout.startswith(b"\x89PNG\r\n\x1a\n"):
        raise HTTPException(502, "截图失败，请检查手机屏幕或 ADB 连接")
    return Response(result.stdout, media_type="image/png",
                    headers={"Cache-Control": "no-store"})


@app.get("/")
def home():
    return FileResponse(ROOT / "web" / "index.html", headers={"Cache-Control": "no-store"})


@app.get("/m2-player.js")
def m2_player_script():
    return FileResponse(ROOT / "web" / "m2-player.js", media_type="application/javascript",
                        headers={"Cache-Control": "no-store"})


@app.get("/m2-traffic.js")
def m2_traffic_script():
    return FileResponse(ROOT / "web" / "m2-traffic.js", media_type="application/javascript",
                        headers={"Cache-Control": "no-store"})


@app.get("/m2-touch.js")
def m2_touch_script():
    return FileResponse(ROOT / "web" / "m2-touch.js", media_type="application/javascript",
                        headers={"Cache-Control": "no-store"})


@app.get("/m2-metrics.js")
def m2_metrics_script():
    return FileResponse(ROOT / "web" / "m2-metrics.js", media_type="application/javascript",
                        headers={"Cache-Control": "no-store"})


@app.get("/m2-multi.js")
def m2_multi_script():
    return FileResponse(ROOT / "web" / "m2-multi.js", media_type="application/javascript",
                        headers={"Cache-Control": "no-store"})


def pair_at(ip, port, code):
    dest = address(ip, port)
    if not re.fullmatch(r"\d{6}", code):
        raise HTTPException(400, "配对码应为手机显示的 6 位数字")
    result = adb("pair", dest, timeout=20, input_text=code + "\n")
    if result.returncode != 0 or "Successfully paired" not in result.stdout:
        raise HTTPException(502, "ADB 配对失败，请检查配对端口、配对码和网络")
    return {"message": "配对成功，请使用无线调试主页的连接端口继续连接"}


@app.post("/api/pair", dependencies=[Depends(authorize)])
def pair(target: PairTarget):
    # Original first-time pairing from the add-device form remains compatible.
    return pair_at(target.ip, target.port, target.code)


@app.post("/api/devices/{device_id}/pair", dependencies=[Depends(authorize)])
def pair_existing_device(device_id: str, target: PairExisting):
    # Bind pairing to the database-selected route: do not accept a client-side
    # IP override or switch routes, and NEVER connect automatically after pair.
    with manager._device_lock(device_id):
        device = get_device(device_id)
        serial = selected_address(device)
        if not serial:
            raise HTTPException(409, "当前连接地址不可用，请先选择有效的 IP")
        if target.selected_serial != serial:
            raise HTTPException(409, "所选连接地址已发生变化，请重新加载设备后再配对")
        ip = serial.rsplit(":", 1)[0]
        result = pair_at(ip, target.port, target.code)
        return {**result, "paired_ip": ip, "selected_route": device["selected_route"]}


@app.get("/api/devices", dependencies=[Depends(authorize)])
def list_devices():
    return [manager.snapshot(d) for d in store.list()]


@app.get("/api/groups", dependencies=[Depends(authorize)])
def list_groups():
    return store.list_groups()


@app.post("/api/groups", status_code=201, dependencies=[Depends(authorize)])
def create_group(payload: GroupInput):
    name, prefix = clean_group(payload)
    try:
        return store.create_group(name, prefix)
    except sqlite3.IntegrityError:
        raise HTTPException(409, "分组名称已存在") from None
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from None


@app.put("/api/groups/{group_name}", dependencies=[Depends(authorize)])
def update_group(group_name: str, payload: GroupInput):
    name, prefix = clean_group(payload)
    old_members = [d["id"] for d in store.list() if d["group_name"] == group_name]
    try:
        result = store.update_group(group_name, name, prefix)
    except sqlite3.IntegrityError:
        raise HTTPException(409, "分组名称已存在") from None
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from None
    if result is None:
        raise HTTPException(404, "找不到该分组")
    for device_id in old_members:
        live_registry.stop_for(device_id)
        manager.clear(device_id)
    return result


@app.delete("/api/groups/{group_name}", dependencies=[Depends(authorize)])
def delete_group(group_name: str):
    # Clear the cached route after the DB transaction has safely moved all
    # members to the ungrouped category; never disconnect or delete a device.
    result = store.delete_group(group_name)
    if result is None:
        raise HTTPException(404, "找不到该分组")
    for device_id in result["device_ids"]:
        live_registry.stop_for(device_id)
        manager.clear(device_id)
    return {"deleted": True, "moved_count": result["moved_count"]}



@app.post("/api/devices", status_code=201, dependencies=[Depends(authorize)])
def create_device(payload: DeviceInput):
    data = clean_input(payload)
    try:
        device = store.create(data)
    except sqlite3.IntegrityError:
        raise HTTPException(409, "该组网 IP 和端口已经存在于设备列表") from None
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from None
    return manager.snapshot(device)


@app.post("/api/devices/refresh", dependencies=[Depends(authorize)])
def refresh_devices():
    return manager.poll_all()


@app.put("/api/devices/{device_id}", dependencies=[Depends(authorize)])
def update_device(device_id: str, payload: DeviceInput):
    original = get_device(device_id)
    data = clean_input(payload)
    try:
        updated = store.update(device_id, data)
    except sqlite3.IntegrityError:
        raise HTTPException(409, "该组网 IP 和端口已经存在于设备列表") from None
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from None
    if not updated:
        raise HTTPException(404, "找不到该设备")
    if (original["ip"], original["port"], original["group_name"], original["lan_ip"], original["selected_route"]) != (updated["ip"], updated["port"], updated["group_name"], updated["lan_ip"], updated["selected_route"]):
        live_registry.stop_for(device_id)
        manager.clear(device_id)
    return manager.snapshot(updated)


@app.delete("/api/devices/{device_id}", dependencies=[Depends(authorize)])
def delete_device(device_id: str):
    get_device(device_id)
    if not store.delete(device_id):
        raise HTTPException(404, "找不到该设备")
    live_registry.stop_for(device_id)
    manager.clear(device_id)
    # Deliberately don't adb disconnect: other clients may be using the target.
    return {"deleted": True}


@app.put("/api/devices/{device_id}/route", dependencies=[Depends(authorize)])
def select_device_route(device_id: str, payload: RouteInput):
    # Use the same lock as connect, refresh and screenshot. Switching changes
    # persisted preference only; no hidden adb connect or automatic fallback.
    with manager._device_lock(device_id):
        if payload.route not in ("mesh", "lan"):
            raise HTTPException(400, "请选择组网 IP 或内网 IP")
        try:
            result = store.select_route(device_id, payload.route)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from None
        if not result:
            raise HTTPException(404, "找不到该设备")
        live_registry.stop_for(device_id)
        manager.clear(device_id)
        return manager.snapshot(result)


@app.post("/api/devices/{device_id}/connect", dependencies=[Depends(authorize)])
def connect_device(device_id: str):
    get_device(device_id)
    result = manager.probe(device_id, force_connect=True)
    if result is None:
        raise HTTPException(404, "找不到该设备")
    if result["status"] != "connected":
        raise HTTPException(502, result["last_error"] or "ADB 连接失败")
    return result


@app.post("/api/devices/{device_id}/refresh", dependencies=[Depends(authorize)])
def refresh_device(device_id: str):
    get_device(device_id)
    result = manager.probe(device_id)
    if result is None:
        raise HTTPException(404, "找不到该设备")
    return result


@app.post("/api/devices/{device_id}/m2/preflight", dependencies=[Depends(authorize)])
def m2_device_preflight(device_id: str):
    """User-initiated M2-00 capability check; no connect or scrcpy process."""
    with manager._device_lock(device_id):
        device = get_device(device_id)
        serial = selected_address(device)
        if not serial or manager.serial_for(device) != serial or not is_connected(serial):
            raise HTTPException(409, "请先手动连接当前选择的设备，再执行 M2 预检")
        return inspect_device(serial, adb)


@app.post("/api/devices/{device_id}/m2/video-probe", dependencies=[Depends(authorize)])
def m2_video_probe(device_id: str, payload: VideoProbeInput):
    """Opt-in, bounded, non-recording experiment: phone encoder -> FNOS only."""
    with manager._device_lock(device_id):
        device = get_device(device_id)
        serial = selected_address(device)
        if not serial or manager.serial_for(device) != serial or not is_connected(serial):
            raise HTTPException(409, "请先手动连接当前选择的地址，再启动视频链路实验")
        try:
            return probe_video(serial, profile=payload.profile)
        except VideoProbeError as exc:
            raise HTTPException(502, str(exc)) from None


async def confirm_live_adb_loss(device_id: str, serial: str) -> bool:
    """One event-triggered check after a running stream fails, NEVER polling.

    A scrcpy video/control EOF alone does not prove ADB is offline (the
    Android encoder or scrcpy process may also fail). Change M1's cached
    device status only after get-state confirms the selected serial is gone.
    Recheck the route under its device lock so stale sessions cannot mark a
    newly chosen IP disconnected.
    """
    try:
        still_online = await asyncio.to_thread(is_connected, serial)
    except (HTTPException, OSError):
        return False  # unknown is NOT a confirmed offline device
    if still_online:
        return False
    with manager._device_lock(device_id):
        current = store.get(device_id)
        if (current and selected_address(current) == serial
                and manager.serial_for(current) == serial):
            manager._set_state(device_id, "disconnected",
                               "当前 ADB 地址已断开；请手动检查连接并重新连接")
    return True


@app.websocket("/api/devices/{device_id}/m2/live")
async def m2_live_video(websocket: WebSocket, device_id: str):
    """Same-origin, explicitly authenticated WebSocket. Token in FIRST MESSAGE,
    not URL/query string/handshake; no ambient cookie-based device access.
    """
    origin = websocket.headers.get("origin", "")
    host = websocket.headers.get("host", "")
    origin_url = urlsplit(origin)
    if not host or not origin or origin_url.scheme not in ("http", "https") or origin_url.netloc != host:
        await websocket.close(code=1008, reason="来源地址不匹配")
        return
    await websocket.accept()
    stream = None
    receiver = None
    watchdog = None
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
        # Reserve a future raw H264/WebCodecs path without advertising a
        # nonfunctional decoder or passing fMP4 bytes into VideoDecoder.
        if initial.get("player", "mse") != "mse":
            await websocket.send_json({"type": "error", "message": "WebCodecs 尚未实现；当前只支持 MSE。"})
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
        # Atomic with route mutation: another browser cannot switch the
        # selected serial between validation and reserving this live session.
        error = None
        with manager._device_lock(device_id):
            current = store.get(device_id)
            if not current or selected_address(current) != serial or manager.serial_for(current) != serial:
                error = "当前选择的 IP 已改变，请重新开启投屏"
            else:
                # Keep the original two-argument constructor path for legacy
                # presets, while custom parameters are explicit and validated.
                candidate = (LiveVideo(serial, profile=profile, quality=quality_settings)
                             if profile == "custom" else LiveVideo(serial, profile=profile))
                if not live_registry.reserve(device_id, candidate):
                    error = "这台设备已有实时投屏会话，请先停止原会话"
                else:
                    stream = candidate
                    try:
                        stream.start()
                    except (RuntimeError, OSError):
                        # An unstarted candidate must not pin the device slot.
                        live_registry.release(device_id, candidate)
                        stream = None
                        error = "视频会话未能启动，请稍后重试"
        if error:
            await websocket.send_json({"type": "error", "message": error})
            return
        await asyncio.wait_for(websocket.send_json({
            "type": "starting", "session_id": stream.session_id,
            "selected_serial": serial, "adb_check_ms": adb_check_ms
        }), LIVE_WS_SEND_TIMEOUT)

        last_browser_ack = time.monotonic()

        async def receive_commands():
            nonlocal manual_stop, last_browser_ack
            control_enabled = False
            last_move = 0.0
            last_input = 0.0
            try:
                while True:
                    raw = await websocket.receive_text()
                    if raw == "stop":
                        manual_stop = True
                        break
                    if len(raw) > 1024:
                        break  # fail closed for oversized/unrecognized control traffic
                    try:
                        message = json.loads(raw)
                    except ValueError:
                        continue
                    if not isinstance(message, dict) or message.get("type") not in (
                        "control_enable", "control_disable", "touch", "input_text", "nav_key",
                        "heartbeat"
                    ):
                        continue  # NEVER interpret arbitrary device/ADB commands
                    if message.get("session_id") != stream.session_id:
                        break  # old or cross-session control attempt: terminate THIS WS
                    current = store.get(device_id)
                    if (not current or selected_address(current) != serial
                            or manager.serial_for(current) != serial or requested_stop.is_set()):
                        break  # no implicit connect, IP fallback or stale-target injection
                    kind = message["type"]
                    if kind == "heartbeat":
                        # Diagnostic receipt proof for THIS session, not a
                        # phone keepalive. Malformed/stale heartbeat fails closed.
                        if set(message) != {"type", "session_id"}:
                            break
                        last_browser_ack = time.monotonic()
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
                    "ws_video_chunks": ws_video_chunks
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
                await asyncio.wait_for(websocket.send_json({
                    "type": "init", "session_id": stream.session_id,
                    "player": "mse", "format": "fmp4",
                    "requested": quality_settings, **payload
                }), LIVE_WS_SEND_TIMEOUT)
                if payload.get("control_available"):
                    touch_ready.set()
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
        if watchdog:
            watchdog.cancel()
            await asyncio.gather(watchdog, return_exceptions=True)
        if stream:
            await asyncio.to_thread(stream.stop)
            if receiver:
                receiver.cancel()
                await asyncio.gather(receiver, return_exceptions=True)
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


@app.get("/api/devices/{device_id}/screenshot", dependencies=[Depends(authorize)])
def device_screenshot(device_id: str):
    with manager._device_lock(device_id):
        device = get_device(device_id)
        serial = manager.serial_for(device)
        if not serial or not is_connected(serial):
            manager._set_state(device_id, "disconnected", "当前 ADB 地址已断开")
            raise HTTPException(409, "设备未连接，请重新连接后再截图")
        return capture(serial)


# Backward-compatible MVP routes (not used by the M1 page).
@app.post("/api/connect", dependencies=[Depends(authorize)])
def connect(target: Target):
    global _legacy_serial
    serial = address(target.ip, target.port)
    result = adb("connect", serial, timeout=18)
    if result.returncode != 0 or not is_connected(serial):
        raise HTTPException(502, "ADB 连接失败，请确认已配对、端口可达且无线调试已开启")
    with _legacy_lock:
        _legacy_serial = serial
    return {"connected": True, "serial": serial, "message": "连接成功"}


@app.get("/api/status", dependencies=[Depends(authorize)])
def status():
    with _legacy_lock:
        serial = _legacy_serial
    if not serial or not is_connected(serial):
        return {"connected": False, "serial": serial, "model": None}
    model = adb("-s", serial, "shell", "getprop", "ro.product.model", timeout=6)
    return {"connected": True, "serial": serial,
            "model": model.stdout.strip() if model.returncode == 0 else None}


@app.get("/api/screenshot", dependencies=[Depends(authorize)])
def screenshot():
    with _legacy_lock:
        serial = _legacy_serial
    if not serial or not is_connected(serial):
        raise HTTPException(409, "设备未连接")
    return capture(serial)
