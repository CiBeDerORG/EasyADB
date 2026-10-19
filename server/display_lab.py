"""Opt-in multi-display experiments. No arbitrary shell commands or implicit ADB connection.

Overlay recovery records are durable: a server restart must not silently discard the
previous setting. Restoration is always explicit and targets the original selected serial.
"""
import json
import os
import re
import threading
from pathlib import Path

from .m2_video_probe import VERSION
from .castplus_lab import CastPlusMixin

OVERLAY = "1920x1080/240"
_ALLOWED_SETTING = re.compile(r"[A-Za-z0-9_.,;/x+-]{1,256}\Z")
_DISPLAY_PATTERNS = (r"mDisplayId\s*=\s*(\d+)", r"\bDisplay\s+(\d+)\s*:",
                     r"\bdisplayId\s*=\s*(\d+)", r"\bDisplayInfo\{[^\n]*?\bdisplayId\s+(\d+)")


class LabError(Exception):
    pass


def display_ids(output):
    """Best-effort logical display IDs; raw dumpsys excerpt accompanies scan results."""
    found = {0}
    for pattern in _DISPLAY_PATTERNS:
        for match in re.finditer(pattern, output, re.IGNORECASE):
            number = int(match.group(1))
            if 0 <= number <= 255:
                found.add(number)
    return sorted(found)


class DisplayLab(CastPlusMixin):
    def __init__(self, adb, recovery_path):
        self.adb = adb
        self.path = Path(recovery_path)
        self.lock = threading.RLock()
        self.pending = {}
        self.history = []
        if self.path.exists():
            try:
                data = json.loads(self.path.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    for key, value in data.items():
                        if (isinstance(key, str) and isinstance(value, dict)
                                and isinstance(value.get("serial"), str)
                                and isinstance(value.get("previous"), str)
                                and value.get("applied") == OVERLAY):
                            self.pending[key] = value
            except (ValueError, OSError):
                raise RuntimeError("电脑模式实验恢复记录损坏；请检查 " + str(self.path))
        self.init_castplus()

    def _save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(self.path.name + ".tmp")
        temporary.write_text(json.dumps(self.pending, ensure_ascii=False), encoding="utf-8")
        os.chmod(temporary, 0o600)
        os.replace(temporary, self.path)

    def _cmd(self, serial, *args, timeout=12):
        response = self.adb("-s", serial, "shell", *args, timeout=timeout)
        output = (response.stdout or "").strip()
        error = (response.stderr or "").strip()
        if response.returncode:
            raise LabError(("ADB 命令执行失败：" + (error or output or "未知错误"))[:500])
        return output

    def _setting(self, serial):
        return self._cmd(serial, "settings", "get", "global", "overlay_display_devices")

    def scan(self, serial):
        raw = self._cmd(serial, "dumpsys", "display", timeout=18)
        ids = display_ids(raw)
        return {"display_ids": ids, "display_excerpt": raw[:14000],
                "note": "Display ID 来自 dumpsys 的尽力解析；如有遗漏，请查看原始输出。"}

    def environment(self, device_id, serial):
        with self.lock:
            api = self._cmd(serial, "getprop", "ro.build.version.sdk")
            version = self._cmd(serial, "getprop", "ro.build.version.release")
            setting = self._setting(serial)
            result = self.scan(serial)
            result.update({"serial": serial, "android_version": version, "api_level": api,
                           "scrcpy_server_version": VERSION, "overlay_setting": setting,
                           "pending_restore": self.pending.get(device_id),
                           "pending_castplus": self.cast_pending.get(device_id),
                           "castplus_capabilities": self.cast_capabilities(serial)})
            return result

    def has_pending(self, device_id):
        with self.lock:
            return device_id in self.pending or device_id in self.cast_pending

    def state(self, device_id):
        with self.lock:
            return {"pending_restore": self.pending.get(device_id),
                    "pending_castplus": self.cast_pending.get(device_id),
                    "logs": [v for v in self.history if v["device_id"] == device_id][-40:]}

    def _log(self, device_id, action, serial, detail):
        from datetime import datetime, timezone
        self.history.append({"at": datetime.now(timezone.utc).isoformat(),
                             "device_id": device_id, "action": action, "serial": serial,
                             "detail": str(detail)[:1500]})
        self.history = self.history[-160:]

    def enable_overlay(self, device_id, serial):
        with self.lock:
            if device_id in self.pending or device_id in self.cast_pending:
                raise LabError("已有待恢复的副屏或 Cast+ 实验；请先恢复原始设置")
            previous = self._setting(serial)
            if not _ALLOWED_SETTING.fullmatch(previous):
                raise LabError("原始副屏配置无法安全保存，本次不执行修改")
            if previous == OVERLAY:
                self._log(device_id, "B1", serial, "设备原本已设置相同模拟副屏；没有覆盖")
                return {**self.scan(serial), "pending_restore": None, "unchanged": True}
            record = {"serial": serial, "previous": previous, "applied": OVERLAY}
            self.pending[device_id] = record
            try:
                # Persist BEFORE writing the device to survive command timeouts/restarts.
                self._save()
            except OSError:
                self.pending.pop(device_id, None)
                raise LabError("无法保存原始副屏配置，未修改手机设置") from None
            try:
                self._cmd(serial, "settings", "put", "global", "overlay_display_devices", OVERLAY)
                current = self._setting(serial)
                if current != OVERLAY:
                    raise LabError("手机未接受模拟副屏配置；保留恢复记录")
                self._log(device_id, "B1", serial, "已写入 " + OVERLAY + "；原始值 " + previous)
                return {**self.scan(serial), "pending_restore": record, "unchanged": False}
            except Exception:
                self._log(device_id, "B1", serial, "修改失败或结果不确定；已保留原始配置供恢复")
                raise

    def restore(self, device_id, serial):
        with self.lock:
            record = self.pending.get(device_id)
            if not record:
                raise LabError("本设备没有待恢复的实验设置")
            if record["serial"] != serial:
                raise LabError("连接地址已变化；请切回实验时的原始设备线路再恢复")
            current = self._setting(serial)
            if current != record["applied"] and current != record["previous"]:
                raise LabError("系统配置已被其他操作修改；为避免覆盖，请先人工确认")
            previous = record["previous"]
            if current != previous:
                if previous == "null":
                    self._cmd(serial, "settings", "delete", "global", "overlay_display_devices")
                else:
                    self._cmd(serial, "settings", "put", "global", "overlay_display_devices", previous)
                if self._setting(serial) != previous:
                    raise LabError("恢复后的设置校验未通过；保留恢复记录")
            del self.pending[device_id]
            try:
                self._save()
            except OSError:
                self.pending[device_id] = record
                raise LabError("手机已恢复，但恢复记录落盘失败；请检查服务器磁盘") from None
            self._log(device_id, "恢复", serial, "已恢复为 " + previous)
            return {**self.scan(serial), "restored": previous, "pending_restore": None}
