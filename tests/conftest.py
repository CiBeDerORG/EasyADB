"""Controlled WebRTC negotiation for existing live lifecycle contract tests.

The transport itself has separate aiortc and browser-peer tests. Legacy mock
session tests must still exercise stop/cleanup/control after authenticated SDP.
Only tests that already use fake streams opt into this fixture.
"""
import time
from types import SimpleNamespace

import pytest


OFFER = (
    "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n"
    "m=video 9 UDP/TLS/RTP/SAVPF 102\r\nc=IN IP4 0.0.0.0\r\n"
    "a=recvonly\r\na=rtpmap:102 H264/90000\r\n"
)


class FakePeer:
    """No sockets/ICE: transports are tested separately in test_m2_webrtc."""
    def __init__(self, config):
        self.config = config
        self.connectionState = "new"
        self.localDescription = None
        self.sender = None
        self.callback = None

    def addTrack(self, track):
        self.sender = object()
        return self.sender

    def getTransceivers(self):
        return [SimpleNamespace(sender=self.sender,
                                setCodecPreferences=lambda codecs: None)]

    def on(self, event):
        def register(callback):
            self.callback = callback
            return callback
        return register

    async def setRemoteDescription(self, description):
        self.remoteDescription = description

    async def createAnswer(self):
        return SimpleNamespace(type="answer", sdp=OFFER.replace("recvonly", "sendonly"))

    async def setLocalDescription(self, answer):
        self.localDescription = answer

    async def close(self):
        self.connectionState = "closed"


# These tests exercise application/session lifecycles with their own FakeStream
# and previously used an implicit MSE start. The fixture sends an explicit SDP
# after 'starting' and hides only the fake transport's answer from those tests.
LEGACY_LIFECYCLE_MODULES = {
    "test_m2_adb_disconnect", "test_m2_disconnect", "test_m2_keys",
    "test_m2_lifecycle", "test_m2_live", "test_m2_multi",
    "test_m2_quality", "test_m2_screen_power", "test_m2_touch", "test_m2_unlock",
}


@pytest.fixture(autouse=True)
def negotiate_mock_webrtc_for_legacy_lifecycle_tests(request, monkeypatch):
    if request.module.__name__.split(".")[-1] not in LEGACY_LIFECYCLE_MODULES:
        return
    import aiortc
    from starlette.testclient import WebSocketTestSession

    monkeypatch.setattr(aiortc, "RTCPeerConnection", FakePeer)
    original_receive = WebSocketTestSession.receive_json

    def receive_with_offer(self, *args, **kwargs):
        while True:
            message = original_receive(self, *args, **kwargs)
            if isinstance(message, dict) and message.get("type") == "starting":
                self.send_json({
                    "type": "webrtc_offer", "session_id": message["session_id"],
                    "sdp": OFFER,
                })
            if isinstance(message, dict) and message.get("type") == "webrtc_answer":
                continue
            return message

    monkeypatch.setattr(WebSocketTestSession, "receive_json", receive_with_offer)
