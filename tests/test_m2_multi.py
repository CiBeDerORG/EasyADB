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
    assert registry.MAX_LIVE_SESSIONS == 20
    streams=[Worker() for _ in range(22)]
    for i in range(20):
        assert registry.reserve(str(i),streams[i]), f"session {i+1} must fit"
    assert len(registry.sessions) == 20
    assert not registry.reserve("20",streams[20]), "21st distinct device rejected"
    assert not registry.reserve("0",streams[20]), "same phone cannot run twice"
    registry.release("0",streams[20])  # foreign object may not free the slot
    assert registry.sessions["0"] is streams[0]
    streams[0].finished.set()
    assert not registry.reserve("20",streams[20]), "dirty stopped worker still counts"
    assert not registry.reserve("0",streams[20]), "dirty same-device worker blocks restart"
    streams[0].cleanup_complete=True
    assert registry.reserve("0",streams[20]), "same device can replace cleaned worker"
    assert len(registry.sessions) == 20
    assert not registry.reserve("20",streams[21]), "replacement did not create a 21st slot"
    registry.release("0",streams[20])
    assert registry.reserve("20",streams[21]), "clean release opens exactly one slot"
    assert len(registry.sessions) == 20


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
                ws.send_json({"token":"local-test-token-123","player":"webrtc",
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
    import re
    monkeypatch.setenv("EASYADB_TOKEN", "local-test-token-123")
    mod = importlib.import_module("server.app")
    compact = lambda value: re.sub(r",(?=[)\]}])", "", re.sub(r"\s+", "", value))
    with TestClient(mod.app) as client:
        def javascript(url):
            response = client.get(url)
            assert response.status_code == 200, url
            assert response.headers["cache-control"] == "no-store", url
            assert response.headers["content-type"].startswith("application/javascript"), url
            return response.text

        multi = javascript("/m2-multi.js")
        javascript("/m2-metrics.js")
        page = javascript("/app/page-controller.js")
        view = javascript("/features/devices/device-list-view.js")
        management_view = javascript("/features/devices/device-management-view.js")
        management = javascript("/features/devices/device-management-controller.js")
        configuration = javascript("/features/devices/device-configuration-controller.js")
        dialogs = javascript("/features/devices/device-dialog-controller.js")
        drawer = javascript("/shared/ui/inventory-drawer.js")
        quality = javascript("/features/live/live-quality-settings.js")
        html = client.get("/").text
        css = client.get("/assets/legacy-page.css").text
        p, v, m, d, config, dialog, manage, q = map(
            compact, (page, view, multi, drawer, configuration, dialogs, management, quality)
        )
        actual = compact(page + view + management_view + management + configuration + dialogs + drawer + multi + quality)
        assert 'id="multiPanel"' in html and 'id="multiGrid"' in html
        assert 'src="/m2-multi.js"' in html and 'src="/m2-metrics.js"' in html
        assert "multiView.closeAll()" in p
        assert not re.search(r"<script\s*>", html), "only the module assembly owns page behavior"
        # Old screenshot panel and hidden single-player state remain absent.
        for marker in ('id="legacySolo"', 'id="shotButton"', 'id="liveVideo"', 'id="previewTitle"',
                       'class="stage-main"', 'class="stage-settings"', 'id="multiProfile"',
                       'class="panel access-panel"', 'class="device-quality"'):
            assert marker not in html
        for marker in ('class="workspace"', 'class="panel inventory-panel"', 'id="inventoryDrawer"',
                       'id="inventoryToggle"', 'id="inventoryPanel"', 'id="inventoryOpacity"',
                       'class="stage-view"', 'id="multiStart"', 'id="multiStop"', 'id="tempDialog"'):
            assert marker in html
        panel = re.search(r'<[^>]+id="inventoryPanel"[^>]*>', html).group()
        assert 'aria-label="设备管理"' in panel and re.search(r"\binert(?:\s|>)", panel)
        assert "panel.inert=true" in d and "panel.inert=false" in d
        assert "inventoryCollapseTimer" not in actual
        assert "documentRef.addEventListener('pointerdown',(event)=>{" in d
        assert "drawer.contains(event.target)" in d
        assert "点击抽屉以外的位置即可立即收起" in html
        picker = re.search(r'<[^>]+id="multiPicker"[^>]*>', html).group()
        assert 'aria-hidden="true"' in picker and re.search(r"\bhidden(?:\s|>)", picker)
        assert "qualityRows.get(d.id)" not in actual
        assert compact("action('✎', () => ui.openProjectionSettings(device), 'projection-settings-edit')") in v
        assert html.index('id="multiStart"') < html.index('id="devices"') < html.index('id="multiGrid"')
        # Live cards flow by each stream's own width, not a fixed column count.
        assert ".multi-grid{display:flex;flex-wrap:wrap;" in css
        assert ".multi-card{flex:0 1 auto;" in css
        assert ".multi-grid[data-count=" not in css
        assert ".multi-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))" not in css
        assert "runPreflight:async(id)" in p
        assert "runVideoProbe:async(id,profile)" in p
        assert "左侧「选择」用于全部批量操作" in html
        assert html.index('<h2>设备管理</h2>') < html.index('id="token"') < html.index('id="load"')
        assert '批量检查状态' in html and '批量停止投屏' in html
        assert compact("if (device.temp_ip) addAddress('临时 IP', 'temp', device.temp_ip)") in v
        assert "/temp-address" in configuration
        for fragment in ("liveState(id)", "startFor(id)", "stopFor(id)", "this._startDevices([d])",
                         "this.lastLiveStatus.set(card.id", "projectionButton(d)"):
            assert fragment in m
        assert "开启此设备投屏" in multi and "关闭此设备投屏" in multi
        assert ".device-port.device-projector.ready,.device-port.device-projector.playing" in css
        assert compact("portWrap.append(ui.hasProjection ? ui.projectionButton(device)") in v
        assert compact("model.append(elem('span', 'device-tooltip-line', 'Android：' + device.android_version))") in v
        assert "item.append(liveRow,playback)" not in m
        assert "getManagementBusy:()=>state.isLoading" in p
        # One management selection Set drives all batch operations and projection.
        for marker in ('id="bulkSelectAll"', 'id="bulkConnect"', 'id="bulkDelete"', 'id="bulkCount"'):
            assert marker in html
        assert "selectedDeviceIds:newSet()" in p
        assert "managementCheck.checked=selectedDeviceIds.has(device.id)" in v
        assert "getBatchSelection:()=>state.selectedDeviceIds" in p
        assert "constpicked=this.getBatchSelection()" in m
        assert "参与本轮投屏" not in multi
        assert "constcandidates=selected.filter((device)=>!isDeviceLocked(device.id))" in p
        assert "pendingDeviceIds:newSet()" in p
        assert compact("await controllers.connection.connectDevices(candidates, skipped, false, '首次加载连接', generation)") in p
        assert "!this.confirmDelete(" in manage and "将从列表永久删除以下 " in management
        assert "state.selectedDeviceIds.clear();render();" in p
        # Route address buttons issue one explicit connect; status checks remain probe-only.
        for fragment in ("action(label + '：' + ip, () => switchRoute(device.id, route), 'address-target')",
                         "portWrap.append(ui.hasProjection ? ui.projectionButton(device) : elem('span', 'device-port', 'ADB ' + device.port))",
                         "addressList.append(...addressRows)", "addressList.append(plus)",
                         "change.title = '编辑 ' + device.name", "row.append(change)",
                         "if (route === 'mesh') {", "name.append(model)", "name.tabIndex = 0",
                         "target.setAttribute('aria-pressed', String(chosen))",
                         "const name = elem('span', 'item-name', device.name)", "title.append(name)",
                         "if (device.model || device.android_version)",
                         "top.append(managementLabel, info); primary.append(top, addressList)",
                         "addressRows.push(row)"):
            assert compact(fragment) in v, fragment
        assert compact("this.getElement('tempSharedPort').value = String(device.port)") in dialog
        assert "multiView.projectionButton(device)" in p
        assert compact("getElement('load').addEventListener('click', loadAndConnect)") in p
        assert "if(current.selected_route!==route)" in config
        for forbidden in ("removeButton=action('删除'", "title.append(change)",
                          "title.append(elem('span','device-model'", "const connect=action('连接'",
                          "function runConnect(id)", "临时 ADB 端口：", "⇄ 切换", "✓ 当前选择",
                          "row.prepend(adbStatusBadge("):
            assert compact(forbidden) not in actual, forbidden
        # Guard both the current view ports and the retired page spellings.
        # Renaming a record or injection port must not weaken these UI contracts.
        for record in ("device", "d"):
            for projection in ("ui", "multiView"):
                assert compact(f"title.append({projection}.projectionButton({record}))") not in actual
            for forbidden in (
                f"primary.append(elem('div','muted','Android '+{record}.android_version))",
                f"primary.append(elem('div','muted','ADB 已连接：'+{record}.active_serial))",
            ):
                assert compact(forbidden) not in actual, forbidden
        for selector in (".device-edit-icon{position:absolute;right:-3px;top:-5px;",
                         ".device-port.device-projector{position:static;",
                         ".device-title:hover .device-model-tooltip", ".device-title:focus-within .device-model-tooltip",
                         "device-title{display:flex;align-items:center;flex-wrap:wrap",
                         ".device-port.device-projector.adb-connected::before",
                         ".device-port.device-projector.adb-failed::before",
                         ".adb-badge.connected{background:#183e31", ".adb-badge.failed{background:#49252e"):
            assert selector in css
        assert ".device-android{" not in css
        # Check the live port chip's actual ADB predicate, not the removed dead badge helper.
        assert "d.status==='connected'&&d.connect_failed!==true&&Boolean(d.selected_serial)&&d.active_serial===d.selected_serial" in m
        assert "d.connect_failed===true||d.status==='error'" in m
        assert "constadbAddress=adbReady?d.active_serial:d.selected_serial" in m
        assert "low_latency:true" in q


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
