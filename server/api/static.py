"""Existing public UI asset endpoints; no behavior or cache-policy changes."""
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import FileResponse

ROOT = Path(__file__).resolve().parents[2]
router = APIRouter()


@router.get("/")
def home():
    return FileResponse(ROOT / "web" / "index.html", headers={"Cache-Control": "no-store"})


@router.get("/m2-player.js")
def m2_player_script():
    return FileResponse(ROOT / "web" / "m2-player.js", media_type="application/javascript",
                        headers={"Cache-Control": "no-store"})


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


