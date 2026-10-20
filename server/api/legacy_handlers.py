"""Original MVP endpoints, retained as a separate presentation adapter.

Keep the original singleton selected serial in server.app for compatibility;
the new device-ID routes must never read it or mutate it.
"""
from fastapi import HTTPException


def connect_legacy(source, target):
    serial = source.address(target.ip, target.port)
    result = source.adb("connect", serial, timeout=18)
    if result.returncode != 0 or not source.is_connected(serial):
        raise HTTPException(502, "ADB 连接失败，请确认已配对、端口可达且无线调试已开启")
    with source._legacy_lock:
        source._legacy_serial = serial
    return {"connected": True, "serial": serial, "message": "连接成功"}


def legacy_status(source):
    with source._legacy_lock:
        serial = source._legacy_serial
    if not serial or not source.is_connected(serial):
        return {"connected": False, "serial": serial, "model": None}
    model = source.adb("-s", serial, "shell", "getprop", "ro.product.model", timeout=6)
    return {"connected": True, "serial": serial,
            "model": model.stdout.strip() if model.returncode == 0 else None}


def legacy_screenshot(source):
    with source._legacy_lock:
        serial = source._legacy_serial
    if not serial or not source.is_connected(serial):
        raise HTTPException(409, "设备未连接")
    return source.capture(serial)
