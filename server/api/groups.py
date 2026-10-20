"""V1 groups HTTP/WS URL contracts; the original app handlers remain compatible."""
from fastapi import APIRouter, Depends


def build_router(handlers, authorize):
    router = APIRouter(dependencies=[Depends(authorize)])
    router.add_api_route("/api/groups", getattr(handlers, "list_groups"), methods=["GET"])
    router.add_api_route("/api/groups", getattr(handlers, "create_group"), methods=["POST"], status_code=201)
    router.add_api_route("/api/groups/{group_name}", getattr(handlers, "update_group"), methods=["PUT"])
    router.add_api_route("/api/groups/{group_name}/discovery", getattr(handlers, "configure_group_discovery"), methods=["PUT"])
    router.add_api_route("/api/groups/{group_name}/discovery", getattr(handlers, "clear_group_discovery"), methods=["DELETE"])
    router.add_api_route("/api/groups/{group_name}/discovery/test", getattr(handlers, "test_group_discovery"), methods=["POST"])
    router.add_api_route("/api/groups/{group_name}/discovery/scan", getattr(handlers, "scan_group_discovery"), methods=["POST"])
    router.add_api_route("/api/groups/{group_name}/discovery/last", getattr(handlers, "group_discovery_last"), methods=["GET"])
    router.add_api_route("/api/groups/{group_name}", getattr(handlers, "delete_group"), methods=["DELETE"])
    return router
