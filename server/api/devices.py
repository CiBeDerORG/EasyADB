"""V1 devices HTTP/WS URL contracts; the original app handlers remain compatible."""
from fastapi import APIRouter, Depends


def build_router(handlers, authorize):
    router = APIRouter(dependencies=[Depends(authorize)])
    router.add_api_route("/api/devices/{device_id}/pair", getattr(handlers, "pair_existing_device"), methods=["POST"])
    router.add_api_route("/api/devices", getattr(handlers, "list_devices"), methods=["GET"])
    router.add_api_route("/api/devices", getattr(handlers, "create_device"), methods=["POST"], status_code=201)
    router.add_api_route("/api/devices/refresh", getattr(handlers, "refresh_devices"), methods=["POST"])
    router.add_api_route("/api/devices/{device_id}", getattr(handlers, "update_device"), methods=["PUT"])
    router.add_api_route("/api/devices/{device_id}/unlock", getattr(handlers, "unlock_state"), methods=["GET"])
    router.add_api_route("/api/devices/{device_id}/unlock", getattr(handlers, "set_unlock_state"), methods=["PUT"])
    router.add_api_route("/api/devices/{device_id}", getattr(handlers, "delete_device"), methods=["DELETE"])
    router.add_api_route("/api/devices/{device_id}/temp-address", getattr(handlers, "set_device_temp_address"), methods=["PUT"])
    router.add_api_route("/api/devices/{device_id}/route", getattr(handlers, "select_device_route"), methods=["PUT"])
    router.add_api_route("/api/devices/{device_id}/connect", getattr(handlers, "connect_device"), methods=["POST"])
    router.add_api_route("/api/devices/{device_id}/refresh", getattr(handlers, "refresh_device"), methods=["POST"])
    router.add_api_route("/api/devices/{device_id}/screenshot", getattr(handlers, "device_screenshot"), methods=["GET"])
    return router
