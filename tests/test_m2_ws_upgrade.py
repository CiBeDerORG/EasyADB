"""Real Uvicorn TCP upgrade smoke test (TestClient alone cannot detect missing WS backend)."""
import base64
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]


def _upgrade(port, origin):
    key = base64.b64encode(bytes(range(16))).decode("ascii")
    with socket.create_connection(("127.0.0.1", port), timeout=4) as sock:
        sock.settimeout(4)
        request = (
            "GET /api/devices/not-a-device/m2/live HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{port}\r\n"
            "Connection: Upgrade\r\n"
            "Upgrade: websocket\r\n"
            f"Origin: {origin}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "\r\n"
        )
        sock.sendall(request.encode("ascii"))
        received = bytearray()
        while b"\r\n\r\n" not in received and len(received) < 16384:
            part = sock.recv(4096)
            if not part:
                break
            received.extend(part)
        return received.decode("latin-1")


def test_real_uvicorn_supports_websocket_upgrade_in_minimal_docker_dependencies(tmp_path):
    # Use a real TCP listener + Uvicorn --ws auto, not ASGI in-process mocks.
    # Before wsproto was declared in requirements, this request returned 404,
    # 400 or 426 rather than the required 101 Switching Protocols.
    with socket.socket() as holder:
        holder.bind(("127.0.0.1", 0))
        port = holder.getsockname()[1]
    env = os.environ.copy()
    env["EASYADB_TOKEN"] = "local-test-token-123"
    env["EASYADB_DB"] = str(tmp_path / "ws-upgrade.sqlite3")
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "server.app:app",
         "--host", "127.0.0.1", "--port", str(port), "--ws", "auto",
         "--log-level", "warning"],
        cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                pytest.fail("Uvicorn terminated before the WebSocket TCP test")
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                    break
            except OSError:
                time.sleep(0.1)
        else:
            pytest.fail("Uvicorn did not start listening in time")
        response = _upgrade(port, f"http://127.0.0.1:{port}")
        assert response.startswith("HTTP/1.1 101 "), response[:500]
        assert "upgrade: websocket" in response.lower()
        # Origin guard is still effective and must deny cross-site WS attempts.
        denied = _upgrade(port, "http://untrusted.invalid")
        assert denied.startswith("HTTP/1.1 403 "), denied[:500]
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=2)
