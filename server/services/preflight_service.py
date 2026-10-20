"""Explicit device preflight and opt-in bounded M2 video probe."""
from ..core.exceptions import DomainError
from ..devices import selected_address
from ..m2_video_probe import VideoProbeError
from .operations import device_lock


def _current_connected_serial(device_id, *, store, manager, is_connected, unavailable):
    device = store.get(device_id)
    if device is None:
        raise DomainError(404, "找不到该设备")
    serial = selected_address(device)
    if not serial or manager.serial_for(device) != serial or not is_connected(serial):
        raise DomainError(409, unavailable)
    return serial


def preflight_record(device_id, *, store, manager, is_connected, inspect, adb):
    with device_lock(manager, device_id):
        serial = _current_connected_serial(
            device_id, store=store, manager=manager, is_connected=is_connected,
            unavailable="请先手动连接当前选择的设备，再执行 M2 预检",
        )
        return inspect(serial, adb)


def video_probe_record(device_id, profile, *, store, manager, is_connected, probe):
    with device_lock(manager, device_id):
        serial = _current_connected_serial(
            device_id, store=store, manager=manager, is_connected=is_connected,
            unavailable="请先手动连接当前选择的地址，再启动视频链路实验",
        )
        try:
            return probe(serial, profile=profile)
        except VideoProbeError as exc:
            raise DomainError(502, str(exc)) from None
