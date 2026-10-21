"""Existing public UI asset endpoints; no behavior or cache-policy changes."""
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import FileResponse

ROOT = Path(__file__).resolve().parents[2]
router = APIRouter()


@router.get("/")
def home():
    return FileResponse(ROOT / "web" / "index.html", headers={"Cache-Control": "no-store"})


@router.get("/m2-webrtc.js")
def m2_webrtc_script():
    return FileResponse(ROOT / "web" / "m2-webrtc.js", media_type="application/javascript",
                        headers={"Cache-Control": "no-store"})


@router.get("/m2-traffic.js")
def m2_traffic_script():
    return FileResponse(ROOT / "web" / "m2-traffic.js", media_type="application/javascript",
                        headers={"Cache-Control": "no-store"})


@router.get("/m2-touch.js")
def m2_touch_script():
    return FileResponse(ROOT / "web" / "m2-touch.js", media_type="application/javascript",
                        headers={"Cache-Control": "no-store"})


@router.get("/m2-metrics.js")
def m2_metrics_script():
    return FileResponse(ROOT / "web" / "m2-metrics.js", media_type="application/javascript",
                        headers={"Cache-Control": "no-store"})


@router.get("/display-lab.js")
def display_lab_script():
    return FileResponse(ROOT / "web" / "display-lab.js", media_type="application/javascript",
                        headers={"Cache-Control": "no-store"})


@router.get("/m2-multi.js")
def m2_multi_script():
    return FileResponse(ROOT / "web" / "m2-multi.js", media_type="application/javascript",
                        headers={"Cache-Control": "no-store"})


@router.get("/m2-group.js")
def m2_group_script():
    return FileResponse(ROOT / "web" / "m2-group.js", media_type="application/javascript",
                        headers={"Cache-Control": "no-store"})



# Exact legacy stylesheet route: no generic directory mount.
@router.get("/assets/legacy-page.css", include_in_schema=False)
def legacy_page_stylesheet():
    return FileResponse(
        ROOT / "web" / "assets" / "legacy-page.css", media_type="text/css",
        headers={"Cache-Control": "no-store"},
    )


# Exact V4 ES Module allowlist, not a wildcard file or directory mount.
# Imported relative paths resolve under these same URL prefixes.
FRONTEND_MODULES = (
    "app/main.js",
    "core/api-client.js",
    "shared/dom.js",
    "shared/ui/dialog.js",
    "shared/ui/toast.js",
    "features/live/live-session-controller.js",
    "features/live/live-card-view.js",
    "features/live/live-batch-scheduler.js",
    "features/live/live-quality-settings.js",
    "features/devices/device-list-model.js",
    "features/devices/device-list-view.js",
)


def _frontend_asset_handler(asset_path):
    def serve_frontend_module():
        return FileResponse(
            ROOT / "web" / asset_path, media_type="application/javascript",
            headers={"Cache-Control": "no-store"},
        )
    return serve_frontend_module


for _asset_path in FRONTEND_MODULES:
    router.add_api_route(
        "/" + _asset_path, _frontend_asset_handler(_asset_path),
        methods=["GET"], name="frontend_" + _asset_path.replace("/", "_").replace(".", "_"),
        include_in_schema=False,
    )
