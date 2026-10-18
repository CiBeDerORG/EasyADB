"""M2-05-A live-stream quality: bounded choices, no arbitrary scrcpy arguments.

Video *experiments* keep their original baseline/native PROFILES unchanged.
Only an explicitly started live session may use economy/custom settings.
Requested FPS/bitrate/size are encoder limits, not measured output guarantees.
"""
from .m2_video_probe import PROFILES

LIVE_PROFILES = {
    "economy": {"max_size": 960, "video_bit_rate": 3_000_000, "max_fps": 24},
    "baseline": dict(PROFILES["baseline"]),
    "native": dict(PROFILES["native"]),
}

CUSTOM_CHOICES = {
    "max_size": (0, 960, 1280, 1600),
    "video_bit_rate": (2_000_000, 3_000_000, 4_000_000, 8_000_000, 12_000_000, 16_000_000, 18_000_000, 20_000_000),
    "max_fps": (15, 24, 30, 45, 55, 60),
}


def resolve_live_quality(profile, quality=None):
    """Return a private validated copy; never splice arbitrary inputs into adb."""
    if type(profile) is not str:
        raise ValueError("实时视频档位无效")
    if profile in LIVE_PROFILES:
        if quality is not None:
            raise ValueError("预设档位不可覆盖视频参数")
        return dict(LIVE_PROFILES[profile])
    if profile != "custom":
        raise ValueError("实时视频档位无效")
    if type(quality) is not dict or set(quality) != set(CUSTOM_CHOICES):
        raise ValueError("自定义画质需要且仅允许分辨率、码率及最高帧率")
    for key, allowed in CUSTOM_CHOICES.items():
        if type(quality[key]) is not int or quality[key] not in allowed:
            raise ValueError("自定义视频参数超出允许范围")
    return {key: quality[key] for key in CUSTOM_CHOICES}
