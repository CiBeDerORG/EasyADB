"""EasyADB: persistent multi-device wireless ADB connection management."""
import ipaddress
import os
import re
import secrets
import sqlite3
import subprocess
import threading
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from .devices import DeviceManager
from .store import DeviceStore

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


@asynccontextmanager
async def lifespan(_app):
    store.initialize()
    manager.start()
    try:
        yield
    finally:
        manager.stop()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

# Retain the first MVP endpoints for compatibility; M1 routes always use device IDs.
_legacy_serial = None
_legacy_lock = threading.Lock()


class Target(BaseModel):
    ip: str
    port: int


class PairTarget(Target):
    code: str


class DeviceInput(Target):
    name: str
    group_name: str = ""
    auto_reconnect: bool = True


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
        "auto_reconnect": payload.auto_reconnect,
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


@app.post("/api/pair", dependencies=[Depends(authorize)])
def pair(target: PairTarget):
    dest = address(target.ip, target.port)
    if not re.fullmatch(r"\d{6}", target.code):
        raise HTTPException(400, "配对码应为手机显示的 6 位数字")
    result = adb("pair", dest, timeout=20, input_text=target.code + "\n")
    if result.returncode != 0 or "Successfully paired" not in result.stdout:
        raise HTTPException(502, "ADB 配对失败，请检查配对端口、配对码和网络")
    return {"message": "配对成功，请使用无线调试主页的连接端口继续连接"}


@app.get("/api/devices", dependencies=[Depends(authorize)])
def list_devices():
    return [manager.snapshot(d) for d in store.list()]


@app.post("/api/devices", status_code=201, dependencies=[Depends(authorize)])
def create_device(payload: DeviceInput):
    data = clean_input(payload)
    try:
        device = store.create(data)
    except sqlite3.IntegrityError:
        raise HTTPException(409, "该 IP 和端口已经存在于设备列表") from None
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
        raise HTTPException(409, "该 IP 和端口已经存在于设备列表") from None
    if not updated:
        raise HTTPException(404, "找不到该设备")
    if (original["ip"], original["port"]) != (updated["ip"], updated["port"]):
        manager.clear(device_id)
    return manager.snapshot(updated)


@app.delete("/api/devices/{device_id}", dependencies=[Depends(authorize)])
def delete_device(device_id: str):
    get_device(device_id)
    if not store.delete(device_id):
        raise HTTPException(404, "找不到该设备")
    manager.clear(device_id)
    # Deliberately don't adb disconnect: other clients may be using the target.
    return {"deleted": True}


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


@app.get("/api/devices/{device_id}/screenshot", dependencies=[Depends(authorize)])
def device_screenshot(device_id: str):
    device = get_device(device_id)
    serial = f'{device["ip"]}:{device["port"]}'
    if not is_connected(serial):
        manager._set_state(device_id, "disconnected", "ADB 已断开")
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
