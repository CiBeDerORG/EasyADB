"""Device CRUD operations with a transport-neutral error boundary."""
import sqlite3

from ..core.exceptions import DomainError
from .operations import membership_lock, device_lock, require_clean_sessions


def create_device_record(data, *, store, manager):
    with membership_lock():
        try:
            record = store.create(data)
        except sqlite3.IntegrityError:
            raise DomainError(409, "该组网 IP 和端口已经存在于设备列表") from None
        except ValueError as exc:
            raise DomainError(409, str(exc)) from None
        return manager.snapshot(record)


def update_device_record(device_id, clean_data, *, store, manager, display_lab, live_registry):
    with membership_lock():
        with device_lock(manager, device_id):
            if display_lab.has_pending(device_id):
                raise DomainError(409, "该设备有待恢复的副屏实验，请先恢复原始设置")
            original = store.get(device_id)
            if original is None:
                raise DomainError(404, "找不到该设备")
            data = clean_data()
            port_only_change = (
                data["port"] != original["port"]
                and all(data[key] == original[key] for key in ("name", "group_name", "ip"))
            )
            if not port_only_change:
                require_clean_sessions(
                    live_registry, (device_id,),
                    "该设备正在投屏或清理，请结束并确认清理后再修改设备",
                )
            try:
                updated = store.update(device_id, data)
            except sqlite3.IntegrityError:
                raise DomainError(409, "该组网 IP 和端口已经存在于设备列表") from None
            except ValueError as exc:
                raise DomainError(409, str(exc)) from None
            if updated is None:
                raise DomainError(404, "找不到该设备")
            fields = ("ip", "port", "group_name", "lan_ip", "selected_route")
            if any(original[key] != updated[key] for key in fields):
                live_registry.stop_for(device_id)
                manager.clear(device_id)
            return manager.snapshot(updated)


def delete_device_record(device_id, *, store, manager, display_lab, live_registry):
    with membership_lock():
        with device_lock(manager, device_id):
            if display_lab.has_pending(device_id):
                raise DomainError(409, "该设备有待恢复的副屏实验，请先恢复原始设置")
            if store.get(device_id) is None:
                raise DomainError(404, "找不到该设备")
            require_clean_sessions(
                live_registry, (device_id,),
                "该设备正在投屏或清理，请结束并确认清理后再删除设备",
            )
            if not store.delete(device_id):
                raise DomainError(404, "找不到该设备")
            live_registry.stop_for(device_id)
            manager.clear(device_id)
            # Never disconnect an ADB serial which other clients may share.
            return {"deleted": True}
