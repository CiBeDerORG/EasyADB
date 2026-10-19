"""A/B display lab: no device required; fake ADB verifies selected-serial isolation."""
from types import SimpleNamespace

import pytest

from server.display_lab import DisplayLab, LabError, OVERLAY, display_ids


class FakeADB:
    def __init__(self):
        self.setting = "null"
        self.calls = []
        self.displays = "Logical Displays:\\n  Display 0:\\n  Display 2: mDisplayId=2"

    def __call__(self, *args, timeout=12):
        self.calls.append(args)
        assert args[:3] == ("-s", "chosen:5555", "shell")
        command = args[3:]
        if command == ("settings", "get", "global", "overlay_display_devices"):
            value = self.setting
        elif command[:4] == ("settings", "put", "global", "overlay_display_devices"):
            self.setting = command[4]
            value = ""
        elif command == ("settings", "delete", "global", "overlay_display_devices"):
            self.setting = "null"
            value = ""
        elif command == ("dumpsys", "display"):
            value = self.displays
        elif command == ("getprop", "ro.build.version.sdk"):
            value = "29"
        elif command == ("getprop", "ro.build.version.release"):
            value = "10"
        else:
            raise AssertionError("Unexpected ADB shell operation: " + repr(command))
        return SimpleNamespace(returncode=0, stdout=value, stderr="")


def test_display_ids_are_dynamic_and_bounded():
    assert display_ids("Logical Displays:\\n  Display 0:\\n  mDisplayId=4\\n Display 9:") == [0, 4, 9]
    assert display_ids("No display data") == [0]


def test_b1_b2_backup_restore_and_restart(tmp_path):
    adb = FakeADB()
    path = tmp_path / "lab.json"
    lab = DisplayLab(adb, path)
    env = lab.environment("mate", "chosen:5555")
    assert env["api_level"] == "29"
    assert env["display_ids"] == [0, 2]
    result = lab.enable_overlay("mate", "chosen:5555")
    assert not result["unchanged"]
    assert adb.setting == OVERLAY and path.exists()
    assert lab.has_pending("mate")
    with pytest.raises(LabError, match="待恢复"):
        lab.enable_overlay("mate", "chosen:5555")
    again = DisplayLab(adb, path)
    assert again.has_pending("mate")
    with pytest.raises(LabError, match="原始设备线路"):
        again.restore("mate", "different:5555")
    restored = again.restore("mate", "chosen:5555")
    assert restored["restored"] == "null"
    assert adb.setting == "null"
    assert not DisplayLab(adb, path).has_pending("mate")
    assert ("-s", "chosen:5555", "shell", "settings", "delete", "global",
            "overlay_display_devices") in adb.calls


def test_manual_changes_are_not_overwritten(tmp_path):
    adb = FakeADB()
    lab = DisplayLab(adb, tmp_path / "record.json")
    lab.enable_overlay("mate", "chosen:5555")
    adb.setting = "1280x720/200"
    with pytest.raises(LabError, match="其他操作"):
        lab.restore("mate", "chosen:5555")
    assert lab.has_pending("mate")
    assert adb.setting == "1280x720/200"


def test_existing_identical_overlay_not_owned_or_deleted(tmp_path):
    adb = FakeADB()
    adb.setting = OVERLAY
    lab = DisplayLab(adb, tmp_path / "record.json")
    assert lab.enable_overlay("mate", "chosen:5555")["unchanged"]
    assert not lab.has_pending("mate")
    assert not any(call[3:5] == ("settings", "delete") for call in adb.calls)
