"""Screenshot API adapter: return unchanged PNG bytes and cache headers."""
import subprocess

from fastapi import HTTPException
from fastapi.responses import Response
from ..services.operations import device_lock


def capture_screen(source, serial):
    try:
        result = source.subprocess.run(["adb", "-s", serial, "exec-out", "screencap", "-p"],
                                      capture_output=True, timeout=20, check=False)
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "截图超时") from None
    except FileNotFoundError:
        raise HTTPException(503, "服务器未安装 ADB") from None
    if result.returncode != 0 or not result.stdout.startswith(b"\x89PNG\r\n\x1a\n"):
        raise HTTPException(502, "截图失败，请检查手机屏幕或 ADB 连接")
    return Response(result.stdout, media_type="image/png", headers={"Cache-Control": "no-store"})


def screenshot_device(source, device_id):
    with device_lock(source.manager, device_id):
        device = source.get_device(device_id)
        serial = source.manager.serial_for(device)
        if not serial or not source.is_connected(serial):
            source.manager._set_state(device_id, "disconnected", "当前 ADB 地址已断开")
            raise HTTPException(409, "设备未连接，请重新连接后再截图")
        return source.capture(serial)
