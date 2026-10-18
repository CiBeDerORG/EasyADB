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
        profile = initial.get("profile")
        if profile not in ("baseline", "native"):
            await websocket.send_json({"type": "error", "message": "视频档位无效"})
            return
        device = store.get(device_id)
        serial = selected_address(device) if device else None
        if not serial or serial != initial.get("selected_serial") or manager.serial_for(device) != serial:
            await websocket.send_json({"type": "error", "message": "请先手动连接当前选择的设备"})
            return
        if not await asyncio.to_thread(is_connected, serial):
            await websocket.send_json({"type": "error", "message": "当前选择的 ADB 地址已离线"})
            return
        # Atomic with route mutation: another browser cannot switch the
        # selected serial between validation and reserving this live session.
        error = None
        with manager._device_lock(device_id):
            current = store.get(device_id)
            if not current or selected_address(current) != serial or manager.serial_for(current) != serial:
                error = "当前选择的 IP 已改变，请重新开启投屏"
            else:
                candidate = LiveVideo(serial, profile=profile)
                if not live_registry.reserve(device_id, candidate):
                    error = "这台设备已有实时投屏会话，请先停止原会话"
                else:
                    stream = candidate
                    stream.start()
        if error:
            await websocket.send_json({"type": "error", "message": error})
            return
        await websocket.send_json({"type": "starting", "selected_serial": serial})

        async def receive_commands():
            try:
                while True:
                    message = await websocket.receive_text()
                    if message == "stop":
                        break
                    # Intentionally ignore ALL control/input messages in M2-00-E.
            except (WebSocketDisconnect, RuntimeError):
                pass
            finally:
                stream.stop()

        receiver = asyncio.create_task(receive_commands())
        while True:
            if stream.finished.is_set() and stream.events.empty():
                break
            current = store.get(device_id)
            if not current or selected_address(current) != serial or manager.serial_for(current) != serial:
                await websocket.send_json({"type": "error", "message": "设备连接地址已变更，投屏已停止"})
                break
            try:
                kind, payload = await asyncio.to_thread(stream.events.get, True, 0.35)
            except queue.Empty:
                continue
            if kind == "init":
                await websocket.send_json({"type": "init", **payload})
            elif kind == "bytes":
                await websocket.send_bytes(payload)
            elif kind == "error":
                await websocket.send_json({"type": "error", "message": payload})
                break
            elif kind == "end":
                break
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        if stream:
            stream.stop()
            if receiver:
                receiver.cancel()
                await asyncio.gather(receiver, return_exceptions=True)
            await asyncio.to_thread(stream.join, 8)
            live_registry.release(device_id, stream)
        try:
            await websocket.close()
        except RuntimeError:
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
