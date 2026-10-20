"""M1 mapping registry and isolated public surface contracts."""
import asyncio
import threading
from pathlib import Path

import httpx

from server.mapping import MappingRegistry, build_mapping_app


class FakeStream:
    def __init__(self):
        self.session_id = "existing-owner-session"
        self.stop_event = threading.Event()
        self.finished = threading.Event()
        self.webrtc_relay = object()
        self.mapping_init = {"width": 1080, "height": 2340, "control_available": True}


def test_mapping_registry_single_viewer_and_stop():
    async def exercise():
        registry = MappingRegistry()
        stream = FakeStream()
        record = registry.enable("phone-a", stream)
        assert registry.enable("phone-a", stream) is record
        assert registry.acquire_viewer(record["id"]) is record
        assert registry.acquire_viewer(record["id"]) is None
        registry.release_viewer(record)
        assert registry.acquire_viewer(record["id"]) is record
        assert registry.disable_for("phone-a", FakeStream()) is False
        assert registry.disable_for("phone-a", stream) is True
        await asyncio.wait_for(record["ended"].wait(), 1)
        assert registry.get(record["id"]) is None
        assert registry.acquire_viewer(record["id"]) is None
        assert registry.status("phone-a") is None
        new_record = registry.enable("phone-a", stream)
        assert new_record["id"] != record["id"]
        stream.stop_event.set()
        assert registry.get(new_record["id"]) is None
        registry.disable_all()
    asyncio.run(exercise())


def test_mapping_requires_initialized_webrtc():
    async def exercise():
        registry = MappingRegistry()
        stream = FakeStream()
        stream.mapping_init = None
        try:
            registry.enable("phone-a", stream)
        except ValueError:
            pass
        else:
            raise AssertionError("Uninitialized stream became public")
        stream.mapping_init = {"width": 1080}
        stream.webrtc_relay = None
        try:
            registry.enable("phone-a", stream)
        except ValueError:
            pass
        else:
            raise AssertionError("Non-WebRTC stream became public")
    asyncio.run(exercise())


def test_mapping_http_router_has_no_admin_endpoints():
    async def exercise():
        registry = MappingRegistry()
        stream = FakeStream()
        record = registry.enable("phone-a", stream)
        app = build_mapping_app(registry, Path(__file__).parents[1] / "web")
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                     base_url="http://trusted-test") as client:
            assert (await client.get("/")).status_code == 404
            assert (await client.get("/api/devices")).status_code == 404
            assert (await client.get("/api/devices/phone-a/m2/live")).status_code == 404
            page = await client.get("/m/" + record["id"])
            assert page.status_code == 200
            assert "无公网鉴权" in page.text
            assert (await client.get("/mapping.js")).status_code == 200
            registry.disable_for("phone-a")
            await asyncio.wait_for(record["ended"].wait(), 1)
            assert (await client.get("/m/" + record["id"])).status_code == 404
    asyncio.run(exercise())
