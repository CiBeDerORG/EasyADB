"""E-01 through E-06: group-scoped RPCD discovery and safe shared-port migration."""
import importlib
import json
import sqlite3
import threading

import pytest
from fastapi.testclient import TestClient

from server.devices import DeviceManager, selected_address
from server.openwrt_discovery import DiscoveryError, RpcdDiscovery, validate_url, SCANNER
from server.store import DeviceStore

AUTH = {"X-EasyADB-Token": "local-test-token-123"}
SECRET = "4" * 64
URL = "http://10.10.10.2/ubus"


def make_module(monkeypatch, tmp_path):
    monkeypatch.setenv("EASYADB_TOKEN", AUTH["X-EasyADB-Token"])
    mod = importlib.import_module("server.app")
    mod.store = DeviceStore(str(tmp_path / "devices.sqlite3"))
    mod.manager = DeviceManager(mod.store, lambda *a, **kw: pytest.fail("scan must not touch adb"))
    mod.discovery_client = RpcdDiscovery()
    mod._discovery_locks = {}
    return mod


def devices(*records):
    return {"status": "ok", "scanned_at": 1792400000, "devices": [
        {"instance": "adb-test", "iface": "br-lan", "address": ip, "port": port}
        for ip, port in records
    ]}


def test_url_restrictions():
    assert validate_url(URL) == URL
    assert validate_url("https://192.168.10.1:8443/ubus") == "https://192.168.10.1:8443/ubus"
    for url in ("http://127.0.0.1/ubus", "http://169.254.1.1/ubus", "http://8.8.8.8/ubus",
                "http://10.10.10.2/admin", "http://user:secret@10.10.10.2/ubus",
                "http://10.10.10.2/ubus?q=a", "ftp://10.10.10.2/ubus",
                "http://router.local/ubus", "http://10.10.10.2:99999/ubus"):
        with pytest.raises(DiscoveryError):
            validate_url(url)


def test_rpcd_login_scoped_scan_session_retry_and_error():
    calls = []
    response = devices(("192.168.10.206", 37819))
    retry_once = [True]

    def transport(url, data):
        calls.append((url, data))
        params = data["params"]
        if params[2] == "login":
            assert params[3] == {"username": "easyadb", "password": SECRET}
            return {"result": [0, {"ubus_rpc_session": "a" * 32}]}
        assert params[0] == "a" * 32
        assert params[1:] == ["file", "exec", {"command": SCANNER, "params": ["scan"]}]
        if retry_once[0]:
            retry_once[0] = False
            return {"jsonrpc": "2.0", "id": 1,
                    "error": {"code": -32001, "message": "Session not found"}}
        return {"result": [0, {"code": 0, "stdout": json.dumps(response), "stderr": ""}]}

    rpcd = RpcdDiscovery(transport)
    assert rpcd.scan(URL, "easyadb", SECRET) == response
    assert [d["params"][2] for _, d in calls] == ["login", "exec", "login", "exec"]
    assert rpcd.scan(URL, "easyadb", SECRET) == response
    assert [d["params"][2] for _, d in calls][-1] == "exec"

    # Status 6 means permission denied, NOT expiration; never re-login.
    denied_calls = []
    def status_six(url, payload):
        denied_calls.append(payload["params"][2])
        if payload["params"][2] == "login":
            return {"result": [0, {"ubus_rpc_session": "a" * 32}]}
        return {"result": [6]}
    with pytest.raises(DiscoveryError, match="状态码 6") as error:
        RpcdDiscovery(status_six).scan(URL, "easyadb", SECRET)
    assert denied_calls == ["login", "exec"]
    assert SECRET not in str(error.value)

    # A second explicit expiration must stop after one re-login.
    expired_calls = []
    def expired_again(url, payload):
        expired_calls.append(payload["params"][2])
        if payload["params"][2] == "login":
            return {"result": [0, {"ubus_rpc_session": "a" * 32}]}
        return {"error": {"code": -32001, "message": "Session not found"}}
    with pytest.raises(DiscoveryError, match="重新登录后会话仍无效"):
        RpcdDiscovery(expired_again).scan(URL, "easyadb", SECRET)
    assert expired_calls == ["login", "exec", "login", "exec"]

    def denied(url, data):
        if data["params"][2] == "login":
            return {"result": [0, {"ubus_rpc_session": "a" * 32}]}
        return {"result": [0, {"code": 1, "stderr": "permission denied"}]}
    with pytest.raises(DiscoveryError, match="permission denied"):
        RpcdDiscovery(denied).scan(URL, "easyadb", SECRET)


def test_rpcd_http_jsonrpc_errors_identify_gate_and_never_echo_tokens():
    session = "a" * 32
    def denied_file(url, payload):
        if payload["params"][2] == "login":
            return {"jsonrpc": "2.0", "id": 1, "result": [0, {"ubus_rpc_session": session}]}
        return {"jsonrpc": "2.0", "id": 1,
                "error": {"code": -32002, "message": "Access denied"}}
    with pytest.raises(DiscoveryError, match=r"file\.exec.*-32002") as error:
        RpcdDiscovery(denied_file).scan(URL, "easyadb", SECRET)
    assert "read.ubus.file.exec" in str(error.value)
    assert SECRET not in str(error.value) and session not in str(error.value)

    def denied_login(url, payload):
        return {"jsonrpc": "2.0", "id": 1,
                "error": {"code": -32002, "message": "Access denied; " + SECRET}}
    with pytest.raises(DiscoveryError, match=r"session\.login.*-32002") as error:
        RpcdDiscovery(denied_login).scan(URL, "easyadb", SECRET)
    assert SECRET not in str(error.value)

    def wrong_params(url, payload):
        return {"jsonrpc": "2.0", "id": 1,
                "error": {"code": -32602, "message": "Invalid parameters"}}
    with pytest.raises(DiscoveryError, match=r"-32602"):
        RpcdDiscovery(wrong_params).scan(URL, "easyadb", SECRET)

    # LuCI uses JSON-RPC batching. Support a one-element response without
    # accepting arbitrary multi-item responses or exposing the raw body.
    def single_batch(url, payload):
        if payload["params"][2] == "login":
            return [{"result": [0, {"ubus_rpc_session": session}]}]
        return [{"result": [0, {"code": 0, "stdout": json.dumps(devices(
            ("192.168.10.206", 37819))), "stderr": ""}]}]
    assert len(RpcdDiscovery(single_batch).scan(URL, "easyadb", SECRET)["devices"]) == 1


def test_group_config_private_and_rename_cleanup(monkeypatch, tmp_path):
    mod = make_module(monkeypatch, tmp_path)
    with TestClient(mod.app) as client:
        assert client.post("/api/groups", headers=AUTH,
                           json={"name": "Home", "ip_prefix": "192.168.10.*"}).status_code == 201
        path = "/api/groups/Home/discovery"
        assert client.put(path, json={"url": URL, "username": "easyadb", "password": SECRET}).status_code == 401
        r = client.put(path, headers=AUTH, json={"url": URL, "username": "easyadb", "password": SECRET})
        assert r.status_code == 200
        assert r.json()["discovery_configured"] is True
        assert r.json()["discovery_url"] == URL
        assert "password" not in r.json() and "credential" not in r.json()
        assert SECRET not in json.dumps(client.get("/api/groups", headers=AUTH).json())
        assert mod.store.get_group_discovery_secret("Home") == (URL, "easyadb", SECRET)
        with sqlite3.connect(mod.store.path) as db:
            assert db.execute("SELECT credential,credential_format FROM group_openwrt WHERE group_name='Home'").fetchone() == (SECRET, "plain")
        assert not (tmp_path / "devices.sqlite3.discovery-key").exists()
        assert client.put(path, headers=AUTH,
                          json={"url": URL, "username": "easyadb", "password": ""}).status_code == 200
        assert client.put(path, headers=AUTH, json={
            "url": "http://10.10.10.3/ubus", "username": "easyadb", "password": ""
        }).status_code == 400
        renamed = client.put("/api/groups/Home", headers=AUTH, json={
            "name": "Renamed", "ip_prefix": "192.168.10.*"
        })
        assert renamed.status_code == 200
        assert mod.store.get_group_discovery_secret("Renamed") == (URL, "easyadb", SECRET)
        assert mod.store.get_group_discovery_secret("Home") is None
        assert client.delete("/api/groups/Renamed", headers=AUTH).status_code == 200
        assert mod.store.get_group_discovery_secret("Renamed") is None


def test_legacy_encrypted_rows_require_reentry_without_keyfile_changes(tmp_path):
    """Old encrypted bytes cannot be treated as the actual router password."""
    path = tmp_path / "devices.sqlite3"
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE group_configs (name TEXT PRIMARY KEY, ip_prefix TEXT)")
        db.execute("INSERT INTO group_configs VALUES ('Home', '192.168.10.*')")
        db.execute("""CREATE TABLE group_openwrt (
            group_name TEXT PRIMARY KEY, url TEXT NOT NULL,
            username TEXT NOT NULL, credential TEXT NOT NULL
        )""")
        db.execute("INSERT INTO group_openwrt VALUES (?,?,?,?)",
                   ("Home", URL, "easyadb", "gAAAA-legacy-encrypted-token"))
    # An old file may exist on disk; new code does not read, modify or delete it.
    old_key = tmp_path / "devices.sqlite3.discovery-key"
    old_key.write_text("preserve-existing-key")
    store = DeviceStore(str(path))
    store.initialize()
    assert store.get_group("Home")["discovery_needs_password"] is True
    with pytest.raises(ValueError, match="重新粘贴"):
        store.get_group_discovery_secret("Home")
    with pytest.raises(ValueError, match="重新粘贴"):
        store.set_group_discovery("Home", URL, "easyadb", "")
    assert old_key.read_text() == "preserve-existing-key"
    assert store.set_group_discovery("Home", URL, "easyadb", SECRET)["discovery_needs_password"] is False
    assert store.get_group_discovery_secret("Home") == (URL, "easyadb", SECRET)
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT credential,credential_format FROM group_openwrt").fetchone() == (SECRET, "plain")
    assert old_key.read_text() == "preserve-existing-key"


def test_group_scan_exact_lan_ip_and_persistent_shared_port(monkeypatch, tmp_path):
    mod = make_module(monkeypatch, tmp_path)
    calls = []
    def transport(url, request):
        calls.append(request)
        if request["params"][2] == "login":
            return {"result": [0, {"ubus_rpc_session": "c" * 32}]}
        return {"result": [0, {"code": 0, "stdout": json.dumps(devices(
            ("192.168.10.206", 37171), ("192.168.10.206", 37171),
            ("192.168.10.114", 46573), ("192.168.10.201", 32442)
        )), "stderr": ""}]}
    mod.discovery_client = RpcdDiscovery(transport)
    with TestClient(mod.app) as client:
        client.post("/api/groups", headers=AUTH, json={"name": "Home", "ip_prefix": "192.168.10.*"})
        client.post("/api/groups", headers=AUTH, json={"name": "Other", "ip_prefix": "192.168.20.*"})
        a = client.post("/api/devices", headers=AUTH,
                        json={"name": "A", "group_name": "Home", "ip": "10.10.30.206", "port": 5555}).json()
        b = client.post("/api/devices", headers=AUTH,
                        json={"name": "B", "group_name": "Home", "ip": "10.10.30.114", "port": 6666}).json()
        other = client.post("/api/devices", headers=AUTH,
                            json={"name": "Other", "group_name": "Other", "ip": "10.10.30.206", "port": 8888}).json()
        url = "/api/groups/Home/discovery"
        client.put(url, headers=AUTH, json={"url": URL, "username": "easyadb", "password": SECRET})
        assert not calls, "Saving a group must never trigger a scan"
        before = client.get("/api/devices", headers=AUTH).json()
        assert all(x["port"] in (5555, 6666, 8888) for x in before)
        test = client.post(url + "/test", headers=AUTH).json()
        assert test["authorized"] and test["found"] == 4
        assert mod.store.get(a["id"])["port"] == 5555, "Auth test must not update device ports"
        resp = client.post(url + "/scan", headers=AUTH)
        assert resp.status_code == 200, resp.text
        result = resp.json()
        assert len(result["updated"]) == 2 and result["unmatched"] == ["192.168.10.201"]
        assert mod.store.get(a["id"])["port"] == 37171
        assert mod.store.get(b["id"])["port"] == 46573
        assert mod.store.get(other["id"])["port"] == 8888
        assert selected_address(mod.store.get(a["id"])) == "10.10.30.206:37171"
        assert mod.store.select_route(a["id"], "lan")["selected_route"] == "lan"
        assert selected_address(mod.store.get(a["id"])) == "192.168.10.206:37171"
        assert client.get(url + "/last", headers=AUTH).json()["last"]["updated"] == result["updated"]
        assert client.get("/api/groups/Other/discovery/last", headers=AUTH).json()["last"] is None
        # A second scan updates only newly changed ports and never performs adb connect.
        again = client.post(url + "/scan", headers=AUTH).json()
        assert len(again["updated"]) == 0 and len(again["unchanged"]) == 2


def test_ambiguous_and_active_connections_remain_unchanged(monkeypatch, tmp_path):
    mod = make_module(monkeypatch, tmp_path)
    mod.store.initialize()
    mod.store.create_group("Home", "192.168.10.*")
    a = mod.store.create({"name": "A", "group_name": "Home", "ip": "10.10.10.206", "port": 5555})
    b = mod.store.create({"name": "B", "group_name": "Home", "ip": "10.10.10.114", "port": 5555})
    conflicted = mod.store.apply_group_discovery("Home", devices(
        ("192.168.10.206", 32123), ("192.168.10.206", 32124), ("192.168.10.114", 43210)
    ), blocked_ids=(b["id"],))
    assert conflicted["conflicting"] == ["192.168.10.206"]
    assert len(conflicted["busy"]) == 1
    assert mod.store.get(a["id"])["port"] == 5555
    assert mod.store.get(b["id"])["port"] == 5555
    # Same IP from a different group must not update Home.
    assert mod.store.apply_group_discovery("Home", devices(("192.168.20.206", 40001)))["updated"] == []


def test_auth_test_prefers_unsaved_form_and_only_falls_back_for_same_router(monkeypatch, tmp_path):
    mod = make_module(monkeypatch, tmp_path)
    typed = "9" * 64
    wrong = "8" * 64
    logins = []

    def transport(url, payload):
        if payload["params"][2] == "login":
            creds = payload["params"][3]
            logins.append((url, creds["username"], creds["password"]))
            if creds["username"] == "easyadb" and creds["password"] in (SECRET, typed):
                return {"result": [0, {"ubus_rpc_session": "c" * 32}]}
            return {"result": [6]}
        return {"result": [0, {"code": 0, "stdout": json.dumps(devices(
            ("192.168.10.206", 37171))), "stderr": ""}]}

    mod.discovery_client = RpcdDiscovery(transport)
    with TestClient(mod.app) as client:
        client.post("/api/groups", headers=AUTH,
                    json={"name": "Home", "ip_prefix": "192.168.10.*"})
        path = "/api/groups/Home/discovery"
        client.put(path, headers=AUTH, json={"url": URL, "username": "easyadb", "password": SECRET})
        d = client.post("/api/devices", headers=AUTH, json={
            "name": "A", "group_name": "Home", "ip": "10.10.30.206", "port": 5555
        }).json()

        # Explicit unsaved values take priority, and neither test nor scan cache is persisted.
        r = client.post(path + "/test", headers=AUTH,
                        json={"url": URL, "username": "easyadb", "password": typed})
        assert r.status_code == 200 and r.json() == {"authorized": True, "found": 1}
        assert logins == [(URL, "easyadb", typed)]
        assert mod.store.get_group_discovery_secret("Home") == (URL, "easyadb", SECRET)
        assert mod.store.get(d["id"])["port"] == 5555
        assert mod.store.last_group_discovery("Home") is None

        # Blank password falls back to the saved secret only for the same source.
        r = client.post(path + "/test", headers=AUTH,
                        json={"url": URL, "username": "easyadb", "password": ""})
        assert r.status_code == 200
        assert logins[-1] == (URL, "easyadb", SECRET)
        n = len(logins)
        for changed in (
            {"url": "http://10.10.10.4/ubus", "username": "easyadb", "password": ""},
            {"url": URL, "username": "other", "password": ""},
        ):
            r = client.post(path + "/test", headers=AUTH, json=changed)
            assert r.status_code == 502 and "请填写专用密钥" in r.json()["detail"]
        assert len(logins) == n

        # A typed but wrong password must NOT silently retry with the saved one.
        r = client.post(path + "/test", headers=AUTH,
                        json={"url": URL, "username": "easyadb", "password": wrong})
        assert r.status_code == 502 and "登录失败" in r.json()["detail"]
        assert logins[-1] == (URL, "easyadb", wrong)
        assert wrong not in r.text

        # Original no-body API and formal scan retain their saved-only behavior.
        assert client.post(path + "/test", headers=AUTH).status_code == 200
        assert client.post(path + "/scan", headers=AUTH).status_code == 200
        assert mod.store.get_group_discovery_secret("Home") == (URL, "easyadb", SECRET)


def test_authorization_test_without_lan_prefix_never_applies_ports(monkeypatch, tmp_path):
    mod = make_module(monkeypatch, tmp_path)
    calls = []
    def transport(url, payload):
        calls.append(payload["params"][2])
        if payload["params"][2] == "login":
            return {"result": [0, {"ubus_rpc_session": "c" * 32}]}
        return {"result": [0, {"code": 0, "stdout": json.dumps(
            devices(("192.168.10.206", 41234))), "stderr": ""}]}
    mod.discovery_client = RpcdDiscovery(transport)
    with TestClient(mod.app) as client:
        assert client.post("/api/groups", headers=AUTH,
                           json={"name": "Home", "ip_prefix": None}).status_code == 201
        saved = client.put("/api/groups/Home/discovery", headers=AUTH,
                           json={"url": URL, "username": "easyadb", "password": SECRET})
        assert saved.status_code == 200
        test = client.post("/api/groups/Home/discovery/test", headers=AUTH)
        assert test.status_code == 200 and test.json() == {"authorized": True, "found": 1}
        scan = client.post("/api/groups/Home/discovery/scan", headers=AUTH)
        assert scan.status_code == 409 and "内网 IP 前缀" in scan.json()["detail"]
        assert client.get("/api/groups/Home/discovery/last", headers=AUTH).json()["last"] is None
        assert calls == ["login", "exec"], "Formal scan without LAN prefix must not call OpenWrt"


def test_unconfigured_not_exposed_and_unauthorized_does_not_scan(monkeypatch, tmp_path):
    mod = make_module(monkeypatch, tmp_path)
    calls = []
    mod.discovery_client = RpcdDiscovery(lambda u, r: calls.append(r) or pytest.fail("Should not scan"))
    with TestClient(mod.app) as client:
        client.post("/api/groups", headers=AUTH, json={"name": "Home", "ip_prefix": "192.168.10.*"})
        assert client.post("/api/groups/Home/discovery/scan", headers=AUTH).status_code == 409
        assert client.post("/api/groups/Home/discovery/scan").status_code == 401
        assert not calls
