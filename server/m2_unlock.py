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

PASSWORD_PATTERN = re.compile(r"[A-Za-z0-9]{4,32}\Z")
# Android/EMUI versions differ: TrustManagerService uses deviceLocked=1/0
# on several Android builds (not just true/false). Read the CURRENT user's
# trust state, not a locked work profile or another user.
TRUST_LOCK = re.compile(r"(?<![\w])(?:deviceLocked|mDeviceLocked|isDeviceLocked)\s*[:=]\s*(true|false|1|0)\b", re.I)
WINDOW_LOCK = re.compile(
    r"(?<![\w])(?:mShowingLockscreen|isStatusBarKeyguard|mKeyguardShowing|"
    r"isKeyguardShowing|KeyguardShowing|mKeyguardLocked)\s*[:=]\s*(true|false|1|0)\b", re.I)
DREAM_LOCK = re.compile(r"(?<![\w])mDreamingLockscreen\s*[:=]\s*(true|1)\b", re.I)
KEYGUARD_SECTION = re.compile(
    r"(?im)^\s*(?:KeyguardServiceDelegate|KeyguardStateMonitor)\s*\r?\n"
    r"\s*(?:showing|mIsShowing)\s*[:=]\s*(true|false|1|0)\b")
SIZE_PATTERN = re.compile(r"(?:Physical size|Override size):\s*(\d+)x(\d+)")

def _consensus(values):
    states = {value.lower() in ("true", "1") for value in values}
    return next(iter(states)) if len(states) == 1 else None

def parse_trust_lock(output):
    """Prefer explicit current-user trust state; never use another profile."""
    user_lines = [line for line in output.splitlines()
                  if re.match(r"^\s*User\s+.*\(id=\d+\b", line)]
    current = [line for line in user_lines if re.search(r"\(current\)", line, re.I)]
    if current:
        return _consensus(TRUST_LOCK.findall("\n".join(current)))
    if len(user_lines) > 1:
        return None  # Current user unknown; another user's PIN must not decide.
    return _consensus(TRUST_LOCK.findall("\n".join(user_lines) if user_lines else output))

def parse_window_lock(output):
    """Only keyguard SHOWING is an unlock indicator; secure/configured is not."""
    states = WINDOW_LOCK.findall(output)
    states += KEYGUARD_SECTION.findall(output)
    # DreamingLockscreen=false alone is not proof of unlocked status.
    if DREAM_LOCK.search(output):
        states.append("true")
    return _consensus(states)

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
    """Conservative consensus across AOSP and EMUI services.

    Device-locked=false is authoritative for skipping PIN input. A conflicting
    keyguard signal is ambiguous, not authorization to inject into an app.
    """
    def read(*args):
        try:
            return _run_adb(serial, "shell", "dumpsys", *args, timeout=6)
        except VideoProbeError:
            return ""

    trust = parse_trust_lock(read("trust"))
    # An explicit unlocked TrustManager state never permits PIN injection.
    if trust is False:
        return False
    policy = parse_window_lock(read("window", "policy"))
    if policy is None:
        policy = parse_window_lock(read("window"))
    if trust is True:
        return None if policy is False else True
    return policy

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
    matches = list(SIZE_PATTERN.finditer(size))
    if not matches:
        return "unknown_screen_size"
    width, height = map(int, matches[-1].groups())  # Prefer active override size
    if not (240 <= width <= 10000 and 400 <= height <= 20000):
        return "unknown_screen_size"
    _run_adb(stream.serial, "shell", "input", "swipe", str(width//2),
             str(height*8//10), str(width//2), str(height*3//10), "240", timeout=7)
    sleep(0.45)
    if stream.stop_event.is_set():
        return "skipped"
    # After gesture, never type if unlock happened by biometric/trust/swipe.
    after_swipe = lock_state(stream.serial)
    if after_swipe is False:
        return "already_unlocked"
    if after_swipe is not True:
        return "unknown_after_swipe"
    stream.send_text({"type": "input_text", "session_id": stream.session_id, "text": password})
    sleep(0.18)
    if stream.stop_event.is_set():
        return "skipped"
    stream.send_nav({"type": "nav_key", "session_id": stream.session_id, "key": "enter"})
    return "submitted"  # Android/OEM acceptance cannot be asserted from socket write
