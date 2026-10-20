"""Opt-in per-device lock-screen credential and bounded startup unlock.

Only ASCII alphanumeric PIN/passwords. Credentials are encrypted with a
machine-local Fernet key, never included in ordinary device snapshots or logs.
"""
import os
import re
import time
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

from .m2_touch import InvalidTouch
from .m2_video_probe import _run_adb, VideoProbeError

PASSWORD_PATTERN = re.compile(r"[A-Za-z0-9]{4,32}\\Z")
LOCKED_PATTERN = re.compile(r"(?:deviceLocked|mDeviceLocked|isDeviceLocked|mShowingLockscreen|isStatusBarKeyguard|mKeyguardShowing)\\s*[:=]\\s*true\\b", re.I)
UNLOCKED_PATTERN = re.compile(r"(?:deviceLocked|mDeviceLocked|isDeviceLocked|mShowingLockscreen|isStatusBarKeyguard|mKeyguardShowing)\\s*[:=]\\s*false\\b", re.I)
SIZE_PATTERN = re.compile(r"(?:Physical size|Override size):\\s*(\\d+)x(\\d+)")

def validate_password(value):
    if type(value) is not str or not PASSWORD_PATTERN.fullmatch(value):
        raise ValueError("仅支持 4～32 位英文数字开屏密码（PIN 也适用）")
    return value

def cipher_for(db_path):
    key_path = Path(str(db_path) + ".unlock.key")
    key_path.parent.mkdir(parents=True, exist_ok=True)
    if not key_path.exists():
        try:
            descriptor = os.open(str(key_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            pass
        else:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(Fernet.generate_key())
    if key_path.is_symlink():
        raise RuntimeError("不允许符号链接作为开屏密钥文件")
    key = key_path.read_bytes().strip()
    return Fernet(key)

def encrypt_password(db_path, password):
    return cipher_for(db_path).encrypt(validate_password(password).encode("ascii")).decode("ascii")

def decrypt_password(db_path, ciphertext):
    try:
        return validate_password(cipher_for(db_path).decrypt(ciphertext.encode("ascii")).decode("ascii"))
    except (InvalidToken, UnicodeError, ValueError) as exc:
        raise ValueError("开屏密码密文无效或本机密钥已变化，请重新配置") from exc

def lock_state(serial):
    """Fail closed on ambiguous OEM output: never inject into an unlocked app."""
    for args in (("dumpsys", "trust"), ("dumpsys", "window", "policy")):
        output = _run_adb(serial, "shell", *args, timeout=6)
        locked = bool(LOCKED_PATTERN.search(output))
        unlocked = bool(UNLOCKED_PATTERN.search(output))
        if locked != unlocked:
            return locked
    return None

def automatic_unlock(stream, password, *, sleep=time.sleep):
    """Single attempt per explicitly started, primary-screen session.

    Uses scrcpy's session control socket for secret text: no PIN in process argv,
    shell command, WebSocket payload, exception or browser log.
    """
    validate_password(password)
    if stream.stop_event.is_set() or stream.display_source:
        return "skipped"
    stream.wake_display()  # idempotent WAKEUP, not POWER toggle
    sleep(0.5)
    if stream.stop_event.is_set():
        return "skipped"
    state = lock_state(stream.serial)
    if state is False:
        return "already_unlocked"
    if state is None:
        return "unknown_lock_state"
    size = _run_adb(stream.serial, "shell", "wm", "size", timeout=6)
    match = SIZE_PATTERN.search(size)
    if not match:
        return "unknown_screen_size"
    width, height = map(int, match.groups())
    if not (240 <= width <= 10000 and 400 <= height <= 20000):
        return "unknown_screen_size"
    _run_adb(stream.serial, "shell", "input", "swipe", str(width//2),
             str(height*8//10), str(width//2), str(height*3//10), "240", timeout=7)
    sleep(0.45)
    if stream.stop_event.is_set():
        return "skipped"
    # After gesture, require an affirmative locked state before sending secret.
    if lock_state(stream.serial) is not True:
        return "unknown_lock_state"
    stream.send_text({"type": "input_text", "session_id": stream.session_id, "text": password})
    sleep(0.18)
    if stream.stop_event.is_set():
        return "skipped"
    stream.send_nav({"type": "nav_key", "session_id": stream.session_id, "key": "enter"})
    return "submitted"  # Android/OEM acceptance cannot be asserted from socket write
