"""Explicit, read-only M2 capability preflight for the selected ADB serial.

This is *not* a scrcpy session or a promise that video decoding will work.
Never connects, switches routes, installs APKs, starts a daemon or forwards ports.
"""
import re


def inspect_device(serial, run_adb):
    """Return the smallest useful facts for choosing a pinned scrcpy build."""
    def shell(*args):
        result = run_adb("-s", serial, "shell", *args, timeout=6)
        if result.returncode != 0:
            return None
        value = result.stdout.strip()
        return value[:160] or None

    sdk_text = shell("getprop", "ro.build.version.sdk")
    abi = shell("getprop", "ro.product.cpu.abi")
    model = shell("getprop", "ro.product.model")
    display = shell("wm", "size")
    sdk = int(sdk_text) if sdk_text and re.fullmatch(r"[0-9]{1,3}", sdk_text) else None
    # Do not infer codec/encoder or real scrcpy support from Android API alone.
    return {
        "selected_serial": serial,
        "android_sdk": sdk,
        "cpu_abi": abi,
        "model": model,
        "display_size": display,
        "adb_connected": True,
        "stream_verified": False,
        "note": "基础 ADB 信息已读取；尚未启动或验证实时视频流",
    }
