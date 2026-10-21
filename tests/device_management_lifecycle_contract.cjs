/* Run the production D2 controller and page adapter without network or real devices. */
'use strict';
const assert = require('node:assert/strict');
const {createPageFixture, findAll} = require('./helpers/page-fixture.cjs');

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

async function checkPageIntegration(outcome = null) {
  const server = new Map(makeDevices().map(device => [device.id, device]));
  const behavior = {confirm: true, defer: false, deferLists: false};
  const f = await createPageFixture({devices: makeDevices(), confirm: () => behavior.confirm,
    request: async (path, options, entry) => {
      if (entry.method === 'GET') {
        if (behavior.deferLists) return entry.pending.promise;
        return {json: async () => path === '/api/groups' ? [] : [...server.values()]};
      }
      if (behavior.defer) return entry.pending.promise;
      const id = decodeURIComponent(path.split('/')[3]);
      if (entry.method === 'DELETE') server.delete(id);
      return {json: async () => ({...server.get(id), status: 'connected'})};
    },
  });
  const {state, elements, requests, messages, busy, liveOptions} = f;
  const management = f.controllers.management, connection = f.controllers.connection;
  const selection = state.selectedDeviceIds;
  if (outcome?.startsWith('refresh-')) {
    assert.equal(f.bootstrap(), f.page);
    selection.add('1'); selection.add('2');
    behavior.deferLists = true;
    const oldRun = elements.get('refreshAll').fire('click');
    await until(() => requests.filter(entry => entry.method === 'GET').length === 2);
    const oldLists = requests.filter(entry => entry.method === 'GET');
    elements.get('token').fire('input');
    assert.equal(state.isLoading, false);
    behavior.deferLists = false; behavior.defer = true;
    const replacement = makeDevices(2).map(device => ({...device, name: 'New ' + device.name}));
    f.installRows(replacement);
    selection.add('1'); selection.add('2');
    const newRun = elements.get('refreshAll').fire('click');
    const newBatch = state.activeBatch;
    const messageCount = messages.length, requestCount = requests.length;
    for (const entry of oldLists) {
      if (outcome === 'refresh-failure' && entry.path === '/api/devices') {
        entry.pending.reject(Error('old credential GET failed'));
      } else {
        entry.pending.resolve({json: async () => entry.path === '/api/groups' ? [] : makeDevices()});
      }
    }
    await oldRun;
    assert.equal(state.devices, replacement,
      'real D1 metadata reader cannot restore an old list during D2 final refresh');
    assert.deepEqual([...selection], ['1', '2']);
    assert.equal(state.activeBatch, newBatch);
    assert.equal(state.isLoading, true);
    assert.equal(messages.length, messageCount);
    assert.equal(requests.length, requestCount);
    requests.at(-1).pending.resolve({json: async () => replacement[0]});
    await until(() => requests.length === requestCount + 1);
    requests.at(-1).pending.resolve({json: async () => replacement[1]});
    await newRun;
    assert.equal(state.isLoading, false);
    assert.equal(state.activeBatch, null);
    f.dispose();
    return;
  }
  if (outcome) {
    // Repeated page construction during I/O preserves the one current owner.
    // Token changes still cancel it without affecting a replacement operation.
    selection.add('1'); selection.add('2');
    behavior.defer = true;
    const oldRun = elements.get('bulkDelete').fire('click');
    const oldRequest = requests[0], batch = state.activeBatch;
    assert(batch, 'the mounted page has explicit batch ownership');
    assert.equal(f.bootstrap(), f.page);
    assert.equal(management.state.activeBatch, batch);
    assert.equal(management.state.selectedDeviceIds, selection);
    assert.equal(requests.length, 1, 'bootstrap preserves the in-flight operation');
    elements.get('token').fire('input');
    assert.equal(oldRequest.signal.aborted, true);
    assert.equal(state.isLoading, false);
    f.installRows(makeDevices(2).map(device => ({...device, name: 'New ' + device.name})));
    selection.add('1'); selection.add('2');
    const newRows = state.devices;
    const newRun = elements.get('refreshAll').fire('click');
    const newBatch = state.activeBatch;
    const messageCount = messages.length;
    if (outcome === 'failure') oldRequest.pending.reject(Error('old deletion failed'));
    else oldRequest.pending.resolve({});
    await oldRun;
    assert.equal(state.devices, newRows);
    assert.deepEqual([...selection], ['1', '2']);
    assert.equal(state.activeBatch, newBatch);
    assert.equal(state.isLoading, true);
    assert.equal(requests.length, 2, 'old batch cannot continue after credential reset');
    assert.equal(messages.length, messageCount);
    requests[1].pending.resolve({json: async () => newRows[0]});
    await until(() => requests.length === 3);
    requests[2].pending.resolve({json: async () => newRows[1]});
    await newRun;
    assert.equal(state.isLoading, false);
    assert.equal(state.activeBatch, null);
    assert.equal(requests.filter(entry => entry.method === 'GET').length, 2,
      'only the new operation performs its single devices/groups reload');
    f.dispose();
    return;
  }
  selection.add('2');
  state.pendingDeviceIds.add('2');
  assert.equal(f.bootstrap(), f.page);
  assert.equal(f.bootstrap(), f.page);
  assert.deepEqual(f.ports, {multi: 1, group: 1, lab: 1});
  assert.equal(requests.length, 0, 'bootstrap must not load, connect or start management');
  assert.equal(management.state.selectedDeviceIds, selection);
  assert.equal(connection.state.selectedDeviceIds, selection);
  assert.equal(liveOptions.getBatchSelection(), selection, 'management and projection share one Set');
  assert.equal(management.state.devices, state.devices);

  const select = (id, checked) => {
    const checkbox = findAll(elements.get('devices'), node => node.tagName === 'INPUT' && node.value === id)[0];
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
  assert.equal(state.isLoading, false);
  state.pendingDeviceIds.clear(); busy.clear();
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
  assert.equal(state.isBatchBusy, false);
  elements.get('token').value = 'new-token';
  elements.get('token').fire('input');
  assert.equal(oldRequest.signal.aborted, true);
  assert.equal(state.isLoading, false);
  assert.equal(state.isLoaded, false);
  assert.equal(selection.size, 0);
  assert.equal(f.live.closeCount, 1, 'existing live cleanup remains delegated');
  f.installRows(makeDevices(2));
  selection.add('1'); selection.add('2');
  const replacementRun = elements.get('refreshAll').fire('click');
  const replacementBatch = state.activeBatch;
  const messageCount = messages.length, requestCount = requests.length;
  oldRequest.pending.resolve({});
  await oldRun;
  assert.equal(state.activeBatch, replacementBatch);
  assert.equal(state.isLoading, true);
  assert.deepEqual([...selection], ['1', '2']);
  assert.equal(messages.length, messageCount);
  assert.equal(requests.length, requestCount);
  const first = requests.at(-1);
  first.pending.resolve({json: async () => makeDevices(2)[0]});
  await until(() => requests.length === requestCount + 1);
  requests.at(-1).pending.resolve({json: async () => makeDevices(2)[1]});
  await replacementRun;
  assert.equal(state.isLoading, false);
  assert.equal(state.activeBatch, null);
  f.dispose();
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
  await checkPageIntegration();
  for (const outcome of ['success', 'failure', 'refresh-success', 'refresh-failure']) {
    await checkPageIntegration(outcome);
  }
  console.log('Device management lifecycle: shared selection, busy rechecks, failures, cancellation and real page integration: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
