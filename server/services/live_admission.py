"""Synchronous admission transaction for one explicitly opened live session.

The caller runs this service in a worker thread. Device locks, SQLite reads,
credential reads and display scans must never hold up the WebSocket loop.
Only reservation happens here: media/peer resources are created after handoff.
"""
from dataclasses import dataclass, field
import time

from ..display_lab import LabError
from .operations import device_lock


@dataclass(frozen=True)
class LiveAdmission:
    stream: object = None
    serial: str = None
    unlock_secret: str = field(default=None, repr=False)
    adb_check_ms: int = 0
    error: str = None
    waiting: bool = False
    superseded: bool = False


def prepare_live_session(device_id, *, selected_serial, profile, quality_settings,
                         experiment, screen_off, store, manager, display_lab,
                         session_manager, live_video, selected_address,
                         is_connected, cancelled, request):
    if cancelled.is_set():
        return LiveAdmission()
    device = store.get(device_id)
    serial = selected_address(device) if device else None
    if not serial or serial != selected_serial or manager.serial_for(device) != serial:
        return LiveAdmission(error="请先手动连接当前选择的设备")
    checked_at = time.monotonic()
    if not is_connected(serial):
        return LiveAdmission(error="当前选择的 ADB 地址已离线")
    check_ms = round((time.monotonic() - checked_at) * 1000)
    if cancelled.is_set():
        return LiveAdmission()
    try:
        secret = store.get_unlock_secret(device_id) if not experiment else None
    except ValueError:
        return LiveAdmission(error="开屏密码配置无效，请重新设置")
    if secret:
        screen_off = False
    # Acquire AND release the existing RLock in this same worker. Address
    # revalidation and reservation remain atomic with record mutations.
    with device_lock(manager, device_id):
        if cancelled.is_set():
            return LiveAdmission()
        current = store.get(device_id)
        if not current or selected_address(current) != serial or manager.serial_for(current) != serial:
            return LiveAdmission(error="当前选择的 IP 已改变，请重新开启投屏")
        if experiment and experiment["mode"] in ("new", "new_settings", "new_resolution"):
            if display_lab.has_pending(device_id):
                return LiveAdmission(error="请先恢复系统副屏模拟设置，再创建 scrcpy 虚拟屏幕")
        elif experiment and experiment["mode"] == "display":
            try:
                if experiment["display_id"] not in display_lab.scan(serial)["display_ids"]:
                    return LiveAdmission(error="指定 Display ID 不存在，请重新扫描显示器")
            except LabError as exc:
                return LiveAdmission(error=str(exc))
        if cancelled.is_set():
            return LiveAdmission()
        # Order explicit requests before slow validation, but only publish a
        # fully valid device request. Invalid pages cannot revoke a live owner.
        if not session_manager.publish_request(device_id, request):
            return LiveAdmission(superseded=not request.cancelled.is_set())
        options = {}
        if profile == "custom":
            options["quality"] = quality_settings
        if experiment:
            options["display_source"] = experiment
        if screen_off:
            options["screen_off"] = True
        candidate = live_video(serial, profile=profile, **options)
        reserved = session_manager.reserve_latest(device_id, request, candidate)
        if reserved == "waiting":
            return LiveAdmission(waiting=True)
        if reserved == "superseded":
            return LiveAdmission(superseded=not request.cancelled.is_set())
        if reserved == "full":
            return LiveAdmission(error="实时投屏会话已达上限，请先停止其他设备的投屏")
        # Even a cancellation racing reserve must receive this exact owner.
        # The shielded caller drains admission and cleans it before exiting.
        return LiveAdmission(candidate, serial, secret, check_ms)
