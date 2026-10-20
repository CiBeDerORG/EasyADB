"""V1 live HTTP/WS URL contracts; the original app handlers remain compatible."""
from fastapi import APIRouter, Depends


def build_router(handlers, authorize):
    router = APIRouter()
    router.add_api_route("/api/devices/{device_id}/m2/preflight", getattr(handlers, "m2_device_preflight"), methods=["POST"], dependencies=[Depends(authorize)])
    router.add_api_route("/api/devices/{device_id}/m2/video-probe", getattr(handlers, "m2_video_probe"), methods=["POST"], dependencies=[Depends(authorize)])
    router.add_api_route("/api/m2/video-engine", getattr(handlers, "m2_video_engine"), methods=["GET"])
    router.add_api_websocket_route("/api/devices/{device_id}/m2/live", getattr(handlers, "m2_live_video"))
    return router
