"""M2 display/CastPlus experimental API handlers, shared app runtime only."""
from fastapi import HTTPException
from ..display_lab import LabError
from ..castplus_lab import CastError
from ..services.operations import device_lock


def lab_connected_serial(source, device_id):
    # Use the owning application's current runtime; never allocate a new one.
    manager = source.manager
    store = source.store
    display_lab = source.display_lab
    live_registry = source.live_registry
    get_device = source.get_device
    is_connected = source.is_connected
    selected_address = source.selected_address
    device = get_device(device_id)
    serial = selected_address(device)
    if not serial or manager.serial_for(device) != serial or not is_connected(serial):
        raise HTTPException(409, "请先手动连接当前选定的 ADB 地址")
    return serial


def display_lab_state(source, device_id: str):
    # Use the owning application's current runtime; never allocate a new one.
    manager = source.manager
    store = source.store
    display_lab = source.display_lab
    live_registry = source.live_registry
    get_device = source.get_device
    is_connected = source.is_connected
    selected_address = source.selected_address
    get_device(device_id)
    return display_lab.state(device_id)


def display_lab_environment(source, device_id: str):
    # Use the owning application's current runtime; never allocate a new one.
    manager = source.manager
    store = source.store
    display_lab = source.display_lab
    live_registry = source.live_registry
    get_device = source.get_device
    is_connected = source.is_connected
    selected_address = source.selected_address
    with device_lock(manager, device_id):
        serial = lab_connected_serial(source, device_id)
        try:
            result = display_lab.environment(device_id, serial)
            display_lab._log(device_id, "环境检测", serial, "检测到显示器 " + str(result["display_ids"]))
            return result
        except LabError as exc:
            raise HTTPException(502, str(exc)) from None


def display_lab_scan(source, device_id: str):
    # Use the owning application's current runtime; never allocate a new one.
    manager = source.manager
    store = source.store
    display_lab = source.display_lab
    live_registry = source.live_registry
    get_device = source.get_device
    is_connected = source.is_connected
    selected_address = source.selected_address
    with device_lock(manager, device_id):
        serial = lab_connected_serial(source, device_id)
        try:
            result = display_lab.scan(serial)
            display_lab._log(device_id, "B2", serial, "检测到显示器 " + str(result["display_ids"]))
            return result
        except LabError as exc:
            raise HTTPException(502, str(exc)) from None


def display_lab_overlay(source, device_id: str):
    # Use the owning application's current runtime; never allocate a new one.
    manager = source.manager
    store = source.store
    display_lab = source.display_lab
    live_registry = source.live_registry
    get_device = source.get_device
    is_connected = source.is_connected
    selected_address = source.selected_address
    with device_lock(manager, device_id):
        serial = lab_connected_serial(source, device_id)
        with live_registry.lock:
            running = live_registry.sessions.get(device_id)
            if running is not None and not live_registry.is_cleaned(running):
                raise HTTPException(409, "先停止此设备已有的实时画面，再模拟副屏")
        try:
            return display_lab.enable_overlay(device_id, serial)
        except LabError as exc:
            raise HTTPException(409, str(exc)) from None


def display_lab_restore(source, device_id: str):
    # Use the owning application's current runtime; never allocate a new one.
    manager = source.manager
    store = source.store
    display_lab = source.display_lab
    live_registry = source.live_registry
    get_device = source.get_device
    is_connected = source.is_connected
    selected_address = source.selected_address
    with device_lock(manager, device_id):
        serial = lab_connected_serial(source, device_id)
        with live_registry.lock:
            running = live_registry.sessions.get(device_id)
            if running is not None and not live_registry.is_cleaned(running):
                raise HTTPException(409, "请先停止当前副屏预览，再恢复设置")
        try:
            return display_lab.restore(device_id, serial)
        except LabError as exc:
            raise HTTPException(409, str(exc)) from None


def lab_require_idle(source, device_id):
    # Use the owning application's current runtime; never allocate a new one.
    manager = source.manager
    store = source.store
    display_lab = source.display_lab
    live_registry = source.live_registry
    get_device = source.get_device
    is_connected = source.is_connected
    selected_address = source.selected_address
    with live_registry.lock:
        running = live_registry.sessions.get(device_id)
        if running is not None and not live_registry.is_cleaned(running):
            raise HTTPException(409, "请先停止此设备现有画面并等待会话清理完成")


def castplus_start(source, device_id: str):
    # Use the owning application's current runtime; never allocate a new one.
    manager = source.manager
    store = source.store
    display_lab = source.display_lab
    live_registry = source.live_registry
    get_device = source.get_device
    is_connected = source.is_connected
    selected_address = source.selected_address
    with device_lock(manager, device_id):
        serial = lab_connected_serial(source, device_id)
        lab_require_idle(source, device_id)
        try:
            return display_lab.cast_create(device_id, serial)
        except (LabError, CastError) as exc:
            raise HTTPException(409, str(exc)) from None


def castplus_auto(source, device_id: str):
    # Use the owning application's current runtime; never allocate a new one.
    manager = source.manager
    store = source.store
    display_lab = source.display_lab
    live_registry = source.live_registry
    get_device = source.get_device
    is_connected = source.is_connected
    selected_address = source.selected_address
    with device_lock(manager, device_id):
        serial = lab_connected_serial(source, device_id)
        lab_require_idle(source, device_id)
        try:
            return display_lab.cast_auto(device_id, serial)
        except (LabError, CastError) as exc:
            raise HTTPException(409, str(exc)) from None


def castplus_switch(source, device_id: str):
    # Use the owning application's current runtime; never allocate a new one.
    manager = source.manager
    store = source.store
    display_lab = source.display_lab
    live_registry = source.live_registry
    get_device = source.get_device
    is_connected = source.is_connected
    selected_address = source.selected_address
    with device_lock(manager, device_id):
        serial = lab_connected_serial(source, device_id)
        lab_require_idle(source, device_id)
        try:
            return display_lab.cast_switch(device_id, serial)
        except (LabError, CastError) as exc:
            raise HTTPException(409, str(exc)) from None


def castplus_verify(source, device_id: str):
    # Use the owning application's current runtime; never allocate a new one.
    manager = source.manager
    store = source.store
    display_lab = source.display_lab
    live_registry = source.live_registry
    get_device = source.get_device
    is_connected = source.is_connected
    selected_address = source.selected_address
    with device_lock(manager, device_id):
        serial = lab_connected_serial(source, device_id)
        try:
            return display_lab.cast_verify(device_id, serial)
        except (LabError, CastError) as exc:
            raise HTTPException(409, str(exc)) from None


def castplus_restore(source, device_id: str):
    # Use the owning application's current runtime; never allocate a new one.
    manager = source.manager
    store = source.store
    display_lab = source.display_lab
    live_registry = source.live_registry
    get_device = source.get_device
    is_connected = source.is_connected
    selected_address = source.selected_address
    with device_lock(manager, device_id):
        serial = lab_connected_serial(source, device_id)
        lab_require_idle(source, device_id)
        try:
            return display_lab.cast_restore(device_id, serial)
        except (LabError, CastError) as exc:
            raise HTTPException(409, str(exc)) from None

