/* Markup and production module contracts; behavioral paths run in the page/UI suites. */
'use strict';
const fs = require('node:fs'), assert = require('node:assert/strict');
const {createDOM} = require('./helpers/page-fixture.cjs');
const read = name => fs.readFileSync(name, 'utf8');
const html = read('web/index.html'), css = read('web/assets/legacy-page.css');
const {get} = createDOM(html);
const page = read('web/app/page-controller.js');
const view = read('web/features/devices/device-list-view.js');
const managementView = read('web/features/devices/device-management-view.js');
const connection = read('web/features/devices/device-connection-controller.js');
const management = read('web/features/devices/device-management-controller.js');
const configuration = read('web/features/devices/device-configuration-controller.js');
const dialogs = read('web/features/devices/device-dialog-controller.js');
const groups = read('web/features/devices/group-dialog-controller.js');
const results = read('web/features/devices/group-discovery-view.js');
const toast = read('web/shared/ui/toast.js');
const drawer = read('web/shared/ui/inventory-drawer.js');
const videoUi = read('web/m2-multi.js');
const quality = read('web/features/live/live-quality-settings.js');
// Source checks ignore formatting, including formatter-added trailing commas.
const compact = source => source.replace(/\s+/g, '').replace(/,(?=[)\]}])/g, '');
const has = (source, fragment) => assert(compact(source).includes(compact(fragment)), fragment);
const lacks = (source, fragment) => assert(!compact(source).includes(compact(fragment)), fragment);
const managed = [page, view, managementView, connection, management, configuration, dialogs, groups, results, toast, drawer].join('\n');
assert.match(read('web/app/main.js'), /import\s+\{\s*createPageController\s*\}\s+from\s+'\.\/page-controller\.js'/);
assert.match(html, /<script\s+type="module"\s+src="\/app\/main\.js"><\/script>/);
assert.doesNotMatch(html, /<script\s*>/, 'the markup cannot retain an alternate inline implementation');
for (const id of ['groupDiscoveryPanel', 'groupOpenWrtUrl', 'groupOpenWrtUser', 'groupOpenWrtPassword', 'testGroupDiscovery']) get(id);
assert.equal(get('groupOpenWrtPassword').attrs.type, 'password');
assert.equal(get('groupOpenWrtPassword').attrs.maxlength, '256');
assert.equal(get('groupOpenWrtPassword').attrs.autocomplete, 'new-password');
has(view, 'else if (group.discovery_configured) { const discover = action(');
has(groups, "'/api/groups/' + encodeURIComponent(name) + '/discovery/' + (isTest ? 'test' : 'scan')");
has(page, "toast.showToast(panel, {key: 'discovery:' + name, kind: 'ok'})");
has(page, "toast.showToast('「' + name + '」发现失败：' + text, {key: 'discovery:' + name, kind: 'error'})");
for (const forbidden of ['discoveryResults', '/discovery/last', 'setInterval(', 'setTimeout(scanGroup', 'luci-avahi-scan']) lacks(managed, forbidden);
has(view, "label + '：' + ip, () => switchRoute(device.id, route), 'address-target'");
lacks(view, "route === 'temp' ? ':' + port");
has(view, "ui.hasProjection ? ui.projectionButton(device) : elem('span', 'device-port', 'ADB ' + device.port)");
has(view, "action('✎', () => ui.openProjectionSettings(device), 'projection-settings-edit')");
for (const fragment of ['title.append(portWrap)', 'addressList.append(...addressRows)', 'addressList.append(plus)',
  'row.append(del)', 'row.append(change)', 'name.append(model)', 'name.tabIndex = 0', "if (route === 'mesh') {",
  "change.title = '编辑 ' + device.name", 'if (device.model || device.android_version)',
  "model.append(elem('span', 'device-tooltip-line', '型号：' + device.model))",
  "model.append(elem('span', 'device-tooltip-line', 'Android：' + device.android_version))"]) has(view, fragment);
for (const forbidden of ['row.prepend(adbStatusBadge(', "removeButton = action('删除'", 'title.append(change)',
  'item.append(primary, change)', "const connect = action('连接'", '临时 ADB 端口：']) lacks(managed, forbidden);
has(dialogs, "this.getElement('tempSharedPort').value = String(device.port)");
has(dialogs, 'state.editingTempDeviceId = device.id');
get('tempDialog');
has(configuration, 'if (current.selected_route !== route)');
has(page, "getElement('load').addEventListener('click', loadAndConnect)");
has(page, 'const candidates = state.devices.filter((device) => !isDeviceLocked(device.id))');
has(page, "await controllers.connection.connectDevices(candidates, skipped, false, '首次加载连接', generation)");
has(connection, 'await runConnectionBatch(candidates, async (device) =>');
has(management, "(operation === 'check' ? '/refresh' : '')");
has(management, "method: operation === 'check' ? 'POST' : 'DELETE'");
has(management, 'signal: batch.abortController.signal');
lacks(managed, 'function runConnect(');
has(results, 'export function renderDiscoveryResult(');
for (const state of ['updated', 'unchanged', 'unmatched', 'busy', 'ambiguous', 'conflicting', 'route_conflict']) has(results, state + ':');
has(results, "endpoint.ip + ':' + endpoint.port");
has(groups, "this.dialog.closeDialog('groupDialog')");
has(groups, "this.notify('分组设置已保存', 'ok')");
has(page, "onDeviceSaved: () => dialog.closeDialog('deviceDialog')");
has(configuration, "this.notify('设备已保存', 'ok')");
assert.equal(get('toastHost').className, 'toast-host');
assert(!html.includes('id="message"'));
has(toast, 'function showToast(content,');
has(page, "toast.showToast(text, {key: 'status', kind})");
has(page, 'onProjectionStarted: () => inventoryDrawer.collapse(true)');
has(page, 'onOpenManagement: () => inventoryDrawer.expand()');
for (const id of ['inventoryToggle', 'inventoryOpacity', 'inventoryDrawer']) get(id);
has(drawer, "documentRef.addEventListener('fullscreenchange', syncFullscreen)");
has(drawer, 'toggle.disabled = active');
has(drawer, 'if (active) collapse(true)');
has(drawer, "documentRef.addEventListener('pointerdown', (event) => {");
has(drawer, 'drawer.contains(event.target)');
has(drawer, 'collapse(); }, true)');
has(drawer, 'panel.inert = true');
has(drawer, 'panel.inert = false');
has(drawer, 'easyadb.inventory-transparency');
for (const forbidden of ['function inventoryBusy(', 'function armInventoryTimer(', 'inventoryCollapseTimer', 'inventoryHovered', 'setTimeout(']) lacks(drawer, forbidden);
assert(html.includes('点击抽屉以外的位置即可立即收起'));
for (const selector of ['.device-port.device-projector.adb-connected::before', 'dialog.quality-settings-dialog{',
  '.device-model-tooltip{display:none;position:absolute;', '.device-title:hover .device-model-tooltip',
  '.device-title:focus-within .device-model-tooltip', '.device-port.device-projector{position:static;',
  '.device-edit-icon{position:absolute;right:-3px;top:-5px;', '.toast-host{position:fixed;',
  '.device-port{display:inline-flex;', '.device-addresses{display:flex;flex-wrap:wrap;',
  '.multi-playback-options{grid-column:1/-1;', '.multi-screen:fullscreen .multi-fab{right:14px;top:50%;transform:translateY(-50%);z-index:20;visibility:visible}',
  '.multi-fab .fab-up-stop{bottom:208px;right:0;', 'body.video-fullscreen-active .inventory-drawer{display:none!important}',
  '.inventory-drawer{position:fixed;', 'transform:translateX(calc(-100% + 16px))']) assert(css.includes(selector), selector);
assert(!css.includes('.device-android{'));
const server = read('server/app.py'), discoveryService = read('server/services/group_discovery.py');
const source = read('server/openwrt_discovery.py'), store = read('server/store.py');
const castLab = read('web/display-lab.js'), castBackend = read('server/castplus_lab.py');
assert(store.includes('"endpoints": []'));
assert(castLab.includes("(action==='castrestore'&&!castPending)"));
assert(!castLab.includes("(['cast2','cast3','castrestore'].includes(action)&&!castPending)"));
for (const fragment of ['def _helper_installed(self, serial):', 'self._helper_installed(serial)',
  'def _stop_helper(self, serial):', 'Service not stopped:', 'result["helper_stop_result"] = stop_result']) assert(castBackend.includes(fragment));
assert(castLab.includes('!result.cast_display?.verified'));
assert(castLab.includes("result.note||'B2 已执行，但未验证到 Type 5 CastPlusDisplay"));
assert(!castBackend.includes('请先在当前线路执行华为 B1'));
has(videoUi, 'sel.disabled = busy || !connected;');
lacks(videoUi + quality, "key === 'dpi' && !value.experimental_resolution");
assert(html.includes('可先在手机手动安装 APK'));
assert(server.includes('def _group_scan(group_name, *, persist, test_config: GroupDiscoveryInput | None = None):'));
for (const fragment of ['get_group_discovery_secret(group_name)', 'test_config.password', 'url != saved_url or username != saved_user']) assert(discoveryService.includes(fragment));
assert.match(groups, /if \(isTest\) \{[\s\S]*?groupOpenWrtUrl[\s\S]*?groupOpenWrtUser[\s\S]*?groupOpenWrtPassword[\s\S]*?\}/);
has(groups, 'options.body = JSON.stringify(');
assert(!store.includes('password=excluded.password'));
assert(source.includes('SCANNER = "/usr/libexec/luci-avahi-scan"'));
require('./helpers/display-lab-contract.cjs')().then(() => {
  console.log('M3 real module wiring, configuration, conditional discovery, shared ports and drawer contracts: OK');
}).catch(error => { console.error(error); process.exitCode = 1; });
