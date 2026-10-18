"""Manual, per-device ADB operations against the persisted selected route.

There is deliberately NO server-side background timer or automatic connect.
"""
import threading
from datetime import datetime, timezone

from fastapi import HTTPException


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def selected_address(device):
    """Only the explicitly selected address may be used for this device."""
    route = device["selected_route"]
    if route == "lan":
        ip = device.get("lan_ip")
        if not ip:
            return None
    elif route == "temp":
        ip, port = device.get("temp_ip"), device.get("temp_port")
        return f"{ip}:{port}" if ip and port else None
    else:
        ip = device["mesh_ip"]
    return f'{ip}:{device["port"]}'


class DeviceManager:
    def __init__(self, store, adb_command):
        self.store = store
        self.adb = adb_command
        self.states = {}
        self.locks = {}
        self.guard = threading.RLock()

    def _device_lock(self, device_id):
        with self.guard:
            return self.locks.setdefault(device_id, threading.RLock())

    def clear(self, device_id):
        with self.guard:
            self.states.pop(device_id, None)

    def snapshot(self, device):
        with self.guard:
            state = self.states.get(device["id"], {}).copy()
        serial = selected_address(device)
        if state.get("status") == "connected" and state.get("active_serial") != serial:
            state = {}
        return {
            **device,
            "selected_serial": serial,
            "status": state.get("status", "idle"),
            "last_error": state.get("last_error"),
            "last_seen": state.get("last_seen"),
            "active_serial": state.get("active_serial"),
            "active_route": state.get("active_route"),
            "connect_failed": bool(state.get("connect_failed", False)),
        }

    def _set_state(self, device_id, status, error=None, serial=None, route=None, connect_failed=None):
        with self.guard:
            old = self.states.get(device_id, {})
            self.states[device_id] = {
                "status": status,
                "last_error": error,
                "last_seen": utc_now() if status == "connected" else old.get("last_seen"),
                "active_serial": serial if status == "connected" else None,
                "active_route": route if status == "connected" else None,
                "connect_failed": (bool(connect_failed) if connect_failed is not None
                                   else bool(old.get("connect_failed", False))),
            }

    def serial_for(self, device):
        state = self.snapshot(device)
        return state["active_serial"] if state["status"] == "connected" else None

    def _get_state(self, serial):
        response = self.adb("-s", serial, "get-state", timeout=5)
        return response.returncode == 0 and response.stdout.strip() == "device"

    def probe(self, device_id, force_connect=False):
        """Check ONLY the selected serial. adb connect runs ONLY on explicit request."""
        with self._device_lock(device_id):
            device = self.store.get(device_id)
            if not device:
                return None
            serial = selected_address(device)
            if not serial:
                self._set_state(device_id, "error", "当前选择的连接地址已失效，请重新选择")
                return self.snapshot(device)
            route = device["selected_route"]
            try:
                self._set_state(device_id, "checking")
                connected = self._get_state(serial)
                if not connected and force_connect:
                    self._set_state(device_id, "connecting")
                    result = self.adb("connect", serial, timeout=12)
                    connected = result.returncode == 0 and self._get_state(serial)
                if connected:
                    if not device["model"] or not device["android_version"]:
                        try:
                            model = self.adb("-s", serial, "shell", "getprop", "ro.product.model", timeout=5)
                            version = self.adb("-s", serial, "shell", "getprop", "ro.build.version.release", timeout=5)
                            self.store.set_metadata(
                                device_id,
                                model.stdout.strip()[:120] if model.returncode == 0 else None,
                                version.stdout.strip()[:40] if version.returncode == 0 else None,
                            )
                        except HTTPException:
                            pass
                    self._set_state(device_id, "connected", serial=serial, route=route, connect_failed=False)
                else:
                    self._set_state(device_id, "disconnected",
                                    ("所选连接地址连接失败；请核对端口及网络，首次连接可先配对"
                                     if force_connect else "所选连接地址未连接；请手动点击「连接」"),
                                    connect_failed=True if force_connect else None)
            except HTTPException as exc:
                self._set_state(device_id, "error", str(exc.detail),
                                connect_failed=True if force_connect else None)
            except Exception:
                self._set_state(device_id, "error", "检查所选地址时发生内部错误",
                                connect_failed=True if force_connect else None)
            return self.snapshot(self.store.get(device_id) or device)

    def poll_all(self):
        """Called exclusively by the explicit 'check all' endpoint."""
        return [result for device in self.store.list()
                if (result := self.probe(device["id"])) is not None]
