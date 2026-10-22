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
from .services.pair_service import pair_at_record, pair_existing_record
from .services.preflight_service import preflight_record, video_probe_record
from .services.device_control import (unlock_state_record, set_unlock_record, set_temporary_record,
                                      select_route_record, probe_device_record)
from .services.group_service import (create_group_record, update_group_record, delete_group_record,
                             configure_group_discovery_record, clear_group_discovery_record)
from .api.static import router as static_router
from .api.schemas import (Target, PairTarget, PairExisting, DeviceInput, RouteInput, TempAddressInput,
                          UnlockInput, VideoProbeInput, GroupInput, GroupDiscoveryInput)
from .api.validation import clean_group, address, clean_input
from .api import groups as group_routes, devices as device_routes, lab as lab_routes, live as live_routes, legacy as legacy_routes
from .api.live_handler import handle_live_video
from .api import lab_handlers, screenshots, legacy_handlers
from .services.live_coordination import confirm_adb_loss, close_webrtc_peer
from .services.session_manager import SessionManager
from .services.resource_budget import ScopedResourceBudget
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
session_manager = SessionManager(lambda: live_registry)
resource_budget = ScopedResourceBudget(lambda: live_registry, settings.max_starting)
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
    return screenshots.capture_screen(sys.modules[__name__], serial)


def pair_at(ip, port, code):
    try:
        return pair_at_record(ip, port, code, validate_address=address, adb=adb)
    except DomainError as exc:
        raise HTTPException(exc.status_code, exc.detail) from None

def pair(target: PairTarget):
    # Original first-time pairing from the add-device form remains compatible.
    return pair_at(target.ip, target.port, target.code)


def pair_existing_device(device_id: str, target: PairExisting):
    try:
        return pair_existing_record(
            device_id, selected_serial=target.selected_serial,
            port=target.port, code=target.code, store=store, manager=manager,
            pair_at=pair_at,
        )
    except DomainError as exc:
        raise HTTPException(exc.status_code, exc.detail) from None

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
    try:
        return unlock_state_record(device_id, store=store)
    except DomainError as exc:
        raise HTTPException(exc.status_code, exc.detail) from None

def set_unlock_state(device_id: str, payload: UnlockInput):
    try:
        return set_unlock_record(device_id, payload.password, store=store, manager=manager)
    except DomainError as exc:
        raise HTTPException(exc.status_code, exc.detail) from None

def delete_device(device_id: str):
    try:
        return delete_device_record(
            device_id, store=store, manager=manager,
            display_lab=display_lab, live_registry=live_registry,
        )
    except DomainError as exc:
        raise HTTPException(exc.status_code, exc.detail) from None

def set_device_temp_address(device_id: str, payload: TempAddressInput):
    try:
        return set_temporary_record(
            device_id, payload.ip, payload.port, address, store=store, manager=manager,
            display_lab=display_lab, live_registry=live_registry,
        )
    except DomainError as exc:
        raise HTTPException(exc.status_code, exc.detail) from None

def select_device_route(device_id: str, payload: RouteInput):
    try:
        return select_route_record(
            device_id, payload.route, store=store, manager=manager,
            display_lab=display_lab, live_registry=live_registry,
        )
    except DomainError as exc:
        raise HTTPException(exc.status_code, exc.detail) from None

def connect_device(device_id: str):
    try:
        return probe_device_record(device_id, store=store, manager=manager, force_connect=True)
    except DomainError as exc:
        raise HTTPException(exc.status_code, exc.detail) from None

def refresh_device(device_id: str):
    try:
        return probe_device_record(device_id, store=store, manager=manager, force_connect=False)
    except DomainError as exc:
        raise HTTPException(exc.status_code, exc.detail) from None

def m2_device_preflight(device_id: str):
    """User-initiated capability check; no connect or scrcpy process."""
    try:
        return preflight_record(
            device_id, store=store, manager=manager,
            is_connected=is_connected, inspect=inspect_device, adb=adb,
        )
    except DomainError as exc:
        raise HTTPException(exc.status_code, exc.detail) from None

def m2_video_probe(device_id: str, payload: VideoProbeInput):
    """Opt-in encoder experiment: phone -> FNOS only."""
    try:
        return video_probe_record(
            device_id, payload.profile, store=store, manager=manager,
            is_connected=is_connected, probe=probe_video,
        )
    except DomainError as exc:
        raise HTTPException(exc.status_code, exc.detail) from None

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
    return await confirm_adb_loss(sys.modules[__name__], device_id, serial)


def m2_video_engine():
    # Public capability metadata contains no token, serial, network or device data.
    return {"engine": VIDEO_ENGINE, "implemented": VIDEO_ENGINE == "webrtc",
            "max_starting": resource_budget.snapshot()["max_starting"]}


async def _close_webrtc_peer(pc, stream, device_id, registry):
    result = await close_webrtc_peer(pc, stream, device_id, registry)
    if result:
        session_manager.late_cleanup(device_id, stream)
    return result


async def m2_live_video(websocket: WebSocket, device_id: str):
    """Compatibility endpoint; actual live transport logic lives in api.live_handler."""
    return await handle_live_video(websocket, device_id, sys.modules[__name__])

def device_screenshot(device_id: str):
    return screenshots.screenshot_device(sys.modules[__name__], device_id)


# Backward-compatible MVP routes (not used by the M1 page).
def connect(target: Target):
    return legacy_handlers.connect_legacy(sys.modules[__name__], target)


def status():
    return legacy_handlers.legacy_status(sys.modules[__name__])


def screenshot():
    return legacy_handlers.legacy_screenshot(sys.modules[__name__])


# Register all API presentation contracts after importing the original handlers.
_handler_module = sys.modules[__name__]
for _domain in (legacy_routes, group_routes, device_routes, lab_routes, live_routes):
    app.include_router(_domain.build_router(_handler_module, authorize))
