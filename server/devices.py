"""Bounded multi-device ADB monitor with LAN-first / mesh-fallback routing."""
import threading
from datetime import datetime, timezone

from fastapi import HTTPException


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def candidates(device):
    """Priority order: derived LAN address, then saved mesh address."""
    lan = device.get("lan_ip")
    mesh = device["mesh_ip"]
    result = []
    if lan:
        result.append((f'{lan}:{device["port"]}', "lan"))
    mesh_serial = f'{mesh}:{device["port"]}'
    if not result or mesh_serial != result[0][0]:
        result.append((mesh_serial, "mesh"))
    return result


class DeviceManager:
    def __init__(self, store, adb_command):
        self.store = store
        self.adb = adb_command
        self.states = {}
        self.locks = {}
        self.guard = threading.RLock()
        self.stop_event = threading.Event()
        self.worker = None

    def _device_lock(self, device_id):
        with self.guard:
            return self.locks.setdefault(device_id, threading.RLock())

    def clear(self, device_id):
        with self.guard:
            self.states.pop(device_id, None)

    def clear_group(self, name):
        for device in self.store.list():
            if device["group_name"] == name:
                self.clear(device["id"])

    def snapshot(self, device):
        with self.guard:
            state = self.states.get(device["id"], {}).copy()
        allowed = {serial for serial, _ in candidates(device)}
        if state.get("status") == "connected" and state.get("active_serial") not in allowed:
            state = {}
        return {
            **device,
            "status": state.get("status", "checking"),
            "last_error": state.get("last_error"),
            "last_seen": state.get("last_seen"),
            "active_serial": state.get("active_serial"),
            "active_route": state.get("active_route"),
        }

    def _set_state(self, device_id, status, error=None, serial=None, route=None):
        with self.guard:
            old = self.states.get(device_id, {})
            self.states[device_id] = {
                "status": status,
                "last_error": error,
                "last_seen": utc_now() if status == "connected" else old.get("last_seen"),
                "active_serial": serial if status == "connected" else None,
                "active_route": route if status == "connected" else None,
            }

    def serial_for(self, device):
        state = self.snapshot(device)
        if state["status"] != "connected":
            return None
        return state["active_serial"]

    def _get_state(self, serial):
        response = self.adb("-s", serial, "get-state", timeout=5)
        return response.returncode == 0 and response.stdout.strip() == "device"

    def probe(self, device_id, force_connect=False):
        """Serialize probes per device; prefer LAN, fallback to mesh on failure."""
        with self._device_lock(device_id):
            device = self.store.get(device_id)
            if not device:
                return None
            self._set_state(device_id, "checking")
            selected = None
            error = None
            allow_connect = force_connect or device["auto_reconnect"]
            for serial, route in candidates(device):
                try:
                    connected = self._get_state(serial)
                    if not connected and allow_connect:
                        self._set_state(device_id, "connecting")
                        attempt = self.adb("connect", serial, timeout=12)
                        # Do not trust adb's stdout; confirm that THIS serial is live.
                        connected = attempt.returncode == 0 and self._get_state(serial)
                    if connected:
                        selected = (serial, route)
                        break
                except HTTPException as exc:
                    error = str(exc.detail)
                except Exception:
                    error = "检查连接地址时出现内部错误"
            if selected:
                serial, route = selected
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
                        pass  # A transient metadata error does not invalidate a live ADB route.
                self._set_state(device_id, "connected", serial=serial, route=route)
            else:
                self._set_state(device_id, "error" if error else "disconnected",
                                error or "内网 IP / 组网 IP 均未连接；请检查网络、端口及无线调试")
            latest = self.store.get(device_id)
            return self.snapshot(latest) if latest else None

    def poll_all(self):
        return [state for device in self.store.list()
                if (state := self.probe(device["id"])) is not None]

    def _loop(self):
        while not self.stop_event.is_set():
            self.poll_all()
            if self.stop_event.wait(20):
                break

    def start(self):
        self.stop_event.clear()
        self.worker = threading.Thread(target=self._loop, name="easyadb-monitor", daemon=True)
        self.worker.start()

    def stop(self):
        self.stop_event.set()
        if self.worker:
            self.worker.join(timeout=2)
