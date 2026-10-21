"""Encoded group names remain one HTTP path segment for all group operations."""
import importlib
import threading
from types import SimpleNamespace
from urllib.parse import quote, unquote

import pytest
from fastapi.testclient import TestClient

from server.devices import DeviceManager
from server.display_lab import DisplayLab
from server.m2_live import LiveRegistry
from server.store import DeviceStore


AUTH = {"X-EasyADB-Token": "local-test-token-123"}


@pytest.fixture
def app_module(monkeypatch, tmp_path):
    monkeypatch.setenv("EASYADB_TOKEN", AUTH["X-EasyADB-Token"])
    module = importlib.import_module("server.app")

    def no_adb(*args, **kwargs):
        pytest.fail("Group operations must not issue ADB commands")

    store = DeviceStore(str(tmp_path / "devices.sqlite3"))
    for name, value in {
        "TOKEN": AUTH["X-EasyADB-Token"], "store": store,
        "manager": DeviceManager(store, no_adb), "live_registry": LiveRegistry(),
        "display_lab": DisplayLab(no_adb, tmp_path / "lab.json"),
        "_discovery_guard": threading.RLock(), "_discovery_locks": {},
        "discovery_client": SimpleNamespace(scan=lambda *args: {
            "status": "ok", "scanned_at": 1792400000, "devices": [],
        }),
    }.items():
        monkeypatch.setattr(module, name, value)
    return module


@pytest.mark.parametrize("name", [
    "Room/A", "/", "Room/discovery", "Room/discovery/test",
    "百分%2F", "中文/分组", "Plus + #?%", "trailing/",
])
def test_group_name_round_trip_preserves_subroutes_and_exact_identity(app_module, name):
    module = app_module
    with TestClient(module.app) as client:
        assert client.post("/api/groups", headers=AUTH, json={
            "name": "Room", "ip_prefix": "192.168.50.*",
        }).status_code == 201
        original_parent = module.store.get_group("Room")
        assert client.post("/api/groups", headers=AUTH, json={
            "name": name, "ip_prefix": "192.168.60.*",
        }).status_code == 201
        device = client.post("/api/devices", headers=AUTH, json={
            "name": "Phone", "group_name": name, "ip": "10.1.0.12", "port": 5555,
        }).json()
        path = "/api/groups/" + quote(name, safe="")
        configuration = {"url": "http://192.168.60.1/ubus", "username": "easyadb",
                         "password": "fixture-password"}
        assert client.put(path + "/discovery", json=configuration).status_code == 401
        response = client.put(path + "/discovery", headers=AUTH, json=configuration)
        assert response.status_code == 200, response.text
        assert response.json()["name"] == name
        assert module.store.get_group_discovery_secret(name) == tuple(configuration.values())
        tested = client.post(path + "/discovery/test", headers=AUTH)
        assert tested.status_code == 200, tested.text
        assert tested.json() == {"authorized": True, "found": 0}
        scanned = client.post(path + "/discovery/scan", headers=AUTH)
        assert scanned.status_code == 200, scanned.text
        last = client.get(path + "/discovery/last", headers=AUTH)
        assert last.status_code == 200 and last.json()["last"] is not None
        assert client.delete(path + "/discovery", headers=AUTH).status_code == 200
        assert not module.store.get_group(name)["discovery_configured"]
        assert client.put(path + "/discovery", headers=AUTH, json=configuration).status_code == 200

        renamed = "新/" + name
        response = client.put(path, headers=AUTH,
                              json={"name": renamed, "ip_prefix": "192.168.70.*"})
        assert response.status_code == 200, response.text
        assert response.json()["name"] == renamed
        assert module.store.get_group(name) is None
        assert module.store.get(device["id"])["group_name"] == renamed
        new_path = "/api/groups/" + quote(renamed, safe="")
        assert client.get(new_path + "/discovery/last", headers=AUTH).json()["last"] is not None
        assert module.store.get_group_discovery_secret(renamed) == tuple(configuration.values())
        assert client.delete(new_path, headers=AUTH).json() == {"deleted": True, "moved_count": 1}
        assert module.store.get(device["id"])["group_name"] == ""
        assert module.store.get_group(renamed) is None
        assert module.store.get_group("Room") == original_parent


def test_literal_percent_escape_and_slash_names_are_distinct(app_module):
    with TestClient(app_module.app) as client:
        for name in ("Room/A", "Room%2FA"):
            assert client.post("/api/groups", headers=AUTH, json={"name": name}).status_code == 201
        assert client.delete("/api/groups/Room%252FA", headers=AUTH).status_code == 200
        assert app_module.store.get_group("Room/A") is not None
        assert app_module.store.get_group("Room%2FA") is None
        assert client.delete("/api/groups/Room%2FA", headers=AUTH).status_code == 200


def test_encoded_group_names_work_with_asgi_root_path(app_module):
    with TestClient(app_module.app, root_path="/easyadb") as client:
        assert client.post("/easyadb/api/groups", headers=AUTH,
                           json={"name": "Home/Lab"}).status_code == 201
        response = client.delete("/easyadb/api/groups/Home%2FLab", headers=AUTH)
        assert response.status_code == 200, response.text


def test_optional_raw_path_absence_does_not_double_decode_normal_names(app_module):
    async def without_raw_path(scope, receive, send):
        scope = dict(scope)
        if scope["type"] == "http":
            # Build the canonical ASGI decoded path before removing the
            # optional raw path; TestClient/httpx otherwise decode it twice.
            scope["path"] = unquote(scope["raw_path"].decode("ascii"))
        scope.pop("raw_path", None)
        await app_module.app(scope, receive, send)

    with TestClient(without_raw_path) as client:
        assert client.post("/api/groups", headers=AUTH,
                           json={"name": "Home%2FLab"}).status_code == 201
        response = client.delete("/api/groups/Home%252FLab", headers=AUTH)
        assert response.status_code == 200, response.text
