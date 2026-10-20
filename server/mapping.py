"""M1 test-only mapping: one same-process viewer per enabled live WebRTC stream.

This router intentionally exposes NO admin routes, tokens or device inventory.
It has no public authentication: bind it to a trusted interface only until M2.
"""
import asyncio
import secrets
import threading
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response


class MappingRegistry:
    def __init__(self):
        self.lock = threading.RLock()
        self.by_device = {}
        self.by_id = {}

    def enable(self, device_id, stream):
        with self.lock:
            old = self.by_device.get(device_id)
            if old and old["active"] and old["stream"] is stream:
                return old
            if old:
                self._disable(old)
            if (stream.stop_event.is_set() or stream.finished.is_set()
                    or stream.webrtc_relay is None or stream.mapping_init is None):
                raise ValueError("请等待 WebRTC 实时画面初始化后再开启映射")
            record = {"id": secrets.token_urlsafe(18), "device_id": device_id,
                      "stream": stream, "session_id": stream.session_id,
                      "active": True, "ended": asyncio.Event(), "viewer": False}
            self.by_device[device_id] = record
            self.by_id[record["id"]] = record
            return record

    def _disable(self, record):
        record["active"] = False
        self.by_id.pop(record["id"], None)
        if self.by_device.get(record["device_id"]) is record:
            self.by_device.pop(record["device_id"], None)
        record["ended"].set()

    def disable_for(self, device_id, stream=None):
        with self.lock:
            record = self.by_device.get(device_id)
            if record and (stream is None or record["stream"] is stream):
                self._disable(record)
                return True
            return False

    def disable_all(self):
        with self.lock:
            for record in list(self.by_device.values()):
                self._disable(record)

    def status(self, device_id, stream=None):
        with self.lock:
            record = self.by_device.get(device_id)
            if not record or not record["active"]:
                return None
            if stream is not None and (record["stream"] is not stream):
                return None
            return record

    def get(self, mapping_id):
        with self.lock:
            record = self.by_id.get(mapping_id)
            if (not record or not record["active"] or record["ended"].is_set()
                    or record["stream"].stop_event.is_set()
                    or record["stream"].finished.is_set()):
                return None
            return record

    def acquire_viewer(self, mapping_id):
        with self.lock:
            record = self.get(mapping_id)
            if not record or record["viewer"]:
                return None
            record["viewer"] = True
            return record

    def release_viewer(self, record):
        with self.lock:
            record["viewer"] = False


def build_mapping_app(registry, web_root: Path):
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @app.get("/m/{mapping_id}")
    async def page(mapping_id: str):
        if not registry.get(mapping_id):
            return Response("映射不存在或已关闭", status_code=404, media_type="text/plain")
        return FileResponse(web_root / "mapping.html", headers={"Cache-Control": "no-store",
                            "X-Content-Type-Options": "nosniff"})

    @app.get("/mapping.js")
    async def script():
        return FileResponse(web_root / "mapping.js", media_type="application/javascript",
                            headers={"Cache-Control": "no-store"})

    @app.get("/m2-webrtc.js")
    async def player():
        return FileResponse(web_root / "m2-webrtc.js", media_type="application/javascript",
                            headers={"Cache-Control": "no-store"})

    @app.get("/m2-touch.js")
    async def touch():
        return FileResponse(web_root / "m2-touch.js", media_type="application/javascript",
                            headers={"Cache-Control": "no-store"})

    @app.websocket("/ws/{mapping_id}")
    async def view(ws: WebSocket, mapping_id: str):
        # No cross-site WS embedding, even during the unprotected M1 LAN trial.
        origin, host = ws.headers.get("origin", ""), ws.headers.get("host", "")
        parsed = urlsplit(origin)
        if not host or parsed.scheme not in ("http", "https") or parsed.netloc != host:
            await ws.close(code=1008)
            return
        record = registry.acquire_viewer(mapping_id)
        if not record:
            await ws.close(code=1008)
            return
        stream = record["stream"]
        session = secrets.token_hex(12)
        pc = None
        control_enabled = False
        requested_stop = asyncio.Event()
        try:
            await ws.accept()
            await ws.send_json({"type": "starting", "session_id": session, "player": "webrtc"})
            while not record["ended"].is_set() and not stream.stop_event.is_set():
                message_task = asyncio.create_task(ws.receive_text())
                ended_task = asyncio.create_task(record["ended"].wait())
                done, pending = await asyncio.wait((message_task, ended_task),
                                                    return_when=asyncio.FIRST_COMPLETED)
                for task in pending:
                    task.cancel()
                await asyncio.gather(*pending, return_exceptions=True)
                if ended_task in done or record["ended"].is_set():
                    break
                try:
                    raw = message_task.result()
                except (WebSocketDisconnect, RuntimeError):
                    break
                if raw == "stop":
                    break
                if len(raw) > 32768:
                    break
                import json
                try:
                    msg = json.loads(raw)
                except (ValueError, TypeError):
                    continue
                if not isinstance(msg, dict) or msg.get("session_id") != session:
                    break
                if (not registry.get(mapping_id) or record["stream"] is not stream
                        or stream.stop_event.is_set()):
                    break
                kind = msg.get("type")
                if kind == "webrtc_offer":
                    if (pc is not None or set(msg) != {"type", "session_id", "sdp"}
                            or not isinstance(msg["sdp"], str)
                            or not 100 <= len(msg["sdp"]) <= 24000
                            or "m=video " not in msg["sdp"] or "a=recvonly" not in msg["sdp"]):
                        break
                    try:
                        from aiortc import (RTCPeerConnection, RTCConfiguration,
                                            RTCSessionDescription, RTCRtpSender)
                        pc = RTCPeerConnection(RTCConfiguration(iceServers=[]))
                        sender = pc.addTrack(stream.webrtc_relay.subscribe(stream.webrtc_track))
                        transceiver = next(t for t in pc.getTransceivers() if t.sender is sender)
                        codecs = [c for c in RTCRtpSender.getCapabilities("video").codecs
                                  if c.mimeType.lower() == "video/h264"]
                        if not codecs:
                            raise RuntimeError("H264 unavailable")
                        transceiver.setCodecPreferences(codecs)
                        @pc.on("connectionstatechange")
                        async def on_state():
                            if pc.connectionState in ("failed", "closed"):
                                requested_stop.set()
                                record["ended"].set() if not record["active"] else None
                        await asyncio.wait_for(pc.setRemoteDescription(
                            RTCSessionDescription(sdp=msg["sdp"], type="offer")), 12)
                        answer = await asyncio.wait_for(pc.createAnswer(), 12)
                        await asyncio.wait_for(pc.setLocalDescription(answer), 15)
                        if record["ended"].is_set() or stream.stop_event.is_set():
                            break
                        await asyncio.wait_for(ws.send_json({"type": "webrtc_answer",
                            "session_id": session, "sdp": pc.localDescription.sdp}), 10)
                        await ws.send_json({"type": "init", "session_id": session,
                                            "player": "webrtc", **stream.mapping_init})
                    except Exception:
                        await ws.send_json({"type": "error", "session_id": session,
                                            "message": "映射 WebRTC 协商失败"})
                        break
                elif kind == "heartbeat":
                    if set(msg) != {"type", "session_id"}:
                        break
                elif kind == "control_enable":
                    if set(msg) != {"type", "session_id"} or pc is None or stream.touch_size is None:
                        await ws.send_json({"type": "touch_error", "session_id": session,
                                            "message": "等待映射画面控制通道就绪"})
                        continue
                    control_enabled = True
                    await ws.send_json({"type": "control_enabled", "session_id": session})
                elif kind == "control_disable":
                    control_enabled = False
                    await asyncio.to_thread(stream.release_touch)
                    await ws.send_json({"type": "control_disabled", "session_id": session})
                elif kind == "wake":
                    if set(msg) != {"type", "session_id"} or stream.display_source:
                        continue
                    try:
                        await asyncio.to_thread(stream.wake_display)
                        await ws.send_json({"type": "wake_accepted", "session_id": session})
                    except Exception:
                        await ws.send_json({"type": "wake_error", "session_id": session,
                                            "message": "唤醒失败"})
                elif kind in ("touch", "nav_key", "input_text") and control_enabled:
                    from .m2_touch import InvalidTouch
                    try:
                        if kind == "touch":
                            await asyncio.to_thread(stream.send_touch, msg)
                        elif kind == "nav_key":
                            await asyncio.to_thread(stream.send_nav, msg)
                        else:
                            await asyncio.to_thread(stream.send_text, msg)
                        if kind != "touch":
                            await ws.send_json({"type": "input_accepted", "session_id": session,
                                                "kind": kind})
                    except (InvalidTouch, ValueError, OSError):
                        await ws.send_json({"type": "input_error", "session_id": session,
                                            "message": "远控指令执行失败"})
                if requested_stop.is_set():
                    break
        except (WebSocketDisconnect, RuntimeError, OSError, asyncio.TimeoutError):
            pass
        finally:
            if control_enabled:
                try:
                    await asyncio.to_thread(stream.release_touch)
                except (ValueError, OSError):
                    pass
            if pc is not None:
                try:
                    await asyncio.shield(pc.close())
                except Exception:
                    pass
            registry.release_viewer(record)
            try:
                await ws.close()
            except (RuntimeError, OSError):
                pass

    return app
