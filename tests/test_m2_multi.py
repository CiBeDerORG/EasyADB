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
        assert 'id="inventoryDrawer"' in html and 'id="inventoryToggle"' in html
        assert 'id="inventoryPanel"' in html and 'id="inventoryOpacity"' in html
        assert 'aria-label="设备管理" inert' in html
        assert "inventoryPanel.inert=true" in html and "inventoryPanel.inert=false" in html
        assert "inventoryCollapseTimer" not in html
        assert "document.addEventListener('pointerdown',event=>{" in html
        assert "if(inventoryDrawer.contains(event.target))return;" in html
        assert "点击抽屉以外的位置即可立即收起" in html
        assert 'class="stage-view"' in html
        assert 'class="stage-main"' not in html and 'class="stage-settings"' not in html
        assert 'id="multiPicker" hidden aria-hidden="true"' in html
        assert "qualityRows.get(d.id)" not in html
        assert 'class="device-quality"' not in html
        assert "const configure=action('✎',()=>multiView.openSettings(d),'projection-settings-edit')" in html
        assert 'id="multiStart"' in html and 'id="multiStop"' in html
        assert html.index('id="multiStart"') < html.index('id="devices"') < html.index('id="multiGrid"')
        # Live cards flow by each stream's own width, not a fixed column count.
        assert ".multi-grid{display:flex;flex-wrap:wrap;" in html
        assert ".multi-card{flex:0 1 auto;" in html
        assert ".multi-grid[data-count=" not in html
        assert ".multi-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))" not in html
        assert 'id="multiProfile"' not in html
        assert "runPreflight:async id" in html
        assert "runVideoProbe:async(id,profile)" in html
        assert "左侧「选择」用于全部批量操作" in html
        assert 'class="panel access-panel"' not in html
        assert html.index('<h2>设备管理</h2>') < html.index('id="token"') < html.index('id="load"')
        assert '批量检查状态' in html and '批量停止投屏' in html
        assert "if(d.temp_ip)addAddress('临时 IP','temp',d.temp_ip)" in html
        assert "/temp-address" in html
        multi_js=client.get("/m2-multi.js").text
        assert "liveState(id)" in multi_js
        assert "startFor(id)" in multi_js and "stopFor(id)" in multi_js
        assert "this._startDevices([d])" in multi_js
        assert "this.lastLiveStatus.set(card.id" in multi_js
        assert "projectionButton(d)" in multi_js
        assert "开启此设备投屏" in multi_js and "关闭此设备投屏" in multi_js
        assert ".device-port.device-projector.ready,.device-port.device-projector.playing" in html
        assert "portWrap.append(multiView?multiView.projectionButton(d)" in html
        assert "model.append(elem('span','device-tooltip-line','Android：'+d.android_version))" in html
        assert "item.append(liveRow,playback)" not in multi_js
        assert "getManagementBusy:()=>loading" in html
        # The existing batch-management checkboxes now also drive at-most-four
        # video launches. Destructive actions still require confirmation.
        for marker in ('id="bulkSelectAll"', 'id="bulkConnect"',
                       'id="bulkDelete"', 'id="bulkCount"'):
            assert marker in html
        assert "const managementSelected=new Set()" in html
        assert "managementCheck.checked=managementSelected.has(d.id)" in html
        assert "getBatchSelection:()=>managementSelected" in html
        assert "getBatchSelection" in multi_js
        assert "参与本轮投屏" not in multi_js
        assert "const candidates=picked.filter(d=>!(multiView&&multiView.isBusyFor(d.id)))" in html
        assert "if(!confirm('将从列表永久删除以下 " in html
        assert "managementSelected.clear();render();" in html
        # Route selection acts directly on its IP and triggers one explicit connect.
        # The separate batch status check remains probe-only.
        assert "action(label+'：'+ip,()=>switchRoute(d.id,route),'address-target')" in html
        assert "portWrap.append(multiView?multiView.projectionButton(d):elem('span','device-port','ADB '+d.port))" in html
        assert "addressList.append(...addressRows)" in html
        assert "addressList.append(plus)" in html
        assert "removeButton=action('删除'" not in html
        assert "$('tempSharedPort').value=String(d.port)" in html
        assert 'id="tempDialog"' in html
        assert "multiView.projectionButton(d)" in html
        assert "change.title='编辑 '+d.name" in html
        assert "row.append(change)" in html and "title.append(change)" not in html
        assert "if(route==='mesh'){" in html
        assert ".device-edit-icon{position:absolute;right:-3px;top:-5px;" in html
        assert ".device-port.device-projector{position:static;" in html
        assert "if(multiView)title.append(multiView.projectionButton(d))" not in html
        assert "name.append(model)" in html and "name.tabIndex=0" in html
        assert "if(d.model)title.append(elem('span','device-model'" not in html
        assert "const connect=action('连接'" not in html
        assert "$('load').addEventListener('click',loadAndConnect)" in html
        assert "if(current.selected_route!==route)" in html
        assert "function runConnect(id)" not in html
        assert "临时 ADB 端口：" not in html
        assert "target.setAttribute('aria-pressed',String(chosen))" in html
        assert "⇄ 切换" not in html and "✓ 当前选择" not in html
        assert "const name=elem('span','item-name',d.name)" in html
        assert "title.append(name)" in html
        assert "name.append(model)" in html
        assert ".device-title:hover .device-model-tooltip" in html
        assert ".device-title:focus-within .device-model-tooltip" in html
        assert "if(d.model)title.append(elem('span','device-model'" not in html
        assert "if(d.model||d.android_version)" in html
        assert "device-title{display:flex;align-items:center;flex-wrap:wrap" in html
        assert ".device-android{" not in html
        assert "primary.append(elem('div','muted','Android '+d.android_version))" not in html
        # Header indicator uses actual active_serial for successful ADB,
        # selected_serial only to explain an explicit failed attempt.
        assert "top.append(managementLabel,info);primary.append(top,addressList)" in html
        assert "row.prepend(adbStatusBadge(d))" not in html
        assert "addressRows.push(row)" in html
        assert ".device-port.device-projector.adb-connected::before" in html
        assert ".device-port.device-projector.adb-failed::before" in html
        assert "const connected=d.status==='connected'&&Boolean(d.active_serial)" in html
        assert "d.connect_failed===true||d.status==='error'" in html
        assert "const serial=connected?d.active_serial:(failed?d.selected_serial:null)" in html
        assert "primary.append(elem('div','muted','ADB 已连接：'+d.active_serial))" not in html
        assert ".adb-badge.connected{background:#183e31" in html
        assert ".adb-badge.failed{background:#49252e" in html
        assert "low_latency:true" in multi_js


def test_new_device_and_group_do_not_interrupt_another_live_session(monkeypatch, tmp_path):
    """A live reservation belongs to ONE device; unrelated CRUD stays usable."""
    monkeypatch.setenv("EASYADB_TOKEN", "local-test-token-123")
    mod = importlib.import_module("server.app")
    mod.store = DeviceStore(str(tmp_path / "append.sqlite3"))
    mod.manager = DeviceManager(mod.store, mod.adb)
    mod.live_registry = LiveRegistry()

    class Running:
        def __init__(self):
            self.finished = threading.Event()
            self.cleanup_complete = False
            self.stopped = False

        def stop(self):
            self.stopped = True
            self.cleanup_complete = True
            self.finished.set()

        def join(self, timeout=8):
            self.finished.wait(timeout)

    with TestClient(mod.app) as client:
        first = client.post("/api/devices", headers=AUTH,
                            json={"name": "A", "ip": "10.20.0.1", "port": 5555})
        assert first.status_code == 201
        a_id = first.json()["id"]
        stream = Running()
        assert mod.live_registry.reserve(a_id, stream)

        second = client.post("/api/devices", headers=AUTH,
                             json={"name": "B", "ip": "10.20.0.2", "port": 5555})
        assert second.status_code == 201
        assert second.json()["id"] != a_id

        group = client.post("/api/groups", headers=AUTH, json={"name": "New group"})
        assert group.status_code == 201
        assert mod.live_registry.sessions[a_id] is stream
        assert stream.stopped is False
        assert stream.finished.is_set() is False

        # The browser may connect B explicitly later; creating it never
        # starts a video session or reconnects it in the background.
        assert set(mod.live_registry.sessions) == {a_id}
    assert stream.stopped is True  # only TestClient shutdown stops the worker
    mod.live_registry.release(a_id, stream)
    assert not mod.live_registry.sessions
