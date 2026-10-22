"""Group management service: business rules independent of FastAPI transport."""
import sqlite3

from ..core.exceptions import DomainError
from .operations import (membership_lock, device_locks, group_operation, GroupBusy,
                         require_clean_sessions)


def _busy():
    return DomainError(409, "该分组正在发现 ADB 或修改配置，请稍后重试")


def create_group_record(name, prefix, *, store):
    with membership_lock():
        try:
            return store.create_group(name, prefix)
        except sqlite3.IntegrityError:
            raise DomainError(409, "分组名称已存在") from None
        except ValueError as exc:
            raise DomainError(409, str(exc)) from None


def update_group_record(group_name, clean_data, *, store, manager, display_lab,
                        live_registry, discovery_guard, discovery_locks, session_manager=None):
    try:
        with group_operation(discovery_guard, discovery_locks, group_name):
            with membership_lock():
                name, prefix = clean_data()
                members = [d["id"] for d in store.list() if d["group_name"] == group_name]
                with device_locks(manager, members):
                    if any(display_lab.has_pending(device_id) for device_id in members):
                        raise DomainError(409, "分组中存在待恢复的副屏实验，请先恢复设备后再修改分组")
                    require_clean_sessions(
                        live_registry, members,
                        "分组中存在被其他页面投屏的设备，请先停止实时画面后再修改分组",
                        session_manager=session_manager, allow_orphan_cleanup=True,
                    )
                    try:
                        result = store.update_group(group_name, name, prefix)
                    except sqlite3.IntegrityError:
                        raise DomainError(409, "分组名称已存在") from None
                    except ValueError as exc:
                        raise DomainError(409, str(exc)) from None
                    if result is None:
                        raise DomainError(404, "找不到该分组")
                    for device_id in members:
                        live_registry.stop_for(device_id)
                        manager.clear(device_id)
                    return result
    except GroupBusy:
        raise _busy() from None


def delete_group_record(group_name, *, store, manager, display_lab,
                        live_registry, discovery_guard, discovery_locks, session_manager=None):
    try:
        with group_operation(discovery_guard, discovery_locks, group_name):
            with membership_lock():
                members = [d["id"] for d in store.list() if d["group_name"] == group_name]
                with device_locks(manager, members):
                    if any(display_lab.has_pending(device_id) for device_id in members):
                        raise DomainError(409, "分组中存在待恢复的副屏实验，请先恢复设备后再删除分组")
                    require_clean_sessions(
                        live_registry, members,
                        "分组中存在被其他页面投屏的设备，请先停止实时画面后再删除分组",
                        session_manager=session_manager, allow_orphan_cleanup=True,
                    )
                    result = store.delete_group(group_name)
                    if result is None:
                        raise DomainError(404, "找不到该分组")
                    for device_id in result["device_ids"]:
                        live_registry.stop_for(device_id)
                        manager.clear(device_id)
                    return {"deleted": True, "moved_count": result["moved_count"]}
    except GroupBusy:
        raise _busy() from None


def configure_group_discovery_record(group_name, url, username, password, *,
                                     store, discovery_guard, discovery_locks):
    try:
        with group_operation(discovery_guard, discovery_locks, group_name):
            try:
                result = store.set_group_discovery(group_name, url, username, password)
            except ValueError as exc:
                raise DomainError(400, str(exc)) from None
            if result is None:
                raise DomainError(404, "找不到该分组")
            return result
    except GroupBusy:
        raise _busy() from None


def clear_group_discovery_record(group_name, *, store, discovery_guard, discovery_locks):
    try:
        with group_operation(discovery_guard, discovery_locks, group_name):
            result = store.remove_group_discovery(group_name)
            if result is None:
                raise DomainError(404, "找不到该分组")
            return result
    except GroupBusy:
        raise _busy() from None
