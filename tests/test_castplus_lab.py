"""Huawei B-group is an opt-in hypothesis: never equate a broadcast or landscape with PC mode."""
from types import SimpleNamespace

import pytest

from server.display_lab import DisplayLab
from server.castplus_lab import CastError


class FakeADB:
    def __init__(self):
        self.serial = "chosen:5555"
        self.mode = "0"
        self.running = False
        self.permission_denied = False
        self.pc_mode = "false"
        self.installed = True
        self.stop_missing_returns_error = False
        self.stop_denied = False
        self.create_display = True
        self.calls = []

    def __call__(self, *args, timeout=12):
        self.calls.append(args)
        assert args[:2] == ("-s", self.serial)
        cmd = args[2:]
        result = ""
        if cmd == ("shell", "settings", "get", "secure", "selected-proj-mode"):
            result = self.mode
        elif cmd[:5] == ("shell", "settings", "put", "secure", "selected-proj-mode"):
            self.mode = cmd[5]
        elif cmd == ("shell", "settings", "delete", "secure", "selected-proj-mode"):
            self.mode = "null"
        elif cmd == ("shell", "dumpsys", "display"):
            result = ("Logical Displays:\n Display 0: mDisplayId=0\n"
                      + (' Display 3: mDisplayId=3\n'
                         '  DisplayInfo{"CastPlusDisplay", displayId 3, type VIRTUAL}\n'
                         if self.running and self.create_display else ""))
        elif cmd[:2] == ("install", "-r"):
            result = "Success"
        elif cmd == ("shell", "am", "start-foreground-service", "-n",
                     "com.easyadb.castpluslab/.CastPlusService",
                     "-a", "com.easyadb.castpluslab.START"):
            self.running = True
            result = "Starting service"
        elif cmd == ("shell", "am", "stopservice", "-n",
                     "com.easyadb.castpluslab/.CastPlusService"):
            if self.stop_denied:
                return SimpleNamespace(returncode=1, stdout="",
                                       stderr="Permission Denial: stop service")
            if not self.running and self.stop_missing_returns_error:
                return SimpleNamespace(returncode=1,
                                       stdout="Service not stopped: was not running.",
                                       stderr="")
            self.running = False
            result = "Stopping service"
        elif cmd == ("shell", "am", "broadcast", "-a",
                     "com.android.server.pc.action.SWITCH_MODE"):
            result = ("Permission Denial: com.huawei.permission.SWITCH_MODE"
                      if self.permission_denied else "Broadcast completed")
        elif cmd == ("shell", "pm", "path", "com.easyadb.castpluslab"):
            result = ("package:/data/app/com.easyadb.castpluslab/base.apk"
                      if self.installed else "")
        elif cmd == ("shell", "getprop", "hw.pc.cast.mode"):
            result = self.pc_mode
        elif cmd[:2] == ("shell", "getprop"):
            result = "1"
        elif cmd == ("shell", "dumpsys", "activity", "services"):
            result = ("com.huawei.systemui.SystemUIService\n"
                      "com.huawei.filemanager.services.ExplorerService") if self.pc_mode == "true" else ""
        else:
            raise AssertionError("Unexpected ADB command: " + repr(cmd))
        return SimpleNamespace(returncode=0, stdout=result, stderr="")


def prepare(tmp_path):
    adb = FakeADB()
    lab = DisplayLab(adb, tmp_path / "display-lab.json")
    lab.cast_apk.write_bytes(b"mock-helper-apk")
    return adb, lab


def test_castplus_create_mode_recreate_verify_and_restore(tmp_path):
    adb, lab = prepare(tmp_path)
    made = lab.cast_create("mate", adb.serial)
    assert made["cast_display"] == {
        "verified": True, "display_id": 3, "display_ids": [3],
        "name": "CastPlusDisplay", "type": "VIRTUAL"}
    assert made["cast_mode"] == "false"
    assert lab.has_pending("mate")
    assert (tmp_path / "display-lab.json.castplus").exists()
    with pytest.raises(CastError, match="待恢复"):
        lab.cast_create("mate", adb.serial)
    auto = lab.cast_auto("mate", adb.serial)
    assert adb.mode == "1" and auto["cast_display"]["verified"]
    adb.permission_denied = True
    assert lab.cast_switch("mate", adb.serial)["switch_result"] == "permission_denied"
    assert not lab.cast_verify("mate", adb.serial)["pc_mode_evidence"]
    adb.pc_mode = "true"
    assert lab.cast_switch("mate", adb.serial)["switch_result"] == "already_active"
    assert lab.cast_verify("mate", adb.serial)["pc_mode_evidence"]
    recovered = DisplayLab(adb, tmp_path / "display-lab.json")
    assert recovered.has_pending("mate")
    with pytest.raises(CastError, match="原始 ADB"):
        recovered.cast_restore("mate", "other:5555")
    result = recovered.cast_restore("mate", adb.serial)
    assert result["restored"] == "0" and not adb.running
    assert adb.mode == "0" and not recovered.has_pending("mate")


def test_absent_apk_and_external_setting_change_fail_closed(tmp_path):
    adb = FakeADB()
    lab = DisplayLab(adb, tmp_path / "display-lab.json")
    with pytest.raises(CastError, match="辅助 APK"):
        lab.cast_create("mate", adb.serial)
    assert not lab.has_pending("mate")
    lab.cast_apk.write_bytes(b"mock")
    lab.cast_create("mate", adb.serial)
    lab.cast_auto("mate", adb.serial)
    adb.mode = "99"
    with pytest.raises(CastError, match="其他操作"):
        lab.cast_restore("mate", adb.serial)
    assert lab.has_pending("mate") and adb.running


def test_name_alone_or_unrelated_virtual_display_not_success():
    from server.castplus_lab import CastPlusMixin
    assert not CastPlusMixin._cast_info('Display 7: mDisplayId=7\n  DisplayInfo{"Other", displayId 7, type VIRTUAL}')["verified"]
    assert not CastPlusMixin._cast_info('Display 3: mDisplayId=3\n  DisplayInfo{"CastPlusDisplay", displayId 3, type OVERLAY}')["verified"]
    assert CastPlusMixin._cast_info('Display 3: mDisplayId=3\n  DisplayInfo{"CastPlusDisplay", displayId 3, type VIRTUAL}')["display_id"] == 3


def test_manually_installed_helper_can_run_b2_without_b1_or_nas_apk(tmp_path):
    adb = FakeADB()
    lab = DisplayLab(adb, tmp_path / "manual.json")
    assert not lab.cast_apk.is_file()
    assert lab.cast_capabilities(adb.serial)["helper_installed"]
    outcome = lab.cast_auto("mate", adb.serial)
    assert outcome["cast_display"]["verified"]
    assert outcome["pending_castplus"]["previous_mode"] == "0"
    assert outcome["pending_castplus"]["applied_mode"] == "1"
    assert adb.mode == "1"
    assert not any(call[2:4] == ("install", "-r") for call in adb.calls)
    restarted = DisplayLab(adb, tmp_path / "manual.json")
    assert restarted.has_pending("mate")
    assert restarted.cast_restore("mate", adb.serial)["restored"] == "0"
    assert adb.mode == "0" and not restarted.has_pending("mate")


def test_manual_b2_missing_helper_fails_without_changing_mode(tmp_path):
    adb = FakeADB()
    adb.installed = False
    lab = DisplayLab(adb, tmp_path / "manual.json")
    assert not lab.cast_capabilities(adb.serial)["helper_installed"]
    with pytest.raises(CastError, match="安装"):
        lab.cast_auto("mate", adb.serial)
    assert adb.mode == "0"
    assert not lab.has_pending("mate")
    assert not (tmp_path / "manual.json.castplus").exists()


def test_manual_b3_requires_real_cast_display_but_not_b1_record(tmp_path):
    adb = FakeADB()
    lab = DisplayLab(adb, tmp_path / "manual.json")
    with pytest.raises(CastError, match="Type 5"):
        lab.cast_switch("mate", adb.serial)
    adb.running = True  # Manually launched installed auxiliary service.
    adb.permission_denied = True
    result = lab.cast_switch("mate", adb.serial)
    assert result["switch_result"] == "permission_denied"
    assert not lab.has_pending("mate")  # A broadcast alone owns no mode changes.
    assert adb.mode == "0"
    assert not any(call[2:4] == ("install", "-r") for call in adb.calls)


def test_manual_b2_preserves_foreign_recovery_record_and_serial(tmp_path):
    adb = FakeADB()
    lab = DisplayLab(adb, tmp_path / "manual.json")
    lab.pending["mate"] = {"serial": adb.serial, "previous": "null", "applied": "1920x1080/240"}
    with pytest.raises(CastError, match="Overlay"):
        lab.cast_auto("mate", adb.serial)
    assert not lab.cast_pending
    lab.pending.clear()
    lab.cast_auto("mate", adb.serial)
    with pytest.raises(CastError, match="原始 ADB"):
        lab.cast_auto("mate", "other:5555")



def test_b2_accepts_stopservice_was_not_running_with_nonzero_exit(tmp_path):
    # This is Android's normal response after an APK was installed manually.
    adb = FakeADB()
    adb.stop_missing_returns_error = True
    lab = DisplayLab(adb, tmp_path / "manual.json")
    result = lab.cast_auto("mate", adb.serial)
    assert result["helper_stop_result"] == "already_stopped"
    assert result["cast_display"]["verified"]
    assert adb.running
    assert lab.cast_switch("mate", adb.serial)["switch_result"] == "broadcast_sent_unverified"
    # The stop helper is shared with restoration; repeated stop is safe too.
    adb.running = False
    assert lab.cast_restore("mate", adb.serial)["restored"] == "0"
    assert not lab.has_pending("mate")


def test_b2_other_stopservice_failures_still_abort_and_preserve_recovery(tmp_path):
    adb = FakeADB()
    adb.stop_denied = True
    lab = DisplayLab(adb, tmp_path / "manual.json")
    with pytest.raises(CastError, match="Permission Denial"):
        lab.cast_auto("mate", adb.serial)
    assert adb.mode == "1"  # Restore record was written before the mode change.
    assert lab.cast_pending["mate"]["previous_mode"] == "0"
    assert lab.cast_pending["mate"]["applied_mode"] == "1"
    assert not adb.running
    assert not any(c[2:5] == ("shell", "am", "start-foreground-service")
                   for c in adb.calls)


def test_b2_missing_display_is_reported_without_claiming_success(tmp_path):
    adb = FakeADB()
    adb.create_display = False
    lab = DisplayLab(adb, tmp_path / "manual.json")
    outcome = lab.cast_auto("mate", adb.serial)
    assert not outcome["cast_display"]["verified"]
    assert "不要直接执行 B3" in outcome["note"]
    assert lab.has_pending("mate")
    with pytest.raises(CastError, match="Type 5"):
        lab.cast_switch("mate", adb.serial)
    assert not any(c[2:5] == ("shell", "am", "broadcast") for c in adb.calls)
