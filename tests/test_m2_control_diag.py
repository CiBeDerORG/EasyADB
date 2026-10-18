"""HyperOS/Xiaomi-compatible diagnostic is passive and session-local."""
import os
import tempfile

from server.m2_control_diag import classify_control_log
from server.m2_live import LiveVideo


def test_control_denial_classifies_only_input_permission_log():
    assert classify_control_log(
        b"java.lang.SecurityException: Injecting input events requires the caller "
        b"to have the INJECT_EVENTS permission.\n"
    ) == "android_input_permission"
    assert classify_control_log(
        b"Injecting to another application requires INJECT_EVENTS permission"
    ) == "android_input_permission"
    for raw in (
        b"screen frame encoded",
        b"Permission denied: unable to open unrelated display file",
        b"MediaCodec error; output buffer unavailable",
        b"",
        None,
        "INJECT_EVENTS",  # no unvalidated text input
    ):
        assert classify_control_log(raw) is None


def test_session_diagnostics_reads_only_owned_log_after_explicit_control(tmp_path):
    stream = LiveVideo("manual-selection:5555", "economy",
                       server_file=tmp_path / "unused.jar")
    with tempfile.TemporaryFile(mode="w+b") as log:
        log.write(b"device connected; video works\n")
        log.write(b"java.lang.SecurityException: Injecting input events requires "
                  b"INJECT_EVENTS permission\n")
        log.flush()
        with stream._resource_lock:
            stream._adb_log_fd = os.dup(log.fileno())
        try:
            # The video stream alone must never imply a refused input.
            assert stream.diagnostics()["control_warning"] is None
            with stream._touch_lock:
                stream._control_attempted = True
            result = stream.diagnostics()
            assert result["control_warning"] == "android_input_permission"
            assert "raw_log" not in result
            assert "INJECT_EVENTS" not in str(result)
            # Finding is stable; no Android command, logcat or background poll.
            assert stream.diagnostics()["control_warning"] == "android_input_permission"
        finally:
            with stream._resource_lock:
                fd = stream._adb_log_fd
                stream._adb_log_fd = None
                os.close(fd)
    assert stream.diagnostics()["control_warning"] == "android_input_permission"
