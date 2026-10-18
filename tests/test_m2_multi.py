"""M2-05/06: bounded per-session process counters and independent device slots."""
import importlib
import queue
import threading

from fastapi.testclient import TestClient

from server.devices import DeviceManager
from server.store import DeviceStore
from server.m2_live import LiveRegistry
from server.m2_resources import ProcessMeter, process_counters

AUTH = {"X-EasyADB-Token": "local-test-token-123"}


def test_linux_process_counters_are_local_and_best_effort(tmp_path):
    path = tmp_path / "4321"
    path.mkdir()
    # Field numbers following the final ')' begin at process state (#3).
    data = ["S"] + ["0"] * 30
    data[11], data[12], data[21] = "120", "80", "256"
    (path / "stat").write_text("4321 (ffmpeg tricky name) " + " ".join(data))
    cpu, rss = process_counters(4321, proc_root=tmp_path)
    assert cpu > 0 and rss > 0
    assert process_counters(4322, proc_root=tmp_path) is None
    assert process_counters("4321", proc_root=tmp_path) is None


def test_session_process_sampler_requires_no_background_task():
    meter = ProcessMeter()
    def reader(pid):
        return {11:(1.0,1048576),22:(2.0,2097152)}.get(pid)
    first=meter.sample([11,22], now=10, reader=reader)
    assert first["proc_cpu_pct"] is None
    assert first["proc_rss_mib"] == 3.0
    def later(pid):
        return {11:(1.4,1048576),22:(2.6,2097152)}.get(pid)
    second=meter.sample([11,22], now=11, reader=later)
    assert second["proc_cpu_pct"] == 100.0
    assert second["proc_rss_mib"] == 3.0
    assert meter.sample([], now=12, reader=later)["proc_cpu_pct"] is None


def test_registry_limits_distinct_devices_and_releases_only_same_session():
    class Worker:
        def __init__(self):
            self.finished=threading.Event()
            self.cleanup_complete=False
    registry=LiveRegistry()
    streams=[Worker() for _ in range(5)]
    for i in range(4):
        assert registry.reserve(str(i),streams[i])
    assert not registry.reserve("4",streams[4])
    assert not registry.reserve("0",streams[4])
    registry.release("0",streams[4])
    assert registry.sessions["0"] is streams[0]
    streams[0].finished.set()
    assert not registry.reserve("4",streams[4])
    streams[0].cleanup_complete=True
    assert registry.reserve("0",streams[4])
    assert not registry.reserve("4",Worker())  # still four device slots
    registry.release("0",streams[4])
    assert registry.reserve("4",Worker())


def next_type(ws,kind):
    for _ in range(20):
        msg=ws.receive_json()
        if msg["type"]==kind:
            return msg
        assert msg["type"] in ("starting","init","diagnostic","stopping","control_enabled","input_accepted")
    raise AssertionError("missing "+kind)


def test_two_device_sessions_and_controls_are_not_cross_routed(monkeypatch,tmp_path):
    monkeypatch.setenv("EASYADB_TOKEN","local-test-token-123")
    mod=importlib.import_module("server.app")
    mod.store=DeviceStore(str(tmp_path/"multi.sqlite3"))
    mod.manager=DeviceManager(mod.store,mod.adb)
    mod.live_registry=LiveRegistry()
    monkeypatch.setattr(mod,"is_connected",lambda serial:True)
    created={}

    class FakeStream:
        def __init__(self,serial,profile):
            self.serial=serial;self.profile=profile
            self.session_id="session-"+serial
            self.finished=threading.Event()
            self.cleanup_complete=False
            self.events=queue.Queue()
            self.commands=[]
            created[serial]=self
        def start(self):
            self.events.put(("init",{"width":720,"height":1280,
                "mime":'video/mp4; codecs="avc1.640028"',"control_available":True}))
        def stop(self):
            self.cleanup_complete=True
            self.finished.set()
        def join(self,timeout=20):
            self.finished.wait(timeout)
        def diagnostics(self):return {"stage":"test"}
        def send_text(self,p):self.commands.append(("text",p["text"],p["session_id"]))
        def send_nav(self,p):self.commands.append(("nav",p["key"],p["session_id"]))
        def release_touch(self):pass

    monkeypatch.setattr(mod,"LiveVideo",FakeStream)
    with TestClient(mod.app) as client:
        devices=[]
        for n in (1,2):
            d=client.post("/api/devices",headers=AUTH,json={
                "name":"Phone "+str(n),"ip":"10.10.30."+str(200+n),"port":40455
            }).json()
            mod.manager._set_state(d["id"],"connected",
                                   serial=d["selected_serial"],route="mesh")
            devices.append(d)
        def open_ws(d):
            return client.websocket_connect(f"/api/devices/{d['id']}/m2/live",
                headers={"origin":"http://testserver"})
        with open_ws(devices[0]) as a,open_ws(devices[1]) as b:
            for ws,d in zip((a,b),devices):
                ws.send_json({"token":"local-test-token-123","player":"mse",
                              "profile":"baseline","selected_serial":d["selected_serial"]})
            aid=next_type(a,"starting")["session_id"]
            bid=next_type(b,"starting")["session_id"]
            assert aid!=bid
            next_type(a,"init");next_type(b,"init")
            a.send_json({"type":"control_enable","session_id":aid})
            next_type(a,"control_enabled")
            a.send_json({"type":"input_text","session_id":aid,"text":"PhoneA"})
            next_type(a,"input_accepted")
            assert created[devices[0]["selected_serial"]].commands==[("text","PhoneA",aid)]
            assert created[devices[1]["selected_serial"]].commands==[]
            b.send_json({"type":"control_enable","session_id":bid})
            next_type(b,"control_enabled")
            b.send_json({"type":"nav_key","session_id":bid,"key":"back"})
            next_type(b,"input_accepted")
            assert created[devices[1]["selected_serial"]].commands==[("nav","back",bid)]
            a.send_text("stop")
            assert next_type(a,"ended")["cleanup_complete"] is True
            assert devices[0]["id"] not in mod.live_registry.sessions
            assert devices[1]["id"] in mod.live_registry.sessions
            b.send_text("stop")
            assert next_type(b,"ended")["cleanup_complete"] is True
        assert not mod.live_registry.sessions


def test_multi_page_and_static_modules_are_served(monkeypatch):
    monkeypatch.setenv("EASYADB_TOKEN","local-test-token-123")
    mod=importlib.import_module("server.app")
    with TestClient(mod.app) as client:
        for url in ("/m2-metrics.js","/m2-multi.js"):
            r=client.get(url)
            assert r.status_code==200
            assert r.headers["cache-control"]=="no-store"
        html=client.get("/").text
        assert 'id="multiPanel"' in html and 'id="multiGrid"' in html
        assert 'src="/m2-multi.js"' in html and 'src="/m2-metrics.js"' in html
        assert "multiView.closeAll()" in html
        # Old screenshot panel and hidden single-player state are completely gone.
        assert 'id="legacySolo"' not in html
        assert 'id="shotButton"' not in html and 'id="liveVideo"' not in html
        assert 'id="previewTitle"' not in html
        assert 'class="workspace"' in html
        assert 'class="panel inventory-panel"' in html
        assert 'class="stage-main"' in html
        assert 'class="stage-settings"' in html and 'class="stage-view"' in html
        assert 'id="multiProfile"' not in html
        assert "runPreflight:async id" in html
        assert "runVideoProbe:async(id,profile)" in html
        assert "任意勾选 1～4 台" in html
