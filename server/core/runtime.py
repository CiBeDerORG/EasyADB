"""Runtime composition; existing app-level aliases remain for staged migration.

Build objects once on startup import. No DB initialization, ADB connect or
OpenWrt network scanning occurs here. The lifespan owns initialization/stop.
"""
from dataclasses import dataclass
from typing import Callable

from ..devices import DeviceManager
from ..store import DeviceStore
from ..openwrt_discovery import RpcdDiscovery
from ..m2_live import LiveRegistry
from ..display_lab import DisplayLab


@dataclass(frozen=True)
class Runtime:
    store: DeviceStore
    discovery_client: RpcdDiscovery
    manager: DeviceManager
    live_registry: LiveRegistry
    display_lab: DisplayLab


def build_runtime(db_path: str, adb_command: Callable) -> Runtime:
    store = DeviceStore(db_path)
    return Runtime(
        store=store,
        discovery_client=RpcdDiscovery(),
        manager=DeviceManager(store, adb_command),
        live_registry=LiveRegistry(),
        display_lab=DisplayLab(adb_command, db_path + ".display-lab.json"),
    )
