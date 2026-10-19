"""Explicit Huawei Cast+ display hypothesis lab; no root, spoofed success, or polling."""
import json
import os
import re
import time
from pathlib import Path


class CastError(Exception):
    pass


SAFE_MODE = re.compile(r"(?:null|[0-9]{1,6})\Z")
COMPONENT = "com.easyadb.castpluslab/.CastPlusService"
PACKAGE = "com.easyadb.castpluslab"
SWITCH_ACTION = "com.android.server.pc.action.SWITCH_MODE"


class CastPlusMixin:
    def init_castplus(self):
        self.cast_path = self.path.with_name(self.path.name + ".castplus")
        self.cast_apk = self.path.parent / "castplus-lab.apk"
        self.cast_pending = {}
        if self.cast_path.exists():
            try:
                data = json.loads(self.cast_path.read_text(encoding="utf-8"))
                if not isinstance(data, dict):
                    raise ValueError("invalid record")
                for key, record in data.items():
                    if (not isinstance(key, str) or not isinstance(record, dict)
                            or not isinstance(record.get("serial"), str)
                            or not SAFE_MODE.fullmatch(record.get("previous_mode", ""))
                            or record.get("applied_mode") not in (None, "1")):
                        raise ValueError("invalid record")
                self.cast_pending = data
            except (ValueError, OSError, TypeError):
                raise RuntimeError("Cast+ 实验恢复记录损坏；请检查 " + str(self.cast_path)) from None

    def _save_cast(self):
        self.cast_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.cast_path.with_name(self.cast_path.name + ".tmp")
        temporary.write_text(json.dumps(self.cast_pending, ensure_ascii=False), encoding="utf-8")
        os.chmod(temporary, 0o600)
        os.replace(temporary, self.cast_path)

    def _cast_adb(self, serial, *args, timeout=25):
        result = self.adb("-s", serial, *args, timeout=timeout)
        stdout = (result.stdout or "").strip()
        stderr = (result.stderr or "").strip()
        if result.returncode:
            raise CastError(("ADB 实验命令失败：" + (stderr or stdout or "未知错误"))[:450])
        return stdout

    def _mode(self, serial):
        return self._cmd(serial, "settings", "get", "secure", "selected-proj-mode")

    def cast_capabilities(self, serial):
        props = {}
        for key in ("hw_mc.multiscreen.mdms.value", "hw_pc_support_overlay",
                    "ro.config.hw_emui_desktop_mode", "ro.config.hw_emui_wfd_pc_mode",
                    "hw.pc.cast.mode"):
            props[key] = self._cmd(serial, "getprop", key)
        return {"properties": props, "selected_proj_mode": self._mode(serial),
                "helper_apk_ready": self.cast_apk.is_file(),
                "helper_installed": PACKAGE in self._cmd(serial, "pm", "path", PACKAGE)}

    @staticmethod
    def _cast_info(raw, before=()):
        """Never equate an arbitrary new display with a verified Cast+ display."""
        ids = []
        lines = raw.splitlines()
        for i, line in enumerate(lines):
            if "CastPlusDisplay" not in line:
                continue
            nearby = "\n".join(lines[max(0, i - 5):min(len(lines), i + 4)])
            if not re.search(r"\btype\s*(?:=|:|\s)\s*(?:VIRTUAL|5)\b", nearby, re.I):
                continue
            match = re.search(r"\bdisplayId\s*(?:=|:|\s)\s*(\d+)", line)
            if match:
                ids.append(int(match.group(1)))
                continue
            earlier = "\n".join(lines[max(0, i - 12):i+1])
            candidates = re.findall(r"\bDisplay\s+(\d+)\s*:", earlier)
            if candidates:
                ids.append(int(candidates[-1]))
        ids = sorted(set(x for x in ids if 0 < x <= 255))
        new = sorted(set(ids) - set(before))
        return {"verified": bool(ids), "display_id": (new or ids)[-1] if ids else None,
                "display_ids": ids, "name": "CastPlusDisplay" if ids else None,
                "type": "VIRTUAL" if ids else None}

    def cast_scan(self, serial):
        scan = self.scan(serial)
        scan["cast_display"] = scan.get("cast_display") or self._cast_info(scan["display_excerpt"])
        scan["cast_mode"] = self._cmd(serial, "getprop", "hw.pc.cast.mode")
        scan["selected_proj_mode"] = self._mode(serial)
        return scan

    def _start_helper(self, serial):
        response = self._cast_adb(serial, "shell", "am", "start-foreground-service",
                                  "-n", COMPONENT, "-a", PACKAGE + ".START")
        if "Error:" in response or "Exception" in response:
            raise CastError("测试辅助服务启动失败：" + response[:280])
        return response

    def _stop_helper(self, serial):
        return self._cast_adb(serial, "shell", "am", "stopservice", "-n", COMPONENT)

    def _observe_helper(self, serial, before=()):
        # A bounded check only while the user explicitly starts/recreates a display.
        result = None
        for _ in range(5):
            result = self.cast_scan(serial)
            if result["cast_display"]["verified"]:
                break
            time.sleep(0.35)
        if result["cast_display"]["verified"]:
            result["cast_display"] = self._cast_info(result["display_excerpt"], before)
        return result

    def cast_create(self, device_id, serial):
        with self.lock:
            if device_id in self.pending or device_id in self.cast_pending:
                raise CastError("本设备已有待恢复实验，请先恢复再创建 Cast+ 屏幕")
            if not self.cast_apk.is_file():
                raise CastError("尚未提供测试辅助 APK：请构建 castplus-helper，并放入 data/storage/castplus-lab.apk")
            original = self._mode(serial)
            if not SAFE_MODE.fullmatch(original):
                raise CastError("无法安全备份原始桌面模式设置；未执行修改")
            before = self.scan(serial)["display_ids"]
            record = {"serial": serial, "previous_mode": original, "applied_mode": None}
            self.cast_pending[device_id] = record
            try:
                self._save_cast()  # Persist before any installation or device change.
            except OSError:
                del self.cast_pending[device_id]
                raise CastError("无法保存原始状态，未操作手机") from None
            try:
                install = self._cast_adb(serial, "install", "-r", str(self.cast_apk), timeout=90)
                if "Success" not in install:
                    raise CastError("测试辅助 APK 安装结果不明确：" + install[:220])
                self._start_helper(serial)
                result = self._observe_helper(serial, before)
                result["pending_castplus"] = record
                self._log(device_id, "华为 B1", serial, "Cast+ 创建尝试：" + str(result["cast_display"]))
                return result
            except Exception:
                self._log(device_id, "华为 B1", serial, "失败或状态不明确；保留恢复记录")
                raise

    def cast_auto(self, device_id, serial):
        with self.lock:
            record = self.cast_pending.get(device_id)
            if not record or record["serial"] != serial:
                raise CastError("请先在当前线路执行华为 B1")
            current = self._mode(serial)
            allowed = {record["previous_mode"], record.get("applied_mode")}
            if current not in allowed:
                raise CastError("模式设置已由其他操作改变；拒绝覆盖")
            before = self.scan(serial)["display_ids"]
            record["applied_mode"] = "1"
            self._save_cast()  # Remember restoration requirement before applying setting.
            self._cmd(serial, "settings", "put", "secure", "selected-proj-mode", "1")
            if self._mode(serial) != "1":
                raise CastError("设备拒绝 selected-proj-mode=1；保留恢复记录")
            self._stop_helper(serial)
            self._start_helper(serial)
            result = self._observe_helper(serial, before)
            result["pending_castplus"] = record
            self._log(device_id, "华为 B2", serial,
                      "重新创建 Cast+；当前模式 " + result["selected_proj_mode"] +
                      "，Display：" + str(result["cast_display"]))
            return result

    def cast_switch(self, device_id, serial):
        with self.lock:
            record = self.cast_pending.get(device_id)
            if not record or record["serial"] != serial:
                raise CastError("请先在当前线路执行华为 B1")
            result = self.cast_scan(serial)
            if not result["cast_display"]["verified"]:
                raise CastError("未验证到 Type 5 CastPlusDisplay，禁止发送模式切换广播")
            if result["cast_mode"].lower() == "true":
                result["switch_result"] = "already_active"
                return result
            response = self._cast_adb(serial, "shell", "am", "broadcast", "-a", SWITCH_ACTION)
            result = self.cast_scan(serial)
            denied = any(term in response for term in ("Permission Denial", "SecurityException", "not allowed"))
            result["switch_result"] = "permission_denied" if denied else "broadcast_sent_unverified"
            result["broadcast_response"] = response[:450]
            self._log(device_id, "华为 B3", serial, result["switch_result"] + "；" + response[:180])
            return result

    def cast_verify(self, device_id, serial):
        with self.lock:
            result = self.cast_scan(serial)
            services = self._cmd(serial, "dumpsys", "activity", "services", timeout=18)
            result["pc_services_observed"] = {
                "systemui": "com.huawei.systemui.SystemUIService" in services,
                "explorer": "com.huawei.filemanager.services.ExplorerService" in services,
            }
            result["pc_mode_evidence"] = (
                result["cast_display"]["verified"] and result["cast_mode"].lower() == "true"
                and all(result["pc_services_observed"].values()))
            result["note"] = ("仅为系统证据；最终仍需在所示 Display 使用 scrcpy 预览，"
                              "人工验证任务栏、桌面和独立窗口；不以横屏设置页判定成功。")
            self._log(device_id, "华为 B4", serial, str(result["pc_services_observed"])
                      + "，hw.pc.cast.mode=" + result["cast_mode"])
            return result

    def cast_restore(self, device_id, serial):
        with self.lock:
            record = self.cast_pending.get(device_id)
            if not record:
                raise CastError("没有待恢复的 Cast+ 实验")
            if record["serial"] != serial:
                raise CastError("请切回实验时的原始 ADB 线路后恢复")
            current = self._mode(serial)
            original = record["previous_mode"]
            if current not in {original, record.get("applied_mode")}:
                raise CastError("模式设置已被其他操作改变，拒绝覆盖；保留恢复记录")
            # Stop only this dedicated test helper, never other wireless projection.
            self._stop_helper(serial)
            if current != original:
                if original == "null":
                    self._cmd(serial, "settings", "delete", "secure", "selected-proj-mode")
                else:
                    self._cmd(serial, "settings", "put", "secure", "selected-proj-mode", original)
            if self._mode(serial) != original:
                raise CastError("恢复校验失败；保留恢复记录")
            del self.cast_pending[device_id]
            try:
                self._save_cast()
            except OSError:
                self.cast_pending[device_id] = record
                raise CastError("手机已恢复，但记录落盘失败，请检查磁盘") from None
            self._log(device_id, "华为恢复", serial, "停止专用辅助组件；恢复模式 " + original)
            return {"restored": original, "pending_castplus": None, **self.cast_scan(serial)}
