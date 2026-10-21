"""Optional lock-screen credential: never public, one guarded attempt per stream."""
import importlib
import threading
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from server.store import DeviceStore
from server import m2_unlock

AUTH = {"X-EasyADB-Token": "local-test-token-123"}

def create_store(tmp_path):
    store = DeviceStore(str(tmp_path / "devices.sqlite3"))
    store.initialize()
    device = store.create({"name": "Lock Phone", "group_name": "", "ip": "10.10.5.2", "port": 5555})
    return store, device

def test_encrypted_persistence_migration_and_purge(tmp_path):
    store, device = create_store(tmp_path)
    device_id = device["id"]
    assert not store.unlock_configured(device_id)
    assert store.get_unlock_secret(device_id) is None
    assert store.save_unlock_secret(device_id, "246810")
    assert store.unlock_configured(device_id)
    assert store.get_unlock_secret(device_id) == "246810"
    db_bytes = store.path.read_bytes()
    assert b"246810" not in db_bytes
    assert b"246810" not in str(store.list()).encode()
    assert b"credential" not in str(store.get(device_id)).encode()
    assert (tmp_path / "devices.sqlite3.unlock.key").is_file()
    reopened = DeviceStore(str(store.path))
    assert reopened.get_unlock_secret(device_id) == "246810"
    reopened.save_unlock_secret(device_id, "Abcd1234")
    assert reopened.get_unlock_secret(device_id) == "Abcd1234"
    assert b"Abcd1234" not in store.path.read_bytes()
    assert reopened.clear_unlock_secret(device_id)
    assert reopened.get_unlock_secret(device_id) is None
    reopened.save_unlock_secret(device_id, "234567")
    reopened.delete(device_id)
    assert not reopened.unlock_configured(device_id)
    for wrong in ("", "123", "has spaces", "中文1234", "abc-1234", "x"*33):
        with pytest.raises(ValueError):
            m2_unlock.validate_password(wrong)

def test_endpoint_never_returns_secret(monkeypatch, tmp_path):
    monkeypatch.setenv("EASYADB_TOKEN", "local-test-token-123")
    mod = importlib.import_module("server.app")
    store, device = create_store(tmp_path)
    monkeypatch.setattr(mod, "store", store)
    with TestClient(mod.app) as client:
        base = "/api/devices/" + device["id"] + "/unlock"
        assert client.get(base, headers=AUTH).json() == {"configured": False}
        assert client.put(base, headers=AUTH, json={"password":"456789"}).json() == {"configured":True}
        assert client.get(base, headers=AUTH).json() == {"configured":True}
        assert "456789" not in client.get("/api/devices", headers=AUTH).text
        assert "456789" not in client.get(base, headers=AUTH).text
        assert client.put(base, headers=AUTH, json={"password":"abc "}).status_code == 400
        assert store.get_unlock_secret(device["id"]) == "456789"
        assert client.put(base, headers=AUTH, json={"password":""}).json() == {"configured":False}
        assert client.get(base, headers=AUTH).json() == {"configured":False}
        assert client.get(base).status_code in (401,403)

class FakeStream:
    def __init__(self):
        self.serial="10.10.5.2:5555"
        self.session_id="session-a"
        self.display_source=None
        self.stop_event=threading.Event()
        self.calls=[]
    def wake_display(self): self.calls.append(("wake",))
    def send_text(self, payload):
        assert payload["session_id"]==self.session_id
        self.calls.append(("text",payload["text"]))
    def send_nav(self,payload):self.calls.append(("nav",payload["key"]))

def test_auto_unlock_guarded_order_and_stop(monkeypatch):
    adb_calls=[]
    def adb(serial,*args,timeout=6):
        adb_calls.append(args)
        if args==("shell","dumpsys","trust"):return "deviceLocked=true"
        if args==("shell","wm","size"):return "Physical size: 1080x2400"
        return ""
    monkeypatch.setattr(m2_unlock, "_run_adb", adb)
    stream=FakeStream()
    assert m2_unlock.automatic_unlock(stream,"123456",sleep=lambda _:None)=="submitted"
    assert stream.calls==[("wake",),("text","123456"),("nav","enter")]
    assert ("shell","input","swipe","540","1920","540","720","240") in adb_calls
    assert all("123456" not in str(call) for call in adb_calls),"never put password in adb argv"
    stream=FakeStream()
    def unlocked(serial,*args,timeout=6):
        return "deviceLocked=false"
    monkeypatch.setattr(m2_unlock,"_run_adb",unlocked)
    assert m2_unlock.automatic_unlock(stream,"123456",sleep=lambda _:None)=="already_unlocked"
    assert stream.calls==[("wake",)],"never type into an already unlocked application"
    stream=FakeStream()
    monkeypatch.setattr(m2_unlock,"_run_adb",lambda *a,**kw:"no supported OEM lock flags")
    assert m2_unlock.automatic_unlock(stream,"123456",sleep=lambda _:None)=="unknown_lock_state"
    assert stream.calls==[("wake",)]
    stream=FakeStream();stream.stop_event.set()
    assert m2_unlock.automatic_unlock(stream,"123456",sleep=lambda _:None)=="skipped"
    assert not stream.calls

def test_all_stream_paths_share_server_owned_secret():
    from pathlib import Path
    app=Path("server/api/live_handler.py").read_text()
    admission=Path("server/services/live_admission.py").read_text()
    client=Path("web/m2-multi.js").read_text()
    compact_client="".join(client.split())
    assert "store.get_unlock_secret(device_id)" in admission
    assert "await asyncio.to_thread(automatic_unlock, stream, password)" in app
    assert '"wake", "unlock", "heartbeat", "webrtc_offer"' in app
    assert 'unlock_secret = prepared.unlock_secret' in app
    assert 'set(message) != {"type", "session_id"}' in app
    assert '"status": "unconfigured"' in app
    assert '"status": "busy"' in app
    assert '"source": "manual"' in app
    assert "manual_secret = await asyncio.to_thread(store.get_unlock_secret, device_id)" in app
    assert "asyncio.create_task(run_unlock_attempt(manual_secret, \"manual\"))" in app
    assert "requestUnlock(card)" in client
    assert "JSON.stringify({type:'unlock',session_id:card.session})" in compact_client
    unlock_body = compact_client[compact_client.index('requestUnlock(card){'):compact_client.index('sendInput(card,type,body){')]
    assert "password" not in unlock_body
    assert "payload.screen_off=card.screenOff" in compact_client
    assert "get_unlock_secret" not in client
    assert "unlock_secret" not in client
    assert "readUnlockSettings" in client and "saveUnlockSettings" in client
    assert "unlock_notice" in client
    init_branch=app[app.index('if kind == "init":'):app.index('elif kind == "screen_power_notice":')]
    assert init_branch.index("touch_ready.set()") < init_branch.index('"type": "init"'), (
        "browser init must never precede server control readiness"
    )

def test_manual_unlock_websocket_uses_current_saved_secret(monkeypatch, tmp_path):
    """Manual retrigger never carries plaintext and can use a newly saved PIN."""
    import queue
    from server.devices import DeviceManager
    from server.m2_live import LiveRegistry

    monkeypatch.setenv("EASYADB_TOKEN", "local-test-token-123")
    mod = importlib.import_module("server.app")
    store, device = create_store(tmp_path)
    monkeypatch.setattr(mod, "store", store)
    monkeypatch.setattr(mod, "manager", DeviceManager(store, mod.adb))
    monkeypatch.setattr(mod, "live_registry", LiveRegistry())
    monkeypatch.setattr(mod, "is_connected", lambda serial: True)
    mod.manager._set_state(device["id"], "connected",
                           serial=device["ip"]+":"+str(device["port"]), route="mesh")
    used=[]
    class Live:
        def __init__(self, serial, profile):
            self.serial=serial;self.profile=profile;self.session_id="session-manual"
            self.finished=threading.Event();self.stop_event=threading.Event()
            self.cleanup_complete=False;self.events=queue.Queue()
        def start(self):
            self.events.put(("init", {"width":720,"height":1280,
                "mime":'video/mp4; codecs="avc1.640028"', "control_available":True}))
        def stop(self):
            self.stop_event.set();self.finished.set();self.cleanup_complete=True
        def join(self,timeout=20):self.finished.wait(timeout)
        def diagnostics(self):return {"stage":"test"}
        def release_touch(self):pass
    monkeypatch.setattr(mod, "LiveVideo", Live)
    monkeypatch.setattr(mod, "automatic_unlock", lambda stream, password:
        (used.append((stream.serial, password)), "submitted")[1])
    def next_notice(ws, status):
        for _ in range(30):
            event=ws.receive_json()
            if event["type"]=="unlock_notice" and event.get("status")==status:
                assert "123456" not in str(event)
                return event
            assert event["type"] in ("starting","init","diagnostic","unlock_notice",
                                     "control_enabled","stopping")
        pytest.fail("missing unlock_notice: "+status)
    with TestClient(mod.app) as client:
        with client.websocket_connect("/api/devices/"+device["id"]+"/m2/live",
                headers={"origin":"http://testserver"}) as ws:
            ws.send_json({"token":"local-test-token-123","player":"webrtc",
                          "profile":"baseline","selected_serial":device["ip"]+":5555"})
            sid=None
            for _ in range(10):
                msg=ws.receive_json()
                if msg["type"]=="starting":
                    sid=msg["session_id"];break
            assert sid=="session-manual"
            # The browser may receive "starting" before scrcpy publishes
            # init; wait for the actual control_available event first.
            for _ in range(20):
                event=ws.receive_json()
                if event["type"]=="init":
                    assert event["control_available"] is True
                    break
            else:pytest.fail("no control init")
            ws.send_json({"type":"unlock","session_id":sid})
            assert next_notice(ws,"unconfigured")["error"] is True
            assert not used
            assert client.put("/api/devices/"+device["id"]+"/unlock",headers=AUTH,
                              json={"password":"123456"}).json()=={"configured":True}
            # An untrusted browser cannot provide arbitrary input fields.
            ws.send_json({"type":"unlock","session_id":sid,"password":"do-not-use"})
            assert next_notice(ws,"invalid")["error"] is True
            assert not used
            ws.send_json({"type":"unlock","session_id":sid})
            next_notice(ws,"running")
            done=next_notice(ws,"submitted")
            assert done["source"]=="manual" and not done["error"]
            assert used==[(device["ip"]+":5555","123456")]
            ws.send_json({"type":"unlock","session_id":sid})
            assert next_notice(ws,"cooldown")["error"] is True
            assert len(used)==1
            ws.send_text("stop")
            for _ in range(20):
                msg=ws.receive_json()
                if msg["type"]=="ended":
                    assert msg["cleanup_complete"] is True
                    break
            else:pytest.fail("no final cleanup")

def test_emui_and_aosp_keyguard_parsers_are_conservative():
    # Some TrustManager builds, including Chromium's Android test fixture,
    # report numeric deviceLocked=1/0 rather than true/false.
    current=' User "Owner" (id=0, flags=0x4c13) (current): trustState=UNTRUSTED, trustManaged=0, deviceLocked='
    assert m2_unlock.parse_trust_lock(current+'1, strongAuthRequired=0x0') is True
    assert m2_unlock.parse_trust_lock(current+'0, strongAuthRequired=0x0') is False
    assert m2_unlock.parse_trust_lock(current+'true, strongAuthRequired=0x0') is True
    assert m2_unlock.parse_trust_lock(current+'false, strongAuthRequired=0x0') is False
    assert m2_unlock.parse_trust_lock('deviceLocked: 1') is True
    assert m2_unlock.parse_trust_lock('mDeviceLocked=false') is False
    assert m2_unlock.parse_trust_lock(
        current+'0\n User "Work" (id=10, flags=0x4c13): trustState=UNTRUSTED, deviceLocked=1'
    ) is False, "never infer owner lock from a managed profile"
    assert m2_unlock.parse_trust_lock(
        ' User "Owner" (id=0, flags=0x4c13): deviceLocked=0\n'
        ' User "Work" (id=10, flags=0x4c13): deviceLocked=1'
    ) is None, "multiuser trust output without current marker is ambiguous"
    assert m2_unlock.parse_trust_lock('deviceLocked=1 deviceLocked=0') is None
    assert m2_unlock.parse_window_lock(
        'mShowingLockscreen=true mShowingDream=false mDreamingLockscreen=false'
    ) is True
    assert m2_unlock.parse_window_lock(
        'isStatusBarKeyguard=false mShowingLockscreen=false'
    ) is False
    assert m2_unlock.parse_window_lock(
        'KeyguardServiceDelegate\n  showing=true\n  occluded=false\n'
        'KeyguardStateMonitor\n  mIsShowing=true\n'
    ) is True
    assert m2_unlock.parse_window_lock('KeyguardStateMonitor\n  mIsShowing=false') is False
    assert m2_unlock.parse_window_lock('mDreamingLockscreen=true') is True
    assert m2_unlock.parse_window_lock('mDreamingLockscreen=false') is None
    assert m2_unlock.parse_window_lock('mKeyguardOccluded=false secure=true') is None
    assert m2_unlock.parse_window_lock(
        'mShowingLockscreen=false isStatusBarKeyguard=true'
    ) is None, "contradictory signals never authorize PIN entry"


def test_mate30_style_numeric_trust_unlock_and_post_swipe_guard(monkeypatch):
    adb_calls=[]
    state={"locked":True}
    def adb(serial,*args,timeout=6):
        adb_calls.append(args)
        if args==("shell","dumpsys","trust"):
            return ('Trust manager state:\n'
                    ' User "Owner" (id=0, flags=0x4c13) (current): '
                    'trustState=UNTRUSTED, trustManaged=0, deviceLocked='
                    +("1" if state["locked"] else "0"))
        if args==("shell","dumpsys","window","policy"):
            return ('KeyguardServiceDelegate\n  showing='
                    +("true" if state["locked"] else "false"))
        if args==("shell","wm","size"):return "Physical size: 1080x2340"
        return ""
    monkeypatch.setattr(m2_unlock,"_run_adb",adb)
    assert m2_unlock.lock_state("10.10.5.2:5555") is True
    stream=FakeStream()
    assert m2_unlock.automatic_unlock(stream,"123456",sleep=lambda _:None)=="submitted"
    assert stream.calls==[("wake",),("text","123456"),("nav","enter")]
    assert all("123456" not in str(call) for call in adb_calls)
    stream=FakeStream()
    def slept(duration):
        if duration==0.45:state["locked"]=False # user/face unlocked after swipe
    assert m2_unlock.automatic_unlock(stream,"123456",sleep=slept)=="already_unlocked"
    assert stream.calls==[("wake",)],"do not type PIN into now-unlocked foreground app"
    state["locked"]=True
    def contradictory(serial,*args,timeout=6):
        if args==("shell","dumpsys","trust"):return "deviceLocked=1"
        if args==("shell","dumpsys","window","policy"):return "mShowingLockscreen=false"
        return ""
    monkeypatch.setattr(m2_unlock,"_run_adb",contradictory)
    assert m2_unlock.lock_state(stream.serial) is None, "conflicting OEM diagnostics fail closed"
    stream=FakeStream()
    assert m2_unlock.automatic_unlock(stream,"123456",sleep=lambda _:None)=="unknown_lock_state"
    assert stream.calls==[("wake",)]
