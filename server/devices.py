"""Per-device ADB state and bounded reconnect loop (single Uvicorn worker)."""
import threading
from datetime import datetime, timezone

from fastapi import HTTPException


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


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
            return self.locks.setdefault(device_id, threading.Lock())

    def clear(self, device_id):
        with self.guard:
            self.states.pop(device_id, None)

    def snapshot(self, device):
        with self.guard:
            state = self.states.get(device["id"], {}).copy()
        return {
            **device,
            "status": state.get("status", "checking"),
            "last_error": state.get("last_error"),
            "last_seen": state.get("last_seen"),
        }

    def _set_state(self, device_id, status, error=None):
        with self.guard:
            old = self.states.get(device_id, {})
            self.states[device_id] = {
                "status": status,
                "last_error": error,
                "last_seen": utc_now() if status == "connected" else old.get("last_seen"),
            }

    def _get_state(self, serial):
        response = self.adb("-s", serial, "get-state", timeout=5)
        return response.returncode == 0 and response.stdout.strip() == "device"

    def probe(self, device_id, force_connect=False):
        """A single device may have only one concurrent ADB probe or reconnect."""
        with self._device_lock(device_id):
            device = self.store.get(device_id)
            if not device:
                return None
            serial = f'{device["ip"]}:{device["port"]}'
            self._set_state(device_id, "checking")
            try:
                connected = self._get_state(serial)
                if force_connect or (not connected and device["auto_reconnect"]):
                    if not connected:
                        self._set_state(device_id, "connecting")
                        self.adb("connect", serial, timeout=12)
                    connected = self._get_state(serial)
                if not connected:
                    self._set_state(device_id, "disconnected",
                                    "ADB 未连接；请检查无线调试、端口和网络")
                else:
                    if not device["model"] or not device["android_version"]:
                        model = self.adb("-s", serial, "shell", "getprop",
                                         "ro.product.model", timeout=5)
                        version = self.adb("-s", serial, "shell", "getprop",
                                           "ro.build.version.release", timeout=5)
                        self.store.set_metadata(
                            device_id,
                            model.stdout.strip()[:120] if model.returncode == 0 else None,
                            version.stdout.strip()[:40] if version.returncode == 0 else None,
                        )
                    self._set_state(device_id, "connected")
            except HTTPException as exc:
                self._set_state(device_id, "error", str(exc.detail))
            except Exception:
                self._set_state(device_id, "error", "检查设备时出现内部错误")
            latest = self.store.get(device_id)
            return self.snapshot(latest) if latest else None

    def poll_all(self):
        return [state for device in self.store.list()
                if (state := self.probe(device["id"])) is not None]

    def _loop(self):
        # Initial check, then bounded 20-second intervals (not one thread/device).
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
