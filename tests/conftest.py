"""WebRTC signaling harness for device/control regression tests.

Only tests with fake LiveVideo workers use this peer, and real WebRTC
packetization/peer cleanup tests remain unmodified in test_m2_webrtc.py.
"""
import pytest

_MOCK_SESSION_MODULES = {
    "test_m2_adb_disconnect", "test_m2_disconnect", "test_m2_keys",
    "test_m2_lifecycle", "test_m2_multi", "test_m2_quality",
    "test_m2_screen_power", "test_m2_touch", "test_m2_unlock",
}


@pytest.fixture(autouse=True)
def fake_webrtc_signaling_for_mock_sessions(request, monkeypatch):
    if request.module.__name__.split(".")[-1] not in _MOCK_SESSION_MODULES:
        return

    import aiortc
    from starlette.testclient import WebSocketTestSession

    class FakePeer:
        connectionState = "connected"
        def __init__(self, config):
            self.localDescription = None
            self._sender = None
        def addTrack(self, track):
            self._sender = object()
            return self._sender
        def getTransceivers(self):
            return [type("Transceiver", (), {
                "sender": self._sender, "setCodecPreferences": lambda self, codecs: None
            })()]
        def on(self, event):
            return lambda callback: callback
        async def setRemoteDescription(self, description):
            assert description.type == "offer"
        async def createAnswer(self):
            return aiortc.RTCSessionDescription(sdp="v=0\r\n", type="answer")
        async def setLocalDescription(self, answer):
            self.localDescription = answer
        async def close(self):
            self.connectionState = "closed"

    monkeypatch.setattr(aiortc, "RTCPeerConnection", FakePeer)

    actual_send = WebSocketTestSession.send_json
    actual_recv = WebSocketTestSession.receive_json

    def send(self, data, mode="text"):
        if isinstance(data, dict) and "token" in data:
            self._v2_mock_signaling = data.get("player", "webrtc") == "webrtc"
            self._v2_mock_offer_sent = False
        return actual_send(self, data, mode=mode)

    def recv(self, mode="text"):
        while True:
            message = actual_recv(self, mode=mode)
            if isinstance(message, dict) and message.get("type") == "starting" and getattr(self, "_v2_mock_signaling", False):
                session = message["session_id"]
                offer = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=recvonly\r\n" + ("a=mock:abcdefgh\r\n" * 8)
                actual_send(self, {"type": "webrtc_offer", "session_id": session, "sdp": offer})
                self._v2_mock_offer_sent = True
            if isinstance(message, dict) and message.get("type") == "webrtc_answer" and getattr(self, "_v2_mock_offer_sent", False):
                continue
            return message

    monkeypatch.setattr(WebSocketTestSession, "send_json", send)
    monkeypatch.setattr(WebSocketTestSession, "receive_json", recv)
