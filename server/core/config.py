"""Validated startup configuration; read once at app import like the M3 baseline."""
from dataclasses import dataclass
import os
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    video_engine: str
    token: str
    root: Path
    db_path: str


def load_settings(environ=None) -> Settings:
    env = os.environ if environ is None else environ
    engine = env.get("EASYADB_VIDEO_ENGINE", "mse").strip().lower()
    if engine not in ("mse", "webrtc", "webcodecs"):
        raise RuntimeError("EASYADB_VIDEO_ENGINE must be mse, webrtc or webcodecs")
    token = env.get("EASYADB_TOKEN", "").strip()
    if len(token) < 12 or token == "REPLACE_WITH_RANDOM_LONG_TOKEN":
        raise RuntimeError("Set EASYADB_TOKEN to a unique token of at least 12 characters")
    root = Path(__file__).resolve().parents[2]
    return Settings(engine, token, root,
                    env.get("EASYADB_DB", str(root / "data" / "devices.sqlite3")))
