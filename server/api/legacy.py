"""V1 legacy HTTP/WS URL contracts; the original app handlers remain compatible."""
from fastapi import APIRouter, Depends


def build_router(handlers, authorize):
    router = APIRouter(dependencies=[Depends(authorize)])
    router.add_api_route("/api/pair", getattr(handlers, "pair"), methods=["POST"])
    router.add_api_route("/api/connect", getattr(handlers, "connect"), methods=["POST"])
    router.add_api_route("/api/status", getattr(handlers, "status"), methods=["GET"])
    router.add_api_route("/api/screenshot", getattr(handlers, "screenshot"), methods=["GET"])
    return router
