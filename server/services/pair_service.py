"""Explicit one-shot ADB pairing, bound to the selected device route."""
import re
from ..core.exceptions import DomainError
from ..devices import selected_address
from .operations import device_lock


def pair_at_record(ip, port, code, *, validate_address, adb):
    dest = validate_address(ip, port)
    if not re.fullmatch(r"\d{6}", code):
        raise DomainError(400, "配对码应为手机显示的 6 位数字")
    result = adb("pair", dest, timeout=20, input_text=code + "\n")
    if result.returncode != 0 or "Successfully paired" not in result.stdout:
        raise DomainError(502, "ADB 配对失败，请检查配对端口、配对码和网络")
    return {"message": "配对成功，请使用无线调试主页的连接端口继续连接"}


def pair_existing_record(device_id, *, selected_serial, port, code, store, manager, pair_at):
    with device_lock(manager, device_id):
        device = store.get(device_id)
        if device is None:
            raise DomainError(404, "找不到该设备")
        serial = selected_address(device)
        if not serial:
            raise DomainError(409, "当前连接地址不可用，请先选择有效的 IP")
        if selected_serial != serial:
            raise DomainError(409, "所选连接地址已发生变化，请重新加载设备后再配对")
        ip = serial.rsplit(":", 1)[0]
        result = pair_at(ip, port, code)
        return {**result, "paired_ip": ip, "selected_route": device["selected_route"]}
