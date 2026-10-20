"""Explicit, event-triggered live coordination; no background ADB polling."""
import asyncio
import logging

from ..devices import selected_address
from .operations import device_lock


async def confirm_adb_loss(source, device_id: str, serial: str) -> bool:
    """Confirm failure once; never mark a later selected route disconnected."""
    try:
        still_online = await asyncio.to_thread(source.is_connected, serial)
    except (source.HTTPException, OSError):
        return False
    if still_online:
        return False
    with device_lock(source.manager, device_id):
        current = source.store.get(device_id)
        if (current and selected_address(current) == serial
                and source.manager.serial_for(current) == serial):
            source.manager._set_state(
                device_id, "disconnected",
                "当前 ADB 地址已断开；请手动检查连接并重新连接",
            )
    return True


async def close_webrtc_peer(pc, stream, device_id, registry):
    """Never release a session whose peer/worker teardown is unverified."""
    try:
        await pc.close()
    except Exception:
        logging.getLogger(__name__).exception(
            "WebRTC peer close failed for device %s session %s; keeping slot",
            device_id, stream.session_id)
        return False
    stream.peer_cleanup_complete = True
    if registry.is_cleaned(stream):
        registry.release(device_id, stream)
    return True
