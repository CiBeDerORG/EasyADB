/* D3 configuration behavior and page integration; no network or real devices. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
async function until(predicate) {
  for (let index = 0; index < 30; index++) {
    if (predicate()) return;
    await tick();
  }
  assert.fail('expected asynchronous progress did not arrive');
}
const makeDevices = () => [1, 2].map(number => ({
  id: String(number), name: 'Phone ' + number, group_name: 'Home',
  ip: '10.0.0.' + number, mesh_ip: '10.0.0.' + number,
  lan_ip: '192.168.0.' + number, temp_ip: '172.16.0.' + number, port: 5555,
  selected_route: 'mesh', selected_serial: '10.0.0.' + number + ':5555',
  active_serial: '10.0.0.' + number + ':5555', status: 'connected', connect_failed: false,
}));
const payload = {name: 'Updated phone', group_name: 'Work', ip: '10.1.2.3', port: 6000};
function configurationResult(entry) {
  const body = entry.body;
  let device = {...entry.device};
  if (entry.path === '/api/devices') {
    device = {...makeDevices()[0], ...body, id: 'new', mesh_ip: body.ip};
  } else if (entry.path.endsWith('/route')) {
    device.selected_route = body.route;
  } else if (entry.path.endsWith('/temp-address')) {
    device.temp_ip = body.ip;
    if (body.port !== null) device.port = body.port;
    if (!body.ip && device.selected_route === 'temp') device.selected_route = 'mesh';
  } else if (!entry.path.endsWith('/connect')) {
    device = {...device, ...body, mesh_ip: body.ip};
  }
  const ip = device.selected_route === 'lan' ? device.lan_ip :
    device.selected_route === 'temp' ? device.temp_ip : device.mesh_ip || device.ip;
  device.selected_serial = ip + ':' + device.port;
  device.status = entry.path.endsWith('/connect') ? 'connected' : 'idle';
  device.active_serial = entry.path.endsWith('/connect') ? device.selected_serial : null;
  return device;
}
function fixture(factory) {
  const state = {
    devices: makeDevices(), selectedDeviceId: '2', isLoaded: true, isLoading: false,
    generation: 0, activeOperation: null,
  };
  const server = new Map(state.devices.map(device => [device.id, {...device}]));
  const requests = [], reloads = [], messages = [], saved = [], deviceErrors = [], tempErrors = [];
  const changes = [], events = [], confirmations = [], busy = new Set(), connecting = new Set();
  const behavior = {deferRequests: false, onRequest: null, refresh: null, confirm: true, onConfirm: null, onChange: null};
  function response(entry, updateServer = true) {
    const device = configurationResult(entry);
    if (updateServer) server.set(device.id, device);
    return {json: async () => device};
  }
  const controller = factory({
    state,
    request: async (path, options = {}) => {
      assert.equal(state.isLoading, true, 'the current configuration operation owns the page lock');
      const deviceId = decodeURIComponent(path.split('/')[3] || '');
      const entry = {path, deviceId, method: options.method, body: options.body && JSON.parse(options.body),
        headers: options.headers, signal: options.signal, device: {...server.get(deviceId)}, pending: deferred()};
      requests.push(entry); events.push('request:' + path);
      if (behavior.onRequest) await behavior.onRequest(entry);
      if (behavior.deferRequests) return entry.pending.promise;
      return response(entry);
    },
    refreshDevices: async () => {
      reloads.push(true); events.push('refresh');
      if (behavior.refresh) return behavior.refresh();
      state.devices = [...server.values()];
      return true;
    },
    isDeviceBusy: id => busy.has(id) || connecting.has(id),
    isDeviceConnecting: id => connecting.has(id),
    confirmRemoveTemp: text => {
      confirmations.push(text);
      if (behavior.onConfirm) behavior.onConfirm();
      return behavior.confirm;
    },
    onChange: () => {
      changes.push({loading: state.isLoading, operation: state.activeOperation});
      if (behavior.onChange) behavior.onChange();
    },
    notify: (text, kind = '') => { messages.push({text, kind}); events.push('notify:' + kind); },
    onDeviceSaved: device => { saved.push(device); events.push('saved'); },
    onDeviceError: error => deviceErrors.push(error),
    onTempError: error => tempErrors.push(error),
  });
  return {state, server, controller, behavior, requests, reloads, messages, saved, deviceErrors, tempErrors,
    changes, events, confirmations, busy, connecting, response,
    finish(entry) { entry.pending.resolve(response(entry)); }};
}

async function checkDeviceSaving(factory) {
  for (const id of [null, '1']) {
    const f = fixture(factory);
    assert.equal(f.requests.length, 0, 'constructing a controller is passive');
    const selection = new Set(['2']);
    f.state.selectedDeviceIds = selection;
    const result = await f.controller.saveDevice(id, payload);
    assert.equal(result, true);
    assert.deepEqual(f.requests.map(entry => [entry.path, entry.method]),
      [[id ? '/api/devices/1' : '/api/devices', id ? 'PUT' : 'POST']]);
    assert.deepEqual(f.requests[0].body, payload);
    assert.equal(f.requests[0].headers['Content-Type'], 'application/json');
    assert.equal(f.state.selectedDeviceId, id || 'new');
    assert.equal(f.saved.length, 1);
    assert.equal(f.saved[0].id, id || 'new');
    assert(f.events.indexOf('saved') < f.events.indexOf('refresh'),
      'successful saving closes its device editor before the metadata reload');
    assert.deepEqual(f.reloads, [true]);
    assert.equal(f.state.isLoading, false);
    assert.equal(f.state.activeOperation, null);
    assert.equal(f.state.selectedDeviceIds, selection);
    assert.deepEqual([...selection], ['2'], 'saving does not alter batch selection');
  }
  for (const stage of ['request', 'json']) {
    const f = fixture(factory);
    if (stage === 'request') f.behavior.onRequest = () => { throw Error('save rejected'); };
    else {
      f.behavior.deferRequests = true;
    }
    const run = f.controller.saveDevice('1', payload);
    if (stage === 'json') f.requests[0].pending.resolve({json: async () => { throw Error('bad saved body'); }});
    assert.equal(await run, false);
    assert.equal(f.state.selectedDeviceId, '2');
    assert.equal(f.saved.length, 0);
    assert.equal(f.deviceErrors.length, 1);
    assert.equal(f.reloads.length, 0, 'failed persistence does not pretend that a save completed');
    assert.equal(f.state.isLoading, false);
    assert.equal(f.state.activeOperation, null);
  }
  for (const shouldThrow of [false, true]) {
    const f = fixture(factory);
    f.behavior.refresh = () => { if (shouldThrow) throw Error('metadata unavailable'); return false; };
    assert.equal(await f.controller.saveDevice(null, payload), true,
      'a successful save is not repeated because its later metadata reload failed');
    assert.equal(f.saved.length, 1);
    assert.equal(f.state.selectedDeviceId, 'new');
    assert.equal(f.deviceErrors.length, 0);
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.reloads, [true]);
    assert(f.messages.some(entry => entry.kind === 'error' && entry.text.includes('刷新')));
    assert.equal(f.state.isLoading, false);
  }
}

async function checkEligibility(factory) {
  const actions = [
    f => f.controller.saveDevice('1', payload),
    f => f.controller.saveTempAddress('1', '10.9.8.7', 6666),
    f => f.controller.removeTempAddress('1'),
    f => f.controller.switchRoute('1', 'lan'),
  ];
  for (const cause of ['loading', 'unloaded', 'connecting', 'live', 'missing']) {
    for (const action of actions) {
      const f = fixture(factory);
      if (cause === 'loading') f.state.isLoading = true;
      if (cause === 'unloaded') f.state.isLoaded = false;
      if (cause === 'connecting') f.connecting.add('1');
      if (cause === 'live') f.busy.add('1');
      if (cause === 'missing') f.state.devices = f.state.devices.filter(device => device.id !== '1');
      assert.equal(await action(f), false, 'unavailable target must be rejected: ' + cause);
      assert.equal(f.requests.length, 0, 'rejected target causes no configuration or ADB request');
      assert.equal(f.reloads.length, 0);
      assert.equal(f.state.isLoading, cause === 'loading', 'an unrelated lock cannot be released');
    }
  }
  for (const shouldCreate of [false, true]) {
    const f = fixture(factory);
    f.connecting.add('2'); f.busy.add('2');
    f.state.connectionBatchBusy = true;
    assert.equal(await f.controller.saveDevice(shouldCreate ? null : '1', payload), true,
      'other connecting/live devices do not prevent creating or editing an idle device');
    assert.equal(f.requests.length, 1);
  }
  const f = fixture(factory);
  f.state.isLoading = true;
  f.controller.invalidate();
  assert.equal(f.state.isLoading, true, 'invalidating no owned operation leaves another lock intact');
}

async function checkTemporaryAddresses(factory) {
  const f = fixture(factory);
  assert.equal(await f.controller.saveTempAddress('1', '10.9.8.7', 6666), true);
  assert.deepEqual(f.requests.map(entry => [entry.path, entry.method, entry.body]),
    [['/api/devices/1/temp-address', 'PUT', {ip: '10.9.8.7', port: 6666}]]);
  assert.equal(f.state.devices[0].port, 6666);
  assert.equal(f.state.devices[0].selected_route, 'mesh');
  assert.equal(f.state.selectedDeviceId, '2');
  assert.deepEqual(f.reloads, [true]);
  f.behavior.confirm = false;
  assert.equal(await f.controller.removeTempAddress('1'), false);
  assert.equal(f.requests.length, 1, 'cancelled confirmation does not remove the address');
  f.behavior.confirm = true;
  assert.equal(await f.controller.removeTempAddress('1'), true);
  assert.deepEqual(f.requests[1].body, {ip: null, port: null});
  assert.equal(f.state.devices[0].port, 6666, 'removal preserves the shared ADB port');
  assert.equal(f.state.devices[0].temp_ip, null);
  assert(f.confirmations[0].includes('共用端口保持不变'));
  assert(f.requests.every(entry => entry.path.endsWith('/temp-address')),
    'temporary address saving/removal never changes routes or explicitly connects');
  assert.equal(f.saved.length, 0);
  assert.equal(f.state.isLoading, false);

  const failed = fixture(factory);
  failed.behavior.onRequest = () => { throw Error('temporary address collision'); };
  assert.equal(await failed.controller.saveTempAddress('1', '10.9.8.7', 6666), false);
  assert.equal(failed.tempErrors.length, 1);
  assert.deepEqual(failed.reloads, [true]);
  assert.equal(failed.state.isLoading, false);
  assert.equal(failed.state.activeOperation, null);

  const changed = fixture(factory);
  changed.behavior.onConfirm = () => changed.busy.add('1');
  assert.equal(await changed.controller.removeTempAddress('1'), false);
  assert.equal(changed.requests.length, 0, 'confirmation does not bypass a new busy state');
}

async function checkRouteRequests(factory) {
  for (const route of ['mesh', 'lan', 'temp']) {
    const f = fixture(factory);
    f.behavior.onRequest = entry => {
      if (entry.path.endsWith('/connect')) {
        assert.equal(f.state.devices[0].selected_route, route,
          'route response is applied before the one explicit connection');
      }
    };
    assert.equal(await f.controller.switchRoute('1', route), true);
    assert.deepEqual(f.requests.map(entry => [entry.path, entry.method]), route === 'mesh'
      ? [['/api/devices/1/connect', 'POST']]
      : [['/api/devices/1/route', 'PUT'], ['/api/devices/1/connect', 'POST']]);
    if (route !== 'mesh') assert.deepEqual(f.requests[0].body, {route});
    assert.equal(f.state.devices[0].selected_route, route);
    assert.equal(f.state.devices[0].active_serial, f.state.devices[0].selected_serial);
    assert.equal(f.requests.filter(entry => entry.path.endsWith('/connect')).length, 1);
    assert.deepEqual(f.reloads, [true]);
    assert.equal(f.state.selectedDeviceId, '2');
    assert.equal(f.state.isLoading, false);
    assert.equal(f.state.activeOperation, null);
  }
  for (const suffix of ['/route', '/connect']) {
    const f = fixture(factory);
    f.behavior.onRequest = entry => { if (entry.path.endsWith(suffix)) throw Error('route/connection failed'); };
    assert.equal(await f.controller.switchRoute('1', 'lan'), false);
    assert.deepEqual(f.requests.map(entry => entry.path), suffix === '/route'
      ? ['/api/devices/1/route'] : ['/api/devices/1/route', '/api/devices/1/connect']);
    assert.deepEqual(f.reloads, [true]);
    assert.equal(f.state.devices[0].selected_route, suffix === '/route' ? 'mesh' : 'lan',
      'failed explicit connection must not fall back to the old route');
    assert.equal(f.state.isLoading, false);
  }
  for (const cause of ['busy', 'removed', 'address']) {
    const f = fixture(factory);
    f.behavior.deferRequests = true;
    const run = f.controller.switchRoute('1', 'lan');
    const pending = f.requests[0];
    if (cause === 'busy') f.busy.add('1');
    if (cause === 'removed') f.state.devices = f.state.devices.filter(device => device.id !== '1');
    if (cause === 'address') f.state.devices = f.state.devices.map(device => device.id === '1'
      ? {...device, selected_serial: '10.8.8.8:7777'} : device);
    f.finish(pending);
    assert.equal(await run, false);
    assert.equal(f.requests.length, 1,
      'a changed target between saving the route and connecting stops the second request: ' + cause);
    assert.equal(f.state.isLoading, false);
  }
}

async function checkStaleOperations(factory) {
  const cases = [
    {name: 'new-save-response', begin: f => f.controller.saveDevice(null, payload)},
    {name: 'edit-save-json', begin: f => f.controller.saveDevice('1', payload), json: true},
    {name: 'temporary-response', begin: f => f.controller.saveTempAddress('1', '10.9.8.7', 6666)},
    {name: 'route-response', begin: f => f.controller.switchRoute('1', 'lan')},
    {name: 'route-json', begin: f => f.controller.switchRoute('1', 'lan'), json: true},
    {name: 'connect-response', begin: f => f.controller.switchRoute('1', 'mesh')},
    {name: 'connect-json', begin: f => f.controller.switchRoute('1', 'mesh'), json: true},
  ];
  for (const scenario of cases) {
    for (const shouldReject of [false, true]) {
      const f = fixture(factory);
      f.behavior.deferRequests = true;
      const oldRun = scenario.begin(f), oldRequest = f.requests[0];
      const lateJson = deferred();
      let jsonStarted = false;
      if (scenario.json) {
        oldRequest.pending.resolve({json() { jsonStarted = true; return lateJson.promise; }});
        await until(() => jsonStarted);
      }
      f.state.generation++;
      f.controller.invalidate();
      assert.equal(oldRequest.signal.aborted, true, scenario.name);
      assert.equal(f.state.isLoading, false);
      assert.equal(f.state.activeOperation, null);
      f.state.devices = makeDevices().map(device => ({...device, name: 'Replacement ' + device.name}));
      f.state.selectedDeviceId = '2';
      const replacement = f.state.devices;
      const newRun = f.controller.saveTempAddress('1', '10.4.3.2', 7777);
      const newOperation = f.state.activeOperation;
      const counts = [f.messages.length, f.saved.length, f.deviceErrors.length, f.tempErrors.length, f.changes.length];
      if (scenario.json) {
        if (shouldReject) lateJson.reject(Error('old JSON failed'));
        else lateJson.resolve(configurationResult(oldRequest));
      } else if (shouldReject) oldRequest.pending.reject(Error('old request failed'));
      else oldRequest.pending.resolve(f.response(oldRequest, false));
      assert.equal(await oldRun, false, scenario.name);
      assert.equal(f.state.devices, replacement, 'old result cannot overwrite replacement rows');
      assert.equal(f.state.selectedDeviceId, '2');
      assert.equal(f.state.activeOperation, newOperation);
      assert.equal(f.state.isLoading, true, 'old finally cannot release a replacement operation');
      assert.deepEqual([f.messages.length, f.saved.length, f.deviceErrors.length, f.tempErrors.length, f.changes.length], counts,
        'old success/error cannot close an editor, redraw or overwrite status');
      assert.equal(f.requests.length, 2, 'old route save cannot connect under new credentials');
      assert.equal(f.reloads.length, 0);
      f.finish(f.requests[1]);
      assert.equal(await newRun, true);
      assert.equal(f.state.isLoading, false);
      assert.equal(f.state.activeOperation, null);
      assert.deepEqual(f.reloads, [true]);
    }
  }
}

async function checkRefreshInvalidation(factory) {
  for (const action of [
    f => f.controller.saveDevice('1', payload),
    f => f.controller.saveTempAddress('1', '10.9.8.7', 6666),
    f => f.controller.switchRoute('1', 'mesh'),
  ]) {
    for (const shouldReject of [false, true]) {
      const f = fixture(factory), pendingRefresh = deferred();
      f.behavior.refresh = () => pendingRefresh.promise;
      const oldRun = action(f);
      await until(() => f.reloads.length === 1);
      f.state.generation++;
      f.controller.invalidate();
      f.state.devices = makeDevices();
      const replacement = f.state.devices;
      f.behavior.refresh = null; f.behavior.deferRequests = true;
      const newRun = f.controller.saveTempAddress('1', '10.4.3.2', 7777);
      const newOperation = f.state.activeOperation;
      const count = f.messages.length;
      if (shouldReject) pendingRefresh.reject(Error('old final GET failed'));
      else pendingRefresh.resolve(false);
      assert.equal(await oldRun, false);
      assert.equal(f.state.devices, replacement);
      assert.equal(f.state.activeOperation, newOperation);
      assert.equal(f.state.isLoading, true);
      assert.equal(f.messages.length, count);
      f.finish(f.requests.at(-1));
      assert.equal(await newRun, true);
      assert.equal(f.state.isLoading, false);
    }
  }
}

async function checkMetadataInterleaving(factory) {
  for (const stage of ['before-route-response', 'before-connect-response']) {
    const f = fixture(factory), original = {...f.state.devices[0]};
    f.behavior.deferRequests = true;
    const run = f.controller.switchRoute('1', 'lan');
    const routeRequest = f.requests[0], target = configurationResult(routeRequest);
    if (stage === 'before-route-response') {
      f.state.devices = f.state.devices.map(device => device.id === '1' ? target : device);
    }
    f.finish(routeRequest);
    await until(() => f.requests.length === 2);
    if (stage === 'before-connect-response') {
      f.state.devices = f.state.devices.map(device => device.id === '1' ? original : device);
    }
    f.finish(f.requests[1]);
    assert.equal(await run, true, 'metadata snapshots of this operation cannot invalidate its route: ' + stage);
    assert.equal(f.requests.filter(entry => entry.path.endsWith('/connect')).length, 1);
    assert.equal(f.state.devices[0].selected_route, 'lan');
    assert.equal(f.state.devices[0].status, 'connected');
  }
  for (const action of [
    f => f.controller.saveDevice('1', payload),
    f => f.controller.saveTempAddress('1', '10.9.8.7', 6666),
    f => f.controller.switchRoute('1', 'lan'),
  ]) {
    const f = fixture(factory);
    let shouldThrow = true;
    f.behavior.onChange = () => {
      if (shouldThrow && f.state.isLoading) { shouldThrow = false; throw Error('initial render failed'); }
    };
    assert.equal(await action(f), false);
    assert.equal(f.state.isLoading, false, 'initial redraw failure cannot strand the page lock');
    assert.equal(f.state.activeOperation, null);
    assert.equal(f.requests.length, 0);
  }
}

class Element {
  constructor(tag, className = '', textContent = '') {
    Object.assign(this, {tagName: tag, className, textContent, children: [], events: new Map(),
      attrs: {}, style: {}, value: '', checked: false, disabled: false, hidden: false, open: false, closeCount: 0});
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  setAttribute(name, value) { this.attrs[name] = value; }
  addEventListener(name, handler) { this.events.set(name, handler); }
  fire(name, event = {}) {
    assert(this.events.has(name), 'missing page event: ' + name);
    return this.events.get(name)({preventDefault() {}, target: this, ...event});
  }
  reset() {}
  focus() { this.focused = true; }
  showModal() { this.open = true; }
  close() {
    this.open = false; this.closeCount++;
    if (this.events.has('close')) this.fire('close');
  }
}
function findAll(root, predicate) {
  return [...(predicate(root) ? [root] : []), ...root.children.flatMap(child => findAll(child, predicate))];
}
async function pageFixture(factory, shouldBootstrap = true) {
  const {createDeviceConnectionController} = await import('../web/features/devices/device-connection-controller.js');
  const {createDeviceManagementController} = await import('../web/features/devices/device-management-controller.js');
  const model = await import('../web/features/devices/device-list-model.js');
  const view = await import('../web/features/devices/device-list-view.js');
  const html = fs.readFileSync('web/index.html', 'utf8');
  const main = fs.readFileSync('web/app/main.js', 'utf8');
  assert(main.includes("from '../features/devices/device-configuration-controller.js'"));
  const section = (first, last) => {
    const start = html.indexOf(first), end = html.indexOf(last, start);
    assert(start >= 0 && end > start, 'missing page boundary: ' + first);
    return html.slice(start, end);
  };
  const elements = new Map(), events = new Map(), requests = [], messages = [], busy = new Set();
  const server = new Map(makeDevices().map(device => [device.id, device]));
  const behavior = {confirm: true, deferRequests: false, deferGets: false, onRequest: null};
  const controllers = {}, factoryCounts = {configuration: 0, connection: 0, management: 0};
  const elem = (tag, className = '', textContent = '') => new Element(tag, className, textContent);
  const action = (label, callback, className = 'secondary') => {
    const button = elem('button', className, label); button.addEventListener('click', callback); return button;
  };
  const live = {isBusyFor: id => busy.has(id), updatePicker() {}, closeAll() {},
    projectionButton: device => elem('button', 'projector', device.name), openSettings() {}};
  const response = (entry, updateServer = true) => {
    const device = configurationResult(entry);
    if (updateServer) server.set(device.id, device);
    return {json: async () => device};
  };
  const sandbox = {
    AbortController, elem, action, LIVE: live,
    document: {
      getElementById(id) {
        if (!elements.has(id)) {
          const element = elem('div'); element.value = id === 'token' ? 'current-token' : '';
          elements.set(id, element);
        }
        return elements.get(id);
      },
      createElement: tag => elem(tag),
      addEventListener(name, callback) { events.set(name, callback); },
    },
    api: async (path, options = {}) => {
      const deviceId = decodeURIComponent(path.split('/')[3] || '');
      const entry = {path, deviceId, method: options.method || 'GET', body: options.body && JSON.parse(options.body),
        signal: options.signal, device: {...server.get(deviceId)}, pending: deferred()};
      requests.push(entry);
      if (behavior.onRequest) await behavior.onRequest(entry);
      if (entry.method === 'GET') {
        if (behavior.deferGets) return entry.pending.promise;
        return {json: async () => path === '/api/groups' ? [] : [...server.values()]};
      }
      if (behavior.deferRequests) return entry.pending.promise;
      return response(entry);
    },
    confirm: () => behavior.confirm, message: (text, kind) => messages.push({text, kind}), dismissToast() {},
    hasConnectedAdb: model.hasConnectedAdb,
    connectedFirst: (left, right) => Number(model.hasConnectedAdb(right)) - Number(model.hasConnectedAdb(left)),
    openGroup() {}, scanGroup() {}, openFirstPair() {},
  };
  const setup = section('const $=id=>', 'const inventoryDrawer=') + '\nconst toastItems=new Map();\n' +
    section('let frontendModules=', 'function toastSelected(') +
    section("document.addEventListener('easyadb:frontend-modules-ready'", '// Browser requests') +
    section('function buildLegacyDeviceGroups()', 'function select(id)') +
    section('function render(){', 'function openGroup(') +
    section('function beginConfigurationOperation(){', '// Each connect uses') +
    section("$('token').addEventListener('input'", "$('bulkSelectAll').addEventListener") +
    section("$('closeDialog').addEventListener", "$('refreshAll').addEventListener") + `
multiView=LIVE;
globalThis.readState=()=>({devices,groups,selected,editing,editingTemp,loaded,loading,connectGeneration,
 managementSelected,connectingDevices,connectionBatchBusy,configurationOperation});
globalThis.installRows=rows=>{devices=rows;loaded=true;render();};
globalThis.openDevice=id=>openModal(id);
globalThis.openTemp=id=>openTempEditor(devices.find(device=>device.id===id));
globalThis.runRoute=(id,route)=>switchRoute(id,route);
globalThis.removeTemp=id=>removeTempAddress(id);
globalThis.setConnectionBatch=value=>{connectionBatchBusy=value;};
`;
  const context = vm.createContext(sandbox);
  vm.runInContext(setup, context, {filename: 'device-configuration-page.js'});
  sandbox.installRows(makeDevices());
  const detail = {
    deviceList: model, deviceListView: view,
    createDeviceConnectionController(options) {
      factoryCounts.connection++; controllers.connection = createDeviceConnectionController(options); return controllers.connection;
    },
    createDeviceManagementController(options) {
      factoryCounts.management++; controllers.management = createDeviceManagementController(options); return controllers.management;
    },
    createDeviceConfigurationController(options) {
      factoryCounts.configuration++; controllers.configuration = factory(options); return controllers.configuration;
    },
  };
  const bootstrap = () => events.get('easyadb:frontend-modules-ready')({detail});
  if (shouldBootstrap) { bootstrap(); bootstrap(); }
  return {elements, requests, messages, busy, server, behavior, controllers, factoryCounts, sandbox, bootstrap, response,
    finish(entry) { entry.pending.resolve(response(entry)); }};
}

async function checkPageActions(factory) {
  const f = await pageFixture(factory), state = () => f.sandbox.readState();
  assert.deepEqual(f.factoryCounts, {configuration: 1, connection: 1, management: 1});
  assert.equal(f.requests.length, 0, 'real page bootstrap remains passive');
  assert.equal(f.controllers.configuration.state.devices, state().devices);
  assert.equal(f.controllers.connection.state.devices, state().devices);
  const selection = state().managementSelected; selection.add('2');
  assert.equal(f.controllers.management.state.selectedDeviceIds, selection);
  state().connectingDevices.add('2'); f.sandbox.setConnectionBatch(true);
  f.sandbox.openDevice(null);
  assert.equal(f.elements.get('deviceDialog').open, true);
  for (const [id, value] of Object.entries({name: ' Raw Name ', group: ' Raw Group ', ip: ' 10.9.9.9 ', port: '6001'})) {
    f.sandbox.document.getElementById(id).value = value;
  }
  assert.equal(await f.elements.get('form').fire('submit'), true);
  assert.deepEqual(f.requests.map(entry => [entry.path, entry.method]), [
    ['/api/devices', 'POST'], ['/api/devices', 'GET'], ['/api/groups', 'GET'],
  ]);
  assert.deepEqual(f.requests[0].body, {name: ' Raw Name ', group_name: ' Raw Group ', ip: '10.9.9.9', port: 6001});
  assert.equal(state().selected, 'new');
  assert.equal(f.elements.get('deviceDialog').open, false);
  assert.deepEqual([...selection], ['2']);
  const editButton = findAll(f.elements.get('devices'), node => node.title === '编辑 Phone 1')[0];
  assert(editButton); editButton.fire('click');
  assert.equal(state().editing, '1');
  assert.equal(f.elements.get('name').value, 'Phone 1');
  f.elements.get('name').value = 'Edited Phone 1';
  assert.equal(await f.elements.get('form').fire('submit'), true);
  assert.equal(f.requests[3].path, '/api/devices/1');
  assert.equal(f.requests[3].method, 'PUT');
  assert.equal(state().selected, '1');
  assert.equal(state().connectionBatchBusy, true, 'D3 does not take ownership of the D1 queue');
  state().connectingDevices.clear(); f.sandbox.setConnectionBatch(false);
  f.sandbox.openTemp('1');
  f.elements.get('tempIp').value = ' 10.9.8.7 ';
  f.elements.get('tempSharedPort').value = '6666';
  const beforeTemp = f.requests.length;
  await f.elements.get('tempForm').fire('submit');
  assert.equal(f.elements.get('tempDialog').open, false);
  assert.deepEqual(f.requests[beforeTemp].body, {ip: '10.9.8.7', port: 6666});
  assert.equal(f.requests[beforeTemp].path, '/api/devices/1/temp-address');
  assert(f.requests.slice(0, beforeTemp + 1).every(entry => !entry.path.endsWith('/connect')));
  f.behavior.confirm = false;
  const beforeRemove = f.requests.length;
  assert.equal(await f.sandbox.removeTemp('1'), false);
  assert.equal(f.requests.length, beforeRemove);
  f.behavior.confirm = true;
  assert.equal(await f.sandbox.removeTemp('1'), true);
  assert.deepEqual(f.requests[beforeRemove].body, {ip: null, port: null});
  const routeButton = findAll(f.elements.get('devices'), node =>
    node.className === 'address-target' && node.textContent === '内网 IP：192.168.0.1')[0];
  assert(routeButton);
  const beforeRoute = f.requests.length;
  assert.equal(await routeButton.fire('click'), true);
  assert.deepEqual(f.requests.slice(beforeRoute).map(entry => [entry.path, entry.method]), [
    ['/api/devices/1/route', 'PUT'], ['/api/devices/1/connect', 'POST'],
    ['/api/devices', 'GET'], ['/api/groups', 'GET'],
  ]);
  assert.deepEqual([...selection], ['2']);
  assert.equal(state().loading, false);
  assert.equal(state().configurationOperation, null);
}

async function checkPageInvalidation(factory) {
  for (const scenario of ['save', 'temp', 'route']) {
    for (const shouldReject of [false, true]) {
      const f = await pageFixture(factory, false);
      f.behavior.deferRequests = true;
      let oldRun;
      if (scenario === 'save') {
        f.sandbox.openDevice('1');
        oldRun = f.elements.get('form').fire('submit');
      } else if (scenario === 'temp') {
        f.sandbox.openTemp('1');
        oldRun = f.elements.get('tempForm').fire('submit');
      } else oldRun = f.sandbox.runRoute('1', 'lan');
      const oldRequest = f.requests[0], oldOperation = f.sandbox.readState().configurationOperation;
      assert(oldOperation, 'legacy mutation establishes shared operation ownership');
      f.bootstrap();
      assert.equal(f.controllers.configuration.state.activeOperation, oldOperation);
      f.elements.get('token').value = 'replacement-token';
      f.elements.get('token').fire('input');
      assert.equal(oldRequest.signal.aborted, true);
      assert.equal(f.sandbox.readState().loading, false);
      f.sandbox.installRows(makeDevices());
      f.sandbox.openDevice('2');
      f.sandbox.openTemp('2');
      const newRows = f.sandbox.readState().devices;
      const newRun = f.elements.get('form').fire('submit');
      const newOperation = f.sandbox.readState().configurationOperation;
      const counts = [f.messages.length, f.elements.get('deviceDialog').closeCount, f.elements.get('tempDialog').closeCount];
      if (shouldReject) oldRequest.pending.reject(Error('old configuration failed'));
      else oldRequest.pending.resolve(f.response(oldRequest, false));
      await oldRun;
      assert.equal(f.sandbox.readState().devices, newRows);
      assert.equal(f.sandbox.readState().configurationOperation, newOperation);
      assert.equal(f.sandbox.readState().loading, true);
      assert.deepEqual([f.messages.length, f.elements.get('deviceDialog').closeCount, f.elements.get('tempDialog').closeCount], counts,
        'old legacy result cannot close replacement dialogs or overwrite messages');
      assert.equal(f.requests.length, 2, 'stale route request cannot issue a connection using new credentials');
      f.finish(f.requests[1]);
      assert.equal(await newRun, true);
      assert.equal(f.sandbox.readState().loading, false);
    }
  }
}

async function checkPageMetadataInterleaving(factory) {
  const f = await pageFixture(factory), initial = makeDevices();
  f.behavior.deferRequests = true; f.behavior.deferGets = true;
  const run = f.sandbox.runRoute('1', 'lan');
  const routeRequest = f.requests[0], target = configurationResult(routeRequest);
  const firstLoad = f.controllers.connection.loadDevices(true);
  const firstLists = f.requests.filter(entry => entry.method === 'GET');
  for (const entry of firstLists) entry.pending.resolve({json: async () => entry.path === '/api/groups' ? [] : [target, initial[1]]});
  assert.equal(await firstLoad, true);
  assert.equal(f.sandbox.readState().devices[0].selected_route, 'lan');
  f.finish(routeRequest);
  await until(() => f.requests.some(entry => entry.path.endsWith('/connect')));
  const connectRequest = f.requests.find(entry => entry.path.endsWith('/connect'));
  const secondLoad = f.controllers.connection.loadDevices(true);
  const secondLists = f.requests.filter(entry => entry.method === 'GET').slice(2);
  for (const entry of secondLists) entry.pending.resolve({json: async () => entry.path === '/api/groups' ? [] : initial});
  assert.equal(await secondLoad, true);
  assert.equal(f.sandbox.readState().devices[0].selected_route, 'mesh');
  f.behavior.deferGets = false;
  f.finish(connectRequest);
  assert.equal(await run, true, 'real D1 list reads can interleave without cancelling the explicit route operation');
  assert.equal(f.sandbox.readState().devices[0].selected_route, 'lan');
  assert.equal(f.sandbox.readState().devices[0].status, 'connected');
  assert.equal(f.requests.filter(entry => entry.path.endsWith('/connect')).length, 1);
  assert.equal(f.sandbox.readState().loading, false);
}

(async () => {
  const {createDeviceConfigurationController} = await import('../web/features/devices/device-configuration-controller.js');
  await checkDeviceSaving(createDeviceConfigurationController);
  await checkEligibility(createDeviceConfigurationController);
  await checkTemporaryAddresses(createDeviceConfigurationController);
  await checkRouteRequests(createDeviceConfigurationController);
  await checkStaleOperations(createDeviceConfigurationController);
  await checkRefreshInvalidation(createDeviceConfigurationController);
  await checkMetadataInterleaving(createDeviceConfigurationController);
  await checkPageActions(createDeviceConfigurationController);
  await checkPageInvalidation(createDeviceConfigurationController);
  await checkPageMetadataInterleaving(createDeviceConfigurationController);
  console.log('D3 configuration controller: CRUD, temporary address, route coordination, lifecycle and real page integration: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
