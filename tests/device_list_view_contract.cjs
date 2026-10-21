/* Execute production page render with the real injected DeviceListView and legacy fallback. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Element {
  constructor(tag, className = '', text) {
    this.tagName = tag;
    this.className = className;
    this.textContent = text === undefined ? '' : text;
    this.children = [];
    this.events = new Map();
    this.attrs = {};
    this.style = {};
    this.disabled = false;
    this.checked = false;
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  setAttribute(name, value) { this.attrs[name] = value; }
  addEventListener(name, handler) { this.events.set(name, handler); }
  fire(name) {
    const handler = this.events.get(name);
    assert(handler, 'event missing: ' + name);
    handler();
  }
}
const elem = (tag, className = '', text) => new Element(tag, className, text);
const action = (label, callback, className = 'secondary') => {
  const button = elem('button', className, label);
  button.type = 'button';
  button.addEventListener('click', callback);
  return button;
};
function findAll(root, predicate) {
  const matches = [];
  function visit(node) {
    if (predicate(node)) matches.push(node);
    for (const child of node.children) visit(child);
  }
  visit(root);
  return matches;
}
function snapshot(node) {
  return {
    tag: node.tagName, className: node.className, text: node.textContent,
    attrs: node.attrs, style: node.style, open: node.open, disabled: node.disabled,
    checked: node.checked, title: node.title, value: node.value,
    children: node.children.map(snapshot),
  };
}
(async () => {
  const model = await import('../web/features/devices/device-list-model.js');
  const view = await import('../web/features/devices/device-list-view.js');
  const html = fs.readFileSync('web/index.html', 'utf8');
  const main = fs.readFileSync('web/app/main.js', 'utf8');
  const start = html.indexOf('function render(){');
  const end = html.indexOf('async function load(', start);
  assert(start >= 0 && end > start);
  assert(main.includes("import * as deviceListView from '../features/devices/device-list-view.js'"));
  assert(main.includes('  deviceListView,'));
  assert(html.includes('frontendModules.deviceListView.renderDeviceGroups({'));
  const devices = [
    {
      id: 'b', name: 'Pending', group_name: 'Zulu', ip: '10.0.0.2', port: 5555,
      status: 'connecting', active_serial: null, selected_serial: '10.0.0.2:5555',
      selected_route: 'mesh', model: 'Phone B', android_version: '12', lan_ip: '192.168.1.2',
      temp_ip: '10.0.2.2', connect_failed: true,
    },
    {
      id: 'a', name: 'Ready', group_name: 'Zulu', ip: '10.0.0.1', port: 5555,
      status: 'connected', active_serial: '10.0.0.1:5555',
      selected_serial: '10.0.0.1:5555', selected_route: 'mesh', temp_ip: null,
    },
    {
      id: 'c', name: 'Unassigned', group_name: null, ip: '10.0.0.3', port: 5555,
      status: 'idle', active_serial: null, selected_serial: '10.0.0.3:5555',
      selected_route: 'lan',
    },
  ];
  const groups = [
    {name: 'Zulu', ip_prefix: '10.0.0.*', discovery_configured: true},
    {name: 'Empty', ip_prefix: '10.0.8.*', discovery_needs_password: true},
  ];
  const elements = new Map();
  const calls = [];
  const sandbox = {
    devices, groups, selected: 'a', loading: false, loaded: true,
    managementSelected: new Set(['a']), groupOpen: new Map([['named:Empty', false]]),
    scanningGroups: new Set(), connectionBatchBusy: false,
    frontendModules: null, multiView: null, displayLabView: {open: id => calls.push(['lab', id])},
    elem, action, hasConnectedAdb: model.hasConnectedAdb,
    connectedFirst: (a, b) => Number(model.hasConnectedAdb(b)) - Number(model.hasConnectedAdb(a)),
    deviceConnecting: id => id === 'b',
    deviceLocked: id => id === 'b' || sandbox.loading,
    switchRoute: (id, route) => calls.push(['route', id, route]),
    edit: id => calls.push(['edit', id]),
    removeTempAddress: id => calls.push(['remove-temp', id]),
    openFirstPair: id => calls.push(['pair', id]),
    openTempEditor: device => calls.push(['temp', device.id]),
    openGroup: name => calls.push(['group', name]),
    scanGroup: name => calls.push(['scan', name]),
    $(id) {
      if (!elements.has(id)) elements.set(id, elem('div'));
      return elements.get(id);
    },
  };
  const context = vm.createContext(sandbox);
  const legacyStart = html.indexOf('function buildLegacyDeviceGroups()');
  const legacyEnd = html.indexOf('function select(id)', legacyStart);
  assert(legacyStart >= 0 && legacyEnd > legacyStart);
  vm.runInContext(html.slice(legacyStart, legacyEnd) + '\n' + html.slice(start, end), context);
  vm.runInContext('render()', context);
  const before = JSON.stringify(snapshot(elements.get('devices')));
  assert(before.includes('Pending') && before.includes('Ready'));
  let injectedCalls = 0;
  sandbox.frontendModules = {
    deviceList: model,
    deviceListView: {
      renderDeviceGroups(options) {
        injectedCalls++;
        return view.renderDeviceGroups(options);
      },
    },
  };
  vm.runInContext('render()', context);
  assert.equal(injectedCalls, 1, 'production render calls the real module');
  assert.equal(JSON.stringify(snapshot(elements.get('devices'))), before,
    'legacy and injected paths produce the same DOM, ordering and disabled controls');
  assert.equal(elements.get('count').textContent, '3 台设备 · 3 个分组');
  const list = elements.get('devices');
  const checkboxes = findAll(list, node => node.tagName === 'input' && node.type === 'checkbox');
  assert.equal(checkboxes.length, 3);
  const pending = checkboxes.find(node => node.value === 'b');
  assert.equal(pending.disabled, true, 'connecting device remains unavailable');
  const ready = checkboxes.find(node => node.value === 'a');
  ready.checked = false;
  ready.fire('change');
  assert.equal(sandbox.managementSelected.has('a'), false, 'selection state remains page-owned');
  assert.equal(injectedCalls, 2, 'selection redraw goes through the injected module');
  const sections = findAll(elements.get('devices'), node => node.tagName === 'details');
  assert.equal(sections.length, 3);
  assert.equal(sections[1].open, false, 'preexisting collapsed group preference survives');
  sections[1].open = true;
  sections[1].fire('toggle');
  assert.equal(sandbox.groupOpen.get('named:Empty'), true);
  const discovery = findAll(elements.get('devices'),
    node => node.className.includes('group-discovery') && node.textContent === '立即发现 ADB');
  assert.equal(discovery.length, 1);
  discovery[0].fire('click');
  assert.deepEqual(calls.pop(), ['scan', 'Zulu'], 'discovery action remains delegated');
  const titles = findAll(elements.get('devices'), node => node.className === 'item-name');
  assert.equal(titles.find(node => node.textContent === 'Pending').attrs['aria-label'],
    'Pending，设备型号 Phone B，Android 12');
  let settings = 0;
  sandbox.multiView = {
    updatePicker() {},
    projectionButton: device => elem('button', 'device-projector', device.name),
    openSettings: () => { settings++; },
    isBusyFor: () => false,
  };
  vm.runInContext('render()', context);
  const settingsButtons = findAll(elements.get('devices'),
    node => node.className === 'projection-settings-edit');
  assert.equal(settingsButtons.length, 3);
  assert.equal(settingsButtons[0].disabled, true, 'connecting device settings remain locked');
  settingsButtons[1].fire('click');
  assert.equal(settings, 1);
  assert.equal(injectedCalls, 3, 'projection-enabled redraw keeps the production module');
  console.log('Device list view injected/legacy DOM parity, actions and state ownership: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
