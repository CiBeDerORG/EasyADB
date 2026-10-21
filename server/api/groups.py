"""V1 groups HTTP/WS URL contracts; the original app handlers remain compatible."""
from urllib.parse import quote, unquote

from fastapi import APIRouter, Depends
from fastapi.routing import APIRoute


class EncodedGroupRoute(APIRoute):
    """Match the encoded name as one segment, then decode it exactly once.

    ASGI's decoded path turns a name's %2F into a route separator. A greedy
    path parameter also confuses names ending in /discovery with subroutes.
    The original raw path preserves this distinction without changing URLs.
    """

    def matches(self, scope):
        raw_path = scope.get("raw_path")
        if scope["type"] != "http" or not raw_path or "{group_name}" not in self.path:
            return super().matches(scope)
        try:
            encoded_path = raw_path.decode("ascii")
        except UnicodeDecodeError:
            return super().matches(scope)
        encoded_scope = dict(scope, path=encoded_path,
                             root_path=quote(scope.get("root_path", ""), safe="/"))
        match, child_scope = super().matches(encoded_scope)
        params = child_scope.get("path_params", {})
        if "group_name" in params:
            params["group_name"] = unquote(params["group_name"])
        return match, child_scope


def build_router(handlers, authorize):
    router = APIRouter(dependencies=[Depends(authorize)], route_class=EncodedGroupRoute)
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
