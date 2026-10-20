"""V1 lab HTTP/WS URL contracts; the original app handlers remain compatible."""
from fastapi import APIRouter, Depends


def build_router(handlers, authorize):
    router = APIRouter(dependencies=[Depends(authorize)])
    router.add_api_route("/api/devices/{device_id}/display-lab/state", getattr(handlers, "display_lab_state"), methods=["GET"])
    router.add_api_route("/api/devices/{device_id}/display-lab/environment", getattr(handlers, "display_lab_environment"), methods=["POST"])
    router.add_api_route("/api/devices/{device_id}/display-lab/scan", getattr(handlers, "display_lab_scan"), methods=["POST"])
    router.add_api_route("/api/devices/{device_id}/display-lab/overlay", getattr(handlers, "display_lab_overlay"), methods=["POST"])
    router.add_api_route("/api/devices/{device_id}/display-lab/restore", getattr(handlers, "display_lab_restore"), methods=["POST"])
    router.add_api_route("/api/devices/{device_id}/display-lab/castplus/start", getattr(handlers, "castplus_start"), methods=["POST"])
    router.add_api_route("/api/devices/{device_id}/display-lab/castplus/auto", getattr(handlers, "castplus_auto"), methods=["POST"])
    router.add_api_route("/api/devices/{device_id}/display-lab/castplus/switch", getattr(handlers, "castplus_switch"), methods=["POST"])
    router.add_api_route("/api/devices/{device_id}/display-lab/castplus/verify", getattr(handlers, "castplus_verify"), methods=["POST"])
    router.add_api_route("/api/devices/{device_id}/display-lab/castplus/restore", getattr(handlers, "castplus_restore"), methods=["POST"])
    return router
