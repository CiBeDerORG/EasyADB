"""OpenWrt group discovery domain service; independent of FastAPI transport.

An explicitly requested test/scan is the only trigger. The owning app injects
dependencies to preserve existing test overrides and per-request credentials.
"""
import threading

from ..core.exceptions import DomainError
from ..openwrt_discovery import DiscoveryError, validate_url
from .operations import membership_lock, device_locks


def run_group_scan(group_name, *, persist, test_config, store, discovery_client,
                   manager, display_lab, live_registry, discovery_guard, discovery_locks,
                   session_manager=None):
    with discovery_guard:
        mutex = discovery_locks.setdefault(group_name, threading.Lock())
    if not mutex.acquire(blocking=False):
        raise DomainError(409, "该分组正在发现 ADB，请勿重复提交")
    try:
        group = store.get_group(group_name)
        if group is None:
            raise DomainError(404, "找不到该分组")
        if not group["discovery_configured"]:
            raise DomainError(409, "该分组尚未配置 OpenWrt 发现接口")
        if persist and not group["ip_prefix"]:
            raise DomainError(409, "正式匹配前请先配置本组内网 IP 前缀")
        try:
            if test_config is not None:
                # Test the current (possibly unsaved) form without changing SQLite.
                url = validate_url(test_config.url)
                username = test_config.username.strip()
                if not username:
                    raise DiscoveryError("请先填写专用用户名")
                password = test_config.password
                if not password:
                    # A saved credential is only valid for its original router/login.
                    saved_url, saved_user, password = store.get_group_discovery_secret(group_name)
                    if url != saved_url or username != saved_user:
                        raise DiscoveryError("RPCD 地址或用户名已修改，请填写专用密钥后再测试")
            else:
                url, username, password = store.get_group_discovery_secret(group_name)
            scan_result = discovery_client.scan(url, username, password)
        except DiscoveryError as exc:
            raise DomainError(502, str(exc)) from None
        except ValueError as exc:
            raise DomainError(409, str(exc)) from None
        if not persist:
            # Explicit test of BOTH login and scan ACL. Does not change device
            # ports or save a new NAS discovery result; prefix is not required.
            return {"authorized": True, "found": len(scan_result["devices"])}
        # Lock devices in stable order. A plain ADB connection is not a live
        # screen owner: discovery may update its shared port, then the cached
        # ADB state is cleared so the user can explicitly connect the new
        # serial. Only an active browser live request or display experiment is
        # protected. With no SessionManager injection, retain the older strict
        # registry check for compatibility with direct service callers.
        with membership_lock():
            group_devices = sorted((d for d in store.list() if d["group_name"] == group_name),
                                   key=lambda d: d["id"])
            with device_locks(manager, (device["id"] for device in group_devices)):
                blocked = set()
                for device in group_devices:
                    device_id = device["id"]
                    if display_lab.has_pending(device_id):
                        blocked.add(device_id)
                        continue
                    if session_manager is not None:
                        if session_manager.has_active_request(device_id):
                            blocked.add(device_id)
                    else:
                        with live_registry.lock:
                            live = live_registry.sessions.get(device_id)
                            if live is not None and not live_registry.is_cleaned(live):
                                blocked.add(device_id)
                try:
                    result = store.apply_group_discovery(group_name, scan_result, blocked)
                except ValueError as exc:
                    raise DomainError(409, str(exc)) from None
                for updated in result["updated"]:
                    device_id = updated["id"]
                    # Do not disconnect ADB behind the user's back. The DB now
                    # points at a different serial, so forget only EasyADB's
                    # cached connection and reinforce stop on any orphaned old
                    # live worker. Its registry slot remains until verified clean.
                    live_registry.stop_for(device_id)
                    manager.clear(device_id)
                return result
    finally:
        mutex.release()

