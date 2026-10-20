"""EasyADB: persistent multi-device wireless ADB connection management."""
import asyncio
import ipaddress
import json
import logging
import queue
from urllib.parse import urlsplit
import os
import re
import secrets
import sys
import sqlite3
import subprocess
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import Response
from pydantic import BaseModel

from .devices import DeviceManager, selected_address
from .store import DeviceStore
from .openwrt_discovery import RpcdDiscovery, DiscoveryError, validate_url
from .m2_preflight import inspect_device
from .m2_video_probe import probe_video, VideoProbeError
from .m2_live import LiveRegistry, LiveVideo
from .m2_quality import resolve_live_quality, EXPERIMENTAL_RESOLUTIONS, VIRTUAL_DPI_CHOICES
from .m2_touch import InvalidTouch
from .m2_unlock import validate_password, automatic_unlock
from .display_lab import DisplayLab, LabError
from .castplus_lab import CastError
from .core.config import load_settings
from .core.runtime import build_runtime
from .core.lifecycle import managed_resources
from .core.exceptions import DomainError
from .services.group_discovery import run_group_scan
from .services.device_service import create_device_record, update_device_record, delete_device_record
from .services.group_service import (create_group_record, update_group_record, delete_group_record,
                             configure_group_discovery_record, clear_group_discovery_record)
from .api.static import router as static_router
from .api.schemas import (Target, PairTarget, PairExisting, DeviceInput, RouteInput, TempAddressInput,
                          UnlockInput, VideoProbeInput, GroupInput, GroupDiscoveryInput)
from .api.validation import clean_group, address, clean_input
from .api import groups as group_routes, devices as device_routes, lab as lab_routes, live as live_routes, legacy as legacy_routes
from .api.live_handler import handle_live_video
from .api import lab_handlers
from .services.operations import device_lock, device_locks, membership_lock, group_operation, GroupBusy

# Module-level aliases remain during incremental migration: existing tests and
# integrations replace app.store/manager/live_registry directly.
settings = load_settings()
VIDEO_ENGINE = settings.video_engine
TOKEN = settings.token
ROOT = settings.root
DB_PATH = settings.db_path
_discovery_guard = threading.RLock()
_discovery_locks = {}


def adb(*args, timeout=15, input_text=None):
    try:
        return subprocess.run(["adb", *args], input=input_text, capture_output=True,
                              text=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "ADB 操作超时，请检查设备网络和调试状态") from None
    except FileNotFoundError:
        raise HTTPException(503, "服务器未安装 ADB") from None


runtime = build_runtime(DB_PATH, adb)
store = runtime.store
discovery_client = runtime.discovery_client
manager = runtime.manager
live_registry = runtime.live_registry
display_lab = runtime.display_lab

# Only active, user-started WebSocket sessions have a watchdog. The client
# acknowledges existing diagnostic events rather than running a hidden timer.
LIVE_HEARTBEAT_TIMEOUT = 45.0
LIVE_HEARTBEAT_CHECK_INTERVAL = 2.0
LIVE_WS_SEND_TIMEOUT = 10.0


@asynccontextmanager
async def lifespan(_app):
    # Resolve aliases at startup to preserve existing test substitutions.
    async with managed_resources(lambda: (store, live_registry)):
        yield


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
app.include_router(static_router)

# Retain the first MVP endpoints for compatibility; M1 routes always use device IDs.
_legacy_serial = None
_legacy_lock = threading.Lock()


def authorize(x_easyadb_token: str | None = Header(default=None)):
    if not x_easyadb_token or not secrets.compare_digest(x_easyadb_token, TOKEN):
        raise HTTPException(401, "访问密钥不正确")


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


def pair_at(ip, port, code):
    dest = address(ip, port)
    if not re.fullmatch(r"\d{6}", code):
        raise HTTPException(400, "配对码应为手机显示的 6 位数字")
    result = adb("pair", dest, timeout=20, input_text=code + "\n")
    if result.returncode != 0 or "Successfully paired" not in result.stdout:
        raise HTTPException(502, "ADB 配对失败，请检查配对端口、配对码和网络")
    return {"message": "配对成功，请使用无线调试主页的连接端口继续连接"}


def pair(target: PairTarget):
    # Original first-time pairing from the add-device form remains compatible.
    return pair_at(target.ip, target.port, target.code)


def pair_existing_device(device_id: str, target: PairExisting):
    # Bind pairing to the database-selected route: do not accept a client-side
    # IP override or switch routes, and NEVER connect automatically after pair.
    with device_lock(manager, device_id):
        device = get_device(device_id)
        serial = selected_address(device)
        if not serial:
            raise HTTPException(409, "当前连接地址不可用，请先选择有效的 IP")
        if target.selected_serial != serial:
            raise HTTPException(409, "所选连接地址已发生变化，请重新加载设备后再配对")
        ip = serial.rsplit(":", 1)[0]
        result = pair_at(ip, target.port, target.code)
        return {**result, "paired_ip": ip, "selected_route": device["selected_route"]}


def list_devices():
    return [manager.snapshot(d) for d in store.list()]


def list_groups():
    return store.list_groups()


def create_group(payload: GroupInput):
    try:
        name, prefix = clean_group(payload)
        return create_group_record(name, prefix, store=store)
    except DomainError as exc:
        raise HTTPException(exc.status_code, exc.detail) from None

def update_group(group_name: str, payload: GroupInput):
    try:
        return update_group_record(
            group_name, lambda: clean_group(payload), store=store, manager=manager,
            display_lab=display_lab, live_registry=live_registry,
            discovery_guard=_discovery_guard, discovery_locks=_discovery_locks,
        )
    except DomainError as exc:
        raise HTTPException(exc.status_code, exc.detail) from None

def configure_group_discovery(group_name: str, payload: GroupDiscoveryInput):
    """Only authenticated admins may update OpenWrt credentials."""
    try:
        return configure_group_discovery_record(
            group_name, payload.url, payload.username, payload.password,
            store=store, discovery_guard=_discovery_guard, discovery_locks=_discovery_locks,
        )
    except DomainError as exc:
        raise HTTPException(exc.status_code, exc.detail) from None

def clear_group_discovery(group_name: str):
    try:
        return clear_group_discovery_record(
            group_name, store=store, discovery_guard=_discovery_guard,
            discovery_locks=_discovery_locks,
        )
    except DomainError as exc:
        raise HTTPException(exc.status_code, exc.detail) from None

def _group_scan(group_name, *, persist, test_config: GroupDiscoveryInput | None = None):
    """Transport adapter: API error mapping, runtime dependencies from current app."""
    try:
        return run_group_scan(
            group_name, persist=persist, test_config=test_config, store=store,
            discovery_client=discovery_client, manager=manager,
            display_lab=display_lab, live_registry=live_registry,
            discovery_guard=_discovery_guard, discovery_locks=_discovery_locks,
        )
    except DomainError as exc:
        raise HTTPException(exc.status_code, exc.detail) from None

def test_group_discovery(group_name: str, payload: GroupDiscoveryInput | None = None):
    """Test unsaved form values first; an empty body preserves the existing API."""
    return _group_scan(group_name, persist=False, test_config=payload)


def scan_group_discovery(group_name: str):
    """Only a user click issues a remote scan; never connect ADB here."""
    return _group_scan(group_name, persist=True)


def group_discovery_last(group_name: str):
    if store.get_group(group_name) is None:
        raise HTTPException(404, "找不到该分组")
    return {"last": store.last_group_discovery(group_name)}


def delete_group(group_name: str):
    try:
        return delete_group_record(
            group_name, store=store, manager=manager, display_lab=display_lab,
            live_registry=live_registry, discovery_guard=_discovery_guard,
            discovery_locks=_discovery_locks,
        )
    except DomainError as exc:
        raise HTTPException(exc.status_code, exc.detail) from None

def create_device(payload: DeviceInput):
    try:
        return create_device_record(clean_input(payload), store=store, manager=manager)
    except DomainError as exc:
        raise HTTPException(exc.status_code, exc.detail) from None

def refresh_devices():
    return manager.poll_all()


def update_device(device_id: str, payload: DeviceInput):
    try:
        return update_device_record(
            device_id, lambda: clean_input(payload), store=store, manager=manager,
            display_lab=display_lab, live_registry=live_registry,
        )
    except DomainError as exc:
        raise HTTPException(exc.status_code, exc.detail) from None

def unlock_state(device_id: str):
    get_device(device_id)
    return {"configured": store.unlock_configured(device_id)}


def set_unlock_state(device_id: str, payload: UnlockInput):
    with device_lock(manager, device_id):
        get_device(device_id)
        if payload.password is None:
            return {"configured": store.unlock_configured(device_id)}
        if payload.password == "":
            store.clear_unlock_secret(device_id)
            return {"configured": False}
        try:
            validate_password(payload.password)
            store.save_unlock_secret(device_id, payload.password)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from None
        return {"configured": True}


def delete_device(device_id: str):
    try:
        return delete_device_record(
            device_id, store=store, manager=manager,
            display_lab=display_lab, live_registry=live_registry,
        )
    except DomainError as exc:
        raise HTTPException(exc.status_code, exc.detail) from None

def set_device_temp_address(device_id: str, payload: TempAddressInput):
    # Persist only; editing/removing the selected route invalidates cached ADB.
    # Reject while a server-side live slot is owned (including cleanup).
    with device_lock(manager, device_id):
        if display_lab.has_pending(device_id):
            raise HTTPException(409, "请先恢复该设备的副屏实验，再修改线路")
        original = get_device(device_id)
        with live_registry.lock:
            session = live_registry.sessions.get(device_id)
            if session is not None and not live_registry.is_cleaned(session):
                raise HTTPException(409, "该设备正在投屏或清理，请结束后修改临时地址")
        if payload.ip is None:
            if payload.port is not None:
                raise HTTPException(400, "移除临时 IP 时不可单独修改共用端口")
            ip, port = None, original["port"]
        else:
            # Omitted port retains the current shared value (existing API clients).
            # An explicitly supplied port changes mesh/LAN/temp together.
            port = original["port"] if payload.port is None else payload.port
            serial = address(payload.ip, port)
            ip = serial.rsplit(":", 1)[0]
        try:
            result = store.set_temp_address(device_id, ip, port)
        except sqlite3.IntegrityError:
            raise HTTPException(409, "共用 ADB 地址已存在") from None
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from None
        if result is None:
            raise HTTPException(404, "找不到该设备")
        if selected_address(original) != selected_address(result):
            manager.clear(device_id)
        return manager.snapshot(result)


def select_device_route(device_id: str, payload: RouteInput):
    # Use the same lock as connect, refresh and screenshot. Switching changes
    # persisted preference only; no hidden adb connect or automatic fallback.
    with device_lock(manager, device_id):
        if display_lab.has_pending(device_id):
            raise HTTPException(409, "请先恢复该设备的副屏实验，再切换线路")
        if payload.route not in ("mesh", "lan", "temp"):
            raise HTTPException(400, "请选择组网 IP、内网 IP 或临时 IP")
        try:
            result = store.select_route(device_id, payload.route)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from None
        if not result:
            raise HTTPException(404, "找不到该设备")
        live_registry.stop_for(device_id)
        manager.clear(device_id)
        return manager.snapshot(result)


def connect_device(device_id: str):
    get_device(device_id)
    result = manager.probe(device_id, force_connect=True)
    if result is None:
        raise HTTPException(404, "找不到该设备")
    if result["status"] != "connected":
        raise HTTPException(502, result["last_error"] or "ADB 连接失败")
    return result


def refresh_device(device_id: str):
    get_device(device_id)
    result = manager.probe(device_id)
    if result is None:
        raise HTTPException(404, "找不到该设备")
    return result


def m2_device_preflight(device_id: str):
    """User-initiated M2-00 capability check; no connect or scrcpy process."""
    with device_lock(manager, device_id):
        device = get_device(device_id)
        serial = selected_address(device)
        if not serial or manager.serial_for(device) != serial or not is_connected(serial):
            raise HTTPException(409, "请先手动连接当前选择的设备，再执行 M2 预检")
        return inspect_device(serial, adb)


def m2_video_probe(device_id: str, payload: VideoProbeInput):
    """Opt-in, bounded, non-recording experiment: phone encoder -> FNOS only."""
    with device_lock(manager, device_id):
        device = get_device(device_id)
        serial = selected_address(device)
        if not serial or manager.serial_for(device) != serial or not is_connected(serial):
            raise HTTPException(409, "请先手动连接当前选择的地址，再启动视频链路实验")
        try:
            return probe_video(serial, profile=payload.profile)
        except VideoProbeError as exc:
            raise HTTPException(502, str(exc)) from None



def lab_connected_serial(device_id):
    return lab_handlers.lab_connected_serial(sys.modules[__name__], device_id)


def display_lab_state(device_id: str):
    return lab_handlers.display_lab_state(sys.modules[__name__], device_id)


def display_lab_environment(device_id: str):
    return lab_handlers.display_lab_environment(sys.modules[__name__], device_id)


def display_lab_scan(device_id: str):
    return lab_handlers.display_lab_scan(sys.modules[__name__], device_id)


def display_lab_overlay(device_id: str):
    return lab_handlers.display_lab_overlay(sys.modules[__name__], device_id)


def display_lab_restore(device_id: str):
    return lab_handlers.display_lab_restore(sys.modules[__name__], device_id)


def lab_require_idle(device_id):
    return lab_handlers.lab_require_idle(sys.modules[__name__], device_id)


def castplus_start(device_id: str):
    return lab_handlers.castplus_start(sys.modules[__name__], device_id)


def castplus_auto(device_id: str):
    return lab_handlers.castplus_auto(sys.modules[__name__], device_id)


def castplus_switch(device_id: str):
    return lab_handlers.castplus_switch(sys.modules[__name__], device_id)


def castplus_verify(device_id: str):
    return lab_handlers.castplus_verify(sys.modules[__name__], device_id)


def castplus_restore(device_id: str):
    return lab_handlers.castplus_restore(sys.modules[__name__], device_id)

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
    with device_lock(manager, device_id):
        current = store.get(device_id)
        if (current and selected_address(current) == serial
                and manager.serial_for(current) == serial):
            manager._set_state(device_id, "disconnected",
                               "当前 ADB 地址已断开；请手动检查连接并重新连接")
    return True


def m2_video_engine():
    # Public capability metadata contains no token, serial, network or device data.
    return {"engine": VIDEO_ENGINE, "implemented": VIDEO_ENGINE != "webcodecs"}


async def _close_webrtc_peer(pc, stream, device_id, registry):
    """Keep the original aiortc close alive beyond the WS wait deadline.

    Cancelling pc.close() halfway can leave aiortc internally marked closed
    without finishing its transport teardown. Reuse this slot only when both
    peer and scrcpy/ADB worker cleanup have been confirmed.
    """
    try:
        await pc.close()
    except Exception:
        logging.getLogger(__name__).exception(
            "WebRTC peer close failed for device %s session %s; keeping slot",
            device_id, stream.session_id)
        return False
    stream.peer_cleanup_complete = True
    if registry.is_cleaned(stream):
        registry.release(device_id, stream)
    return True


async def m2_live_video(websocket: WebSocket, device_id: str):
    """Compatibility endpoint; actual live transport logic lives in api.live_handler."""
    return await handle_live_video(websocket, device_id, sys.modules[__name__])

def device_screenshot(device_id: str):
    with device_lock(manager, device_id):
        device = get_device(device_id)
        serial = manager.serial_for(device)
        if not serial or not is_connected(serial):
            manager._set_state(device_id, "disconnected", "当前 ADB 地址已断开")
            raise HTTPException(409, "设备未连接，请重新连接后再截图")
        return capture(serial)


# Backward-compatible MVP routes (not used by the M1 page).
def connect(target: Target):
    global _legacy_serial
    serial = address(target.ip, target.port)
    result = adb("connect", serial, timeout=18)
    if result.returncode != 0 or not is_connected(serial):
        raise HTTPException(502, "ADB 连接失败，请确认已配对、端口可达且无线调试已开启")
    with _legacy_lock:
        _legacy_serial = serial
    return {"connected": True, "serial": serial, "message": "连接成功"}


def status():
    with _legacy_lock:
        serial = _legacy_serial
    if not serial or not is_connected(serial):
        return {"connected": False, "serial": serial, "model": None}
    model = adb("-s", serial, "shell", "getprop", "ro.product.model", timeout=6)
    return {"connected": True, "serial": serial,
            "model": model.stdout.strip() if model.returncode == 0 else None}


def screenshot():
    with _legacy_lock:
        serial = _legacy_serial
    if not serial or not is_connected(serial):
        raise HTTPException(409, "设备未连接")
    return capture(serial)


# Register all API presentation contracts after importing the original handlers.
_handler_module = sys.modules[__name__]
for _domain in (legacy_routes, group_routes, device_routes, lab_routes, live_routes):
    app.include_router(_domain.build_router(_handler_module, authorize))
