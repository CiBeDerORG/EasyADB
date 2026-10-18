"""EasyADB MVP: wireless ADB connect and on-demand screenshot."""
import ipaddress
import os
import re
import secrets
import subprocess
import threading
from pathlib import Path
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

TOKEN = os.getenv("EASYADB_TOKEN", "").strip()
if len(TOKEN) < 12 or TOKEN == "REPLACE_WITH_RANDOM_LONG_TOKEN":
    raise RuntimeError("Set EASYADB_TOKEN to a unique token of at least 12 characters")
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
ROOT = Path(__file__).resolve().parents[1]
_current_serial = None
_lock = threading.Lock()

class Target(BaseModel):
    ip: str
    port: int

class PairTarget(Target):
    code: str

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

def adb(*args, timeout=15, input_text=None):
    try:
        return subprocess.run(["adb", *args], input=input_text, capture_output=True,
                              text=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "ADB 操作超时，请检查设备网络和调试状态") from None
    except FileNotFoundError:
        raise HTTPException(503, "服务器未安装 ADB") from None

def is_connected(serial):
    result = adb("-s", serial, "get-state", timeout=6)
    return result.returncode == 0 and result.stdout.strip() == "device"

@app.get("/")
def home():
    return FileResponse(ROOT / "web" / "index.html", headers={"Cache-Control": "no-store"})

@app.post("/api/pair", dependencies=[Depends(authorize)])
def pair(target: PairTarget):
    dest = address(target.ip, target.port)
    if not re.fullmatch(r"\d{6}", target.code):
        raise HTTPException(400, "配对码应为手机显示的 6 位数字")
    # Send code via stdin rather than exposing it in the adb process arguments.
    result = adb("pair", dest, timeout=20, input_text=target.code + "\n")
    if result.returncode != 0 or "Successfully paired" not in result.stdout:
        raise HTTPException(502, "ADB 配对失败，请检查配对端口、配对码和网络")
    return {"message": "配对成功，请使用无线调试主页的连接端口继续连接"}

@app.post("/api/connect", dependencies=[Depends(authorize)])
def connect(target: Target):
    global _current_serial
    serial = address(target.ip, target.port)
    result = adb("connect", serial, timeout=18)
    if result.returncode != 0 or not is_connected(serial):
        raise HTTPException(502, "ADB 连接失败，请确认已配对、端口可达且无线调试已开启")
    with _lock:
        _current_serial = serial
    return {"connected": True, "serial": serial, "message": "连接成功"}

@app.get("/api/status", dependencies=[Depends(authorize)])
def status():
    with _lock:
        serial = _current_serial
    if not serial or not is_connected(serial):
        return {"connected": False, "serial": serial, "model": None}
    model = adb("-s", serial, "shell", "getprop", "ro.product.model", timeout=6)
    return {"connected": True, "serial": serial,
            "model": model.stdout.strip() if model.returncode == 0 else None}

@app.get("/api/screenshot", dependencies=[Depends(authorize)])
def screenshot():
    with _lock:
        serial = _current_serial
    if not serial or not is_connected(serial):
        raise HTTPException(409, "设备未连接")
    try:
        result = subprocess.run(["adb", "-s", serial, "exec-out", "screencap", "-p"],
                                capture_output=True, timeout=20, check=False)
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "截图超时") from None
    except FileNotFoundError:
        raise HTTPException(503, "服务器未安装 ADB") from None
    if result.returncode != 0 or not result.stdout.startswith(b"\x89PNG\r\n\x1a\n"):
        raise HTTPException(502, "截图失败，请检查手机屏幕或 ADB 连接")
    return Response(result.stdout, media_type="image/png", headers={"Cache-Control": "no-store"})
