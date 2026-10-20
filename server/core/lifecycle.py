"""Explicit, independently testable application resource lifetime."""
import asyncio
from contextlib import asynccontextmanager


@asynccontextmanager
async def managed_resources(resolve):
    store, registry = resolve()
    store.initialize()
    try:
        yield
    finally:
        # No hidden discovery/ADB connection is performed here.
        await asyncio.to_thread(registry.stop_all)
