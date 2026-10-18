"""Classify only fixed scrcpy Android-side input-denial markers.

The Android shell log is private to a manually started live session. Never
return its raw bytes (which may contain unrelated device data) to the browser.
A successful TCP control write does not prove Android accepted the event.
"""


def classify_control_log(data):
    if not isinstance(data, bytes):
        return None
    sample = data[-32768:].lower()
    if (b"inject_events" in sample
            or b"injecting input events requires" in sample
            or b"injecting to another application requires" in sample
            or b"permission denied" in sample and b"inject" in sample
            or b"securityexception" in sample and b"inject" in sample):
        return "android_input_permission"
    return None
