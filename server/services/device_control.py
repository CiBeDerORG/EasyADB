"""Selected-route, unlock and explicit ADB operations; transport-neutral errors."""
import sqlite3

from ..core.exceptions import DomainError
from ..devices import selected_address
from ..m2_unlock import validate_password
from .operations import device_lock


def _require(store, device_id):
    device = store.get(device_id)
    if device is None:
        raise DomainError(404, "找不到该设备")
    return device


def unlock_state_record(device_id, *, store):
    _require(store, device_id)
    return {"configured": store.unlock_configured(device_id)}


def set_unlock_record(device_id, password, *, store, manager):
    with device_lock(manager, device_id):
        _require(store, device_id)
        if password is None:
            return {"configured": store.unlock_configured(device_id)}
        if password == "":
            store.clear_unlock_secret(device_id)
            return {"configured": False}
        try:
            validate_password(password)
            store.save_unlock_secret(device_id, password)
        except ValueError as exc:
            raise DomainError(400, str(exc)) from None
        return {"configured": True}


def set_temporary_record(device_id, ip_value, port_value, validate_address, *,
                         store, manager, display_lab, live_registry):
    with device_lock(manager, device_id):
        if display_lab.has_pending(device_id):
            raise DomainError(409, "请先恢复该设备的副屏实验，再修改线路")
        original = _require(store, device_id)
        with live_registry.lock:
            session = live_registry.sessions.get(device_id)
            if session is not None and not live_registry.is_cleaned(session):
                raise DomainError(409, "该设备正在投屏或清理，请结束后修改临时地址")
        if ip_value is None:
            if port_value is not None:
                raise DomainError(400, "移除临时 IP 时不可单独修改共用端口")
            ip, port = None, original["port"]
        else:
            port = original["port"] if port_value is None else port_value
            serial = validate_address(ip_value, port)
            ip = serial.rsplit(":", 1)[0]
        try:
            result = store.set_temp_address(device_id, ip, port)
        except sqlite3.IntegrityError:
            raise DomainError(409, "共用 ADB 地址已存在") from None
        except ValueError as exc:
            raise DomainError(409, str(exc)) from None
        if result is None:
            raise DomainError(404, "找不到该设备")
        if selected_address(original) != selected_address(result):
            manager.clear(device_id)
        return manager.snapshot(result)


def select_route_record(device_id, route, *, store, manager, display_lab, live_registry):
    with device_lock(manager, device_id):
        if display_lab.has_pending(device_id):
            raise DomainError(409, "请先恢复该设备的副屏实验，再切换线路")
        if route not in ("mesh", "lan", "temp"):
            raise DomainError(400, "请选择组网 IP、内网 IP 或临时 IP")
        try:
            result = store.select_route(device_id, route)
        except ValueError as exc:
            raise DomainError(409, str(exc)) from None
        if result is None:
            raise DomainError(404, "找不到该设备")
        live_registry.stop_for(device_id)
        manager.clear(device_id)
        return manager.snapshot(result)


def probe_device_record(device_id, *, store, manager, force_connect):
    _require(store, device_id)
    result = manager.probe(device_id, force_connect=force_connect)
    if result is None:
        raise DomainError(404, "找不到该设备")
    if force_connect and result["status"] != "connected":
        raise DomainError(502, result["last_error"] or "ADB 连接失败")
    return result
