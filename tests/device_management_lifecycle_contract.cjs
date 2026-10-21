/* Run the production D2 controller and page adapter without network or real devices. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const tick = () => new Promise(resolve => setImmediate(resolve));
const makeDevices = (count = 3) => Array.from({length: count}, (_, index) => ({
  id: String(index + 1), name: 'Phone ' + (index + 1), status: 'connected',
  ip: '10.0.0.' + (index + 1), port: 5555, selected_route: 'mesh',
  selected_serial: '10.0.0.' + (index + 1) + ':5555',
  active_serial: '10.0.0.' + (index + 1) + ':5555', connect_failed: false,
}));
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
function fixture(createController, initial = makeDevices()) {
  const state = {
    devices: initial.map(device => ({...device})), selectedDeviceIds: new Set(),
    selectedDeviceId: null, isLoaded: true, isLoading: false, generation: 0, activeBatch: null,
  };
  const busy = new Set(), connecting = new Set();
  const requests = [], reloads = [], messages = [], confirmations = [], renders = [];
  const behavior = {confirm: true, deferRequests: false, onRequest: null, reload: null};
  const request = async (path, options = {}) => {
    const deviceId = decodeURIComponent(path.split('/')[3]);
    assert(path === '/api/devices/' + encodeURIComponent(deviceId) ||
      path === '/api/devices/' + encodeURIComponent(deviceId) + '/refresh');
    assert(options.method === 'DELETE' || options.method === 'POST');
    assert.equal(options.method === 'POST', path.endsWith('/refresh'),
      'management must not connect, change routes, scan or start a session');
    const entry = {path, method: options.method, signal: options.signal, deviceId,
      device: {...state.devices.find(device => device.id === deviceId)}, pending: deferred()};
    requests.push(entry);
    assert.equal(state.isLoading, true, 'the batch retains the page lock during its own I/O');
    if (behavior.onRequest) await behavior.onRequest(entry);
    if (behavior.deferRequests) return entry.pending.promise;
    return {json: async () => ({...entry.device, status: 'checked'})};
  };
  const controller = createController({
    state, request,
    isDeviceConnecting: deviceId => connecting.has(deviceId),
    isDeviceBusy: deviceId => busy.has(deviceId) || connecting.has(deviceId),
    confirmDelete: text => { confirmations.push(text); return behavior.confirm; },
    refreshDevices: async () => {
      reloads.push(true);
      return behavior.reload ? behavior.reload() : true;
    },
    onChange: () => renders.push({loading: state.isLoading, selected: [...state.selectedDeviceIds]}),
    notify: (text, kind = '') => messages.push({text, kind}),
  });
  const finish = entry => entry.pending.resolve({
    json: async () => ({...entry.device, status: 'checked'}),
  });
  return {state, controller, behavior, busy, connecting, requests, reloads, messages,
    confirmations, renders, finish};
}

function checkSelection(createController) {
  const f = fixture(createController);
  const selected = f.state.selectedDeviceIds;
  f.connecting.add('2');
  f.busy.add('3');
  assert.equal(f.requests.length, 0, 'construction has no network side effects');
  f.controller.selectDevice('1', true);
  f.controller.selectDevice('2', true);
  f.controller.selectDevice('3', true);
  f.controller.selectDevice('missing', true);
  assert.deepEqual([...selected], ['1', '3'],
    'connecting phones are unavailable; projecting phones remain selectable');
  f.controller.selectDevice('1', false);
  assert.deepEqual([...selected], ['3']);
  selected.add('2');
  f.controller.selectAll(false);
  assert.deepEqual([...selected], ['2'], 'unselect-all preserves pending devices already selected');
  f.controller.selectAll(true);
  assert.deepEqual([...selected].sort(), ['1', '2', '3']);
  f.state.isLoading = true;
  f.controller.selectAll(false);
  f.controller.selectDevice('1', false);
  f.controller.invalidate();
  assert.equal(f.state.isLoading, true, 'cancelling no management batch cannot release another lock');
  assert.deepEqual([...selected].sort(), ['1', '2', '3']);
  f.state.isLoading = false;
  f.state.isLoaded = false;
  f.controller.selectAll(false);
  assert.deepEqual([...selected].sort(), ['1', '2', '3']);
  assert.equal(f.state.selectedDeviceIds, selected, 'selection is never replaced or cloned');
  assert.equal(f.requests.length, 0);
}

async function checkBatchResults(createController, method) {
  const isDelete = method === 'deleteSelected';
  const f = fixture(createController, makeDevices(6));
  for (const device of f.state.devices.slice(0, 5)) f.state.selectedDeviceIds.add(device.id);
  f.state.selectedDeviceId = '1';
  f.busy.add('4');
  f.connecting.add('5');
  f.behavior.onRequest = entry => {
    if (entry.deviceId === '1') f.busy.add('3');
    if (entry.deviceId === '2') throw Error('request failed for Phone 2');
  };
  const selection = f.state.selectedDeviceIds;
  await f.controller[method]();
  assert.deepEqual(f.requests.map(entry => entry.deviceId), ['1', '2'],
    'the page lock must not skip candidates; busy states are rechecked before every request');
  assert.equal(f.requests[0].method, isDelete ? 'DELETE' : 'POST');
  assert.deepEqual(f.reloads, [true], 'one final metadata-only refresh');
  assert.equal(f.state.isLoading, false);
  assert.equal(f.state.activeBatch, null);
  assert.equal(f.state.selectedDeviceIds, selection);
  assert.equal(f.confirmations.length, isDelete ? 1 : 0);
  if (isDelete) {
    assert(f.confirmations[0].includes('3 台设备'));
    assert(f.confirmations[0].includes('Phone 1、Phone 2、Phone 3'));
    assert(!f.confirmations[0].includes('Phone 6'), 'unselected devices are never deletion targets');
    assert.deepEqual([...selection], ['2', '3', '4', '5']);
    assert.equal(f.state.selectedDeviceId, null);
  } else {
    assert.deepEqual([...selection], ['1', '2', '3', '4', '5']);
    assert.equal(f.state.selectedDeviceId, '1');
    assert.equal(f.state.devices[0].status, 'checked');
    assert.equal(f.state.devices[1].status, 'connected');
  }
  const summary = f.messages.at(-1);
  assert(summary.text.includes(isDelete ? '已删除 1 台' : '已检查 1 台'));
  assert(summary.text.includes(isDelete ? '其他未删除 2 台' : '其他失败/跳过 2 台'));
  assert(summary.text.includes('Phone 2') && summary.text.includes('Phone 3'));
  assert(summary.text.includes(isDelete ? '预先跳过投屏中 2 台' : '投屏中预先跳过 2 台'),
    'pre-busy devices retain their separate count in the summary');
  assert.equal(summary.kind, 'error');

  // Cancellation and empty selections must not take a lock or refresh metadata.
  const cancelled = fixture(createController);
  cancelled.state.selectedDeviceIds.add('1');
  cancelled.behavior.confirm = false;
  await cancelled.controller.deleteSelected();
  assert.equal(cancelled.requests.length, 0);
  assert.equal(cancelled.reloads.length, 0);
  assert.equal(cancelled.state.isLoading, false);
  assert.equal(cancelled.state.activeBatch, null);
  assert.deepEqual([...cancelled.state.selectedDeviceIds], ['1']);
  cancelled.state.selectedDeviceIds.clear();
  await cancelled.controller[method]();
  assert.equal(cancelled.requests.length, 0);
  assert.equal(cancelled.reloads.length, 0);
}

async function checkSerialRequests(createController, method) {
  const f = fixture(createController, makeDevices(3));
  for (const device of f.state.devices) f.state.selectedDeviceIds.add(device.id);
  f.behavior.deferRequests = true;
  const run = f.controller[method]();
  assert.equal(f.requests.length, 1, 'management keeps the existing serial request order');
  await f.controller[method]();
  assert.equal(f.requests.length, 1, 'repeated click while loading cannot launch another batch');
  f.requests[0].pending.reject(Error('first device offline'));
  await until(() => f.requests.length === 2);
  f.finish(f.requests[1]);
  await until(() => f.requests.length === 3);
  f.finish(f.requests[2]);
  await run;
  assert.deepEqual(f.requests.map(entry => entry.deviceId), ['1', '2', '3']);
  assert.deepEqual(f.reloads, [true]);
  assert.equal(f.state.isLoading, false);
  assert(f.messages.at(-1).text.includes(method === 'deleteSelected' ? '已删除 2 台' : '已检查 2 台'));
}

async function checkRefreshFailure(createController, method) {
  for (const shouldThrow of [false, true]) {
    const f = fixture(createController, makeDevices(1));
    f.state.selectedDeviceIds.add('1');
    f.behavior.reload = () => {
      if (shouldThrow) throw Error('metadata unavailable');
      return false;
    };
    await f.controller[method]();
    assert.equal(f.state.isLoading, false, 'refresh failure cannot strand the page lock');
    assert.equal(f.state.activeBatch, null);
    assert.deepEqual(f.reloads, [true]);
    assert(f.messages.some(message => message.kind === 'error' && message.text.includes('刷新')),
      'a failed final refresh is reported instead of claiming a clean completion');
    assert.equal(f.state.selectedDeviceIds.has('1'), method !== 'deleteSelected',
      'the completed operation is retained even if the metadata refresh fails');
  }
}

async function checkStaleResults(createController, method) {
  const outcomes = method === 'checkSelected'
    ? ['success', 'failure', 'json-success', 'json-failure'] : ['success', 'failure'];
  for (const outcome of outcomes) {
    const f = fixture(createController, makeDevices(2));
    const selection = f.state.selectedDeviceIds;
    selection.add('1'); selection.add('2');
    f.state.selectedDeviceId = '1';
    f.behavior.deferRequests = true;
    const oldRun = f.controller[method]();
    const oldRequest = f.requests[0];
    const lateJson = deferred();
    let jsonStarted = false;
    if (outcome.startsWith('json-')) {
      oldRequest.pending.resolve({json() { jsonStarted = true; return lateJson.promise; }});
      await until(() => jsonStarted);
    }
    f.state.generation++;
    f.controller.invalidate();
    f.controller.invalidate();
    assert.equal(oldRequest.signal.aborted, true);
    assert.equal(f.state.activeBatch, null);
    assert.equal(f.state.isLoading, false);
    f.state.devices = makeDevices(2).map(device => ({...device, name: 'New ' + device.name}));
    f.state.selectedDeviceId = '1';
    selection.clear(); selection.add('1'); selection.add('2');
    const newRows = f.state.devices;
    const newRun = f.controller[method]();
    const newBatch = f.state.activeBatch;
    const messagesBefore = f.messages.length, rendersBefore = f.renders.length;
    if (outcome === 'failure') oldRequest.pending.reject(Error('old authorization error'));
    else if (outcome === 'json-failure') lateJson.reject(Error('old body failed'));
    else if (outcome === 'json-success') lateJson.resolve({...oldRequest.device, status: 'old'});
    else f.finish(oldRequest);
    await oldRun;
    assert.equal(f.state.devices, newRows, 'late old results cannot replace new credential rows');
    assert.deepEqual([...selection], ['1', '2'], 'old deletion cannot clear the new same-ID selection');
    assert.equal(f.state.selectedDeviceId, '1');
    assert.equal(f.state.activeBatch, newBatch);
    assert.equal(f.state.isLoading, true, 'old finally cannot release the new batch lock');
    assert.equal(f.messages.length, messagesBefore, 'old success/failure stays silent');
    assert.equal(f.renders.length, rendersBefore);
    assert.equal(f.requests.length, 2, 'invalidated old batch must not start its next request');
    assert.equal(f.reloads.length, 0, 'invalidated old batch must not start a final refresh');
    f.finish(f.requests[1]);
    await until(() => f.requests.length === 3);
    f.finish(f.requests[2]);
    await newRun;
    assert.equal(f.state.isLoading, false);
    assert.equal(f.state.activeBatch, null);
    assert.deepEqual(f.reloads, [true]);
  }
}

async function checkStaleFinalRefresh(createController) {
  for (const shouldReject of [false, true]) {
    const f = fixture(createController, makeDevices(1));
    f.state.selectedDeviceIds.add('1');
    const lateRefresh = deferred();
    f.behavior.reload = () => lateRefresh.promise;
    const oldRun = f.controller.checkSelected();
    await until(() => f.reloads.length === 1);
    f.state.generation++;
    f.controller.invalidate();
    f.state.devices = makeDevices(1);
    f.behavior.deferRequests = true;
    f.behavior.reload = null;
    const newRun = f.controller.checkSelected();
    const newBatch = f.state.activeBatch;
    const beforeMessages = f.messages.length;
    if (shouldReject) lateRefresh.reject(Error('old metadata failure'));
    else lateRefresh.resolve(false);
    await oldRun;
    assert.equal(f.state.activeBatch, newBatch);
    assert.equal(f.state.isLoading, true);
    assert.equal(f.messages.length, beforeMessages);
    f.finish(f.requests.at(-1));
    await newRun;
    assert.equal(f.state.isLoading, false);
    assert.deepEqual(f.reloads, [true, true]);
  }
}

class Element {
  constructor(tag, className = '', text = '') {
    Object.assign(this, {tagName: tag, className, textContent: text,
      children: [], events: new Map(), attrs: {}, style: {}, checked: false, disabled: false});
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  setAttribute(name, value) { this.attrs[name] = value; }
  addEventListener(name, handler) { this.events.set(name, handler); }
  fire(name) { assert(this.events.has(name), 'missing event ' + name); return this.events.get(name)(); }
}
function findAll(root, predicate) {
  return [...(predicate(root) ? [root] : []), ...root.children.flatMap(child => findAll(child, predicate))];
}

async function checkPageIntegration(createManagementController, legacyOutcome = null) {
  const {createDeviceConnectionController} = await import('../web/features/devices/device-connection-controller.js');
  const model = await import('../web/features/devices/device-list-model.js');
  const view = await import('../web/features/devices/device-list-view.js');
  const html = fs.readFileSync('web/index.html', 'utf8');
  const main = fs.readFileSync('web/app/main.js', 'utf8');
  assert(main.includes("from '../features/devices/device-management-controller.js'"));
  assert(main.includes('createDeviceManagementController: deviceManagement.createDeviceManagementController'),
    'the production entry point must supply the real management factory to the page');
  const section = (first, last) => {
    const start = html.indexOf(first), end = html.indexOf(last, start);
    assert(start >= 0 && end > start, 'page boundary missing: ' + first);
    return html.slice(start, end);
  };
  const elements = new Map(), events = new Map(), requests = [], messages = [];
  const busy = new Set(), server = new Map(makeDevices().map(device => [device.id, device]));
  const behavior = {confirm: true, defer: false, deferLists: false};
  let management, connection, managementFactories = 0, connectionFactories = 0, liveOptions, closes = 0;
  const elem = (tag, className = '', text = '') => new Element(tag, className, text);
  const action = (label, callback, className = 'secondary') => {
    const button = elem('button', className, label);
    button.addEventListener('click', callback);
    return button;
  };
  const live = {
    isBusyFor: id => busy.has(id), updatePicker() {},
    projectionButton: device => elem('button', 'projector', device.name), openSettings() {},
    closeAll() { closes++; },
  };
  const sandbox = {
    AbortController, elem, action,
    document: {
      getElementById(id) {
        if (!elements.has(id)) {
          const element = elem('div'); element.value = id === 'token' ? 'test-token' : '';
          elements.set(id, element);
        }
        return elements.get(id);
      },
      addEventListener(event, callback) { events.set(event, callback); },
    },
    api: async (path, options = {}) => {
      const entry = {path, method: options.method || 'GET', signal: options.signal, pending: deferred()};
      requests.push(entry);
      if (entry.method === 'GET') {
        if (behavior.deferLists) return entry.pending.promise;
        return {json: async () => path === '/api/groups' ? [] : [...server.values()]};
      }
      if (behavior.defer) return entry.pending.promise;
      const id = decodeURIComponent(path.split('/')[3]);
      if (entry.method === 'DELETE') server.delete(id);
      return {json: async () => ({...server.get(id), status: 'connected'})};
    },
    confirm: () => behavior.confirm, message: (text, kind) => messages.push({text, kind}),
    dismissToast() {}, hasConnectedAdb: model.hasConnectedAdb,
    connectedFirst: (left, right) => Number(model.hasConnectedAdb(right)) - Number(model.hasConnectedAdb(left)),
    switchRoute() {}, edit() {}, removeTempAddress() {}, openFirstPair() {}, openTempEditor() {},
    openGroup() {}, scanGroup() {}, collapseInventory() {}, expandInventory() {},
    EasyADBMulti: {create(options) { liveOptions = options; return live; }},
  };
  const setup = section('const $=id=>', 'const inventoryDrawer=') + '\nconst toastItems=new Map();\n' +
    section('let frontendModules=', 'function toastSelected(') +
    section("document.addEventListener('easyadb:frontend-modules-ready'", '// Browser requests') +
    section('function buildLegacyDeviceGroups()', 'function select(id)') +
    section('function render(){', 'function reset()') +
    section("$('token').addEventListener", "$('bulkConnect').addEventListener") +
    section("$('bulkDelete').addEventListener", "$('newDevice').addEventListener") +
    section("$('refreshAll').addEventListener", "window.addEventListener('beforeunload'") +
    section('multiView=EasyADBMulti.create({', 'multiView.groupControl=') + `
globalThis.readState=()=>({devices,groups,selected,loaded,loading,connectGeneration,
 managementSelected,connectingDevices,connectSnapshots,connectionBatchBusy,connectController,managementBatch});
globalThis.installRows=rows=>{devices=rows;loaded=true;render();};
`;
  const context = vm.createContext(sandbox);
  vm.runInContext(setup, context, {filename: 'device-management-page.js'});
  sandbox.installRows(makeDevices());
  const selection = sandbox.readState().managementSelected;
  const detail = {
    deviceList: model, deviceListView: view,
    createDeviceManagementController(options) {
      managementFactories++; management = createManagementController(options); return management;
    },
    createDeviceConnectionController(options) {
      connectionFactories++; connection = createDeviceConnectionController(options); return connection;
    },
  };
  if (legacyOutcome?.startsWith('refresh-')) {
    events.get('easyadb:frontend-modules-ready')({detail});
    selection.add('1'); selection.add('2');
    behavior.deferLists = true;
    const oldRun = elements.get('refreshAll').fire('click');
    await until(() => requests.filter(entry => entry.method === 'GET').length === 2);
    const oldLists = requests.filter(entry => entry.method === 'GET');
    elements.get('token').fire('input');
    assert.equal(sandbox.readState().loading, false);
    behavior.deferLists = false; behavior.defer = true;
    const replacement = makeDevices(2).map(device => ({...device, name: 'New ' + device.name}));
    sandbox.installRows(replacement);
    selection.add('1'); selection.add('2');
    const newRun = elements.get('refreshAll').fire('click');
    const newBatch = sandbox.readState().managementBatch;
    const messageCount = messages.length, requestCount = requests.length;
    for (const entry of oldLists) {
      if (legacyOutcome === 'refresh-failure' && entry.path === '/api/devices') {
        entry.pending.reject(Error('old credential GET failed'));
      } else {
        entry.pending.resolve({json: async () => entry.path === '/api/groups' ? [] : makeDevices()});
      }
    }
    await oldRun;
    assert.equal(sandbox.readState().devices, replacement,
      'real D1 metadata reader cannot restore an old list during D2 final refresh');
    assert.deepEqual([...selection], ['1', '2']);
    assert.equal(sandbox.readState().managementBatch, newBatch);
    assert.equal(sandbox.readState().loading, true);
    assert.equal(messages.length, messageCount);
    assert.equal(requests.length, requestCount);
    requests.at(-1).pending.resolve({json: async () => replacement[0]});
    await until(() => requests.length === requestCount + 1);
    requests.at(-1).pending.resolve({json: async () => replacement[1]});
    await newRun;
    assert.equal(sandbox.readState().loading, false);
    assert.equal(sandbox.readState().managementBatch, null);
    return;
  }
  if (legacyOutcome) {
    // A user may start a legacy handler before the deferred module has loaded.
    // Its ownership must survive bootstrap and remain cancellable from the new controller.
    selection.add('1'); selection.add('2');
    behavior.defer = true;
    const oldRun = elements.get('bulkDelete').fire('click');
    const oldRequest = requests[0], legacyBatch = sandbox.readState().managementBatch;
    assert(legacyBatch, 'pre-bootstrap batch has explicit shared ownership');
    events.get('easyadb:frontend-modules-ready')({detail});
    assert.equal(management.state.activeBatch, legacyBatch);
    assert.equal(management.state.selectedDeviceIds, selection);
    assert.equal(requests.length, 1, 'bootstrap preserves the in-flight legacy operation');
    elements.get('token').fire('input');
    assert.equal(oldRequest.signal.aborted, true);
    assert.equal(sandbox.readState().loading, false);
    sandbox.installRows(makeDevices(2).map(device => ({...device, name: 'New ' + device.name})));
    selection.add('1'); selection.add('2');
    const newRows = sandbox.readState().devices;
    const newRun = elements.get('refreshAll').fire('click');
    const newBatch = sandbox.readState().managementBatch;
    const messageCount = messages.length;
    if (legacyOutcome === 'failure') oldRequest.pending.reject(Error('old legacy deletion failed'));
    else oldRequest.pending.resolve({});
    await oldRun;
    assert.equal(sandbox.readState().devices, newRows);
    assert.deepEqual([...selection], ['1', '2']);
    assert.equal(sandbox.readState().managementBatch, newBatch);
    assert.equal(sandbox.readState().loading, true);
    assert.equal(requests.length, 2, 'old legacy batch cannot continue after credential reset');
    assert.equal(messages.length, messageCount);
    requests[1].pending.resolve({json: async () => newRows[0]});
    await until(() => requests.length === 3);
    requests[2].pending.resolve({json: async () => newRows[1]});
    await newRun;
    assert.equal(sandbox.readState().loading, false);
    assert.equal(sandbox.readState().managementBatch, null);
    assert.equal(requests.filter(entry => entry.method === 'GET').length, 2,
      'only the new operation performs its single devices/groups reload');
    return;
  }
  selection.add('2');
  sandbox.readState().connectingDevices.add('2');
  events.get('easyadb:frontend-modules-ready')({detail});
  events.get('easyadb:frontend-modules-ready')({detail});
  assert.equal(managementFactories, 1);
  assert.equal(connectionFactories, 1);
  assert.equal(requests.length, 0, 'bootstrap must not load, connect or start management');
  assert.equal(management.state.selectedDeviceIds, selection);
  assert.equal(connection.state.selectedDeviceIds, selection);
  assert.equal(liveOptions.getBatchSelection(), selection, 'management and projection share one Set');
  assert.equal(management.state.devices, sandbox.readState().devices);

  const select = (id, checked) => {
    const checkbox = findAll(elements.get('devices'), node => node.tagName === 'input' && node.value === id)[0];
    assert(checkbox); checkbox.checked = checked; checkbox.fire('change'); return checkbox;
  };
  select('1', true);
  assert(selection.has('1'), 'real View callback reaches the controller');
  assert.equal(elements.get('bulkSelectAll').indeterminate, true);
  assert.equal(select('2', false).disabled, true);
  assert(selection.has('2'), 'a synthetic change cannot bypass the connecting guard');
  busy.add('3');
  select('3', true);
  assert(selection.has('3'), 'live busy does not prevent selection');
  assert.equal(elements.get('bulkSelectAll').checked, true,
    'all-select state counts the same nonconnecting devices as the controller');
  elements.get('bulkSelectAll').checked = false;
  elements.get('bulkSelectAll').fire('change');
  assert.deepEqual([...selection], ['2']);
  elements.get('bulkSelectAll').checked = true;
  elements.get('bulkSelectAll').fire('change');
  assert.deepEqual([...selection].sort(), ['1', '2', '3']);
  assert.equal(liveOptions.getBatchSelection(), selection);

  behavior.confirm = false;
  await elements.get('bulkDelete').fire('click');
  assert.equal(requests.length, 0, 'cancelled real page confirmation sends nothing');
  behavior.confirm = true;
  await elements.get('bulkDelete').fire('click');
  assert.deepEqual(requests.map(entry => [entry.path, entry.method]), [
    ['/api/devices/1', 'DELETE'], ['/api/devices', 'GET'], ['/api/groups', 'GET'],
  ]);
  assert.deepEqual([...selection].sort(), ['2', '3']);
  assert.equal(sandbox.readState().loading, false);
  sandbox.readState().connectingDevices.clear(); busy.clear();
  await elements.get('refreshAll').fire('click');
  assert.deepEqual(requests.slice(3).map(entry => [entry.path, entry.method]), [
    ['/api/devices/2/refresh', 'POST'], ['/api/devices/3/refresh', 'POST'],
    ['/api/devices', 'GET'], ['/api/groups', 'GET'],
  ]);
  assert.deepEqual([...selection].sort(), ['2', '3']);

  // Real token reset cancels D2 independently of D1 and protects a replacement batch.
  behavior.defer = true;
  const oldRun = elements.get('bulkDelete').fire('click');
  const oldRequest = requests.at(-1);
  assert.equal(oldRequest.path, '/api/devices/2');
  assert.equal(sandbox.readState().connectionBatchBusy, false);
  elements.get('token').value = 'new-token';
  elements.get('token').fire('input');
  assert.equal(oldRequest.signal.aborted, true);
  assert.equal(sandbox.readState().loading, false);
  assert.equal(sandbox.readState().loaded, false);
  assert.equal(selection.size, 0);
  assert.equal(closes, 1, 'existing live cleanup remains delegated');
  sandbox.installRows(makeDevices(2));
  selection.add('1'); selection.add('2');
  const replacementRun = elements.get('refreshAll').fire('click');
  const replacementBatch = sandbox.readState().managementBatch;
  const messageCount = messages.length, requestCount = requests.length;
  oldRequest.pending.resolve({});
  await oldRun;
  assert.equal(sandbox.readState().managementBatch, replacementBatch);
  assert.equal(sandbox.readState().loading, true);
  assert.deepEqual([...selection], ['1', '2']);
  assert.equal(messages.length, messageCount);
  assert.equal(requests.length, requestCount);
  const first = requests.at(-1);
  first.pending.resolve({json: async () => makeDevices(2)[0]});
  await until(() => requests.length === requestCount + 1);
  requests.at(-1).pending.resolve({json: async () => makeDevices(2)[1]});
  await replacementRun;
  assert.equal(sandbox.readState().loading, false);
  assert.equal(sandbox.readState().managementBatch, null);
}

(async () => {
  const {createDeviceManagementController} = await import('../web/features/devices/device-management-controller.js');
  checkSelection(createDeviceManagementController);
  for (const method of ['deleteSelected', 'checkSelected']) {
    await checkBatchResults(createDeviceManagementController, method);
    await checkSerialRequests(createDeviceManagementController, method);
    await checkRefreshFailure(createDeviceManagementController, method);
    await checkStaleResults(createDeviceManagementController, method);
  }
  await checkStaleFinalRefresh(createDeviceManagementController);
  await checkPageIntegration(createDeviceManagementController);
  for (const outcome of ['success', 'failure', 'refresh-success', 'refresh-failure']) {
    await checkPageIntegration(createDeviceManagementController, outcome);
  }
  console.log('Device management lifecycle: shared selection, busy rechecks, failures, cancellation and real page integration: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
