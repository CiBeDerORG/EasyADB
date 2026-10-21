/* Real controller and page adapter; no browser, ADB, timers or network required. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const tick = () => new Promise(resolve => setImmediate(resolve));
const makeDevices = (count = 5) => Array.from({ length: count }, (_, index) => ({
  id: String(index + 1), name: 'Phone ' + (index + 1), status: 'idle',
  selected_serial: '10.0.0.' + (index + 1) + ':5555', active_serial: null,
  connect_failed: false,
}));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(predicate) {
  for (let i = 0; i < 30; i++) {
    if (predicate()) return;
    await tick();
  }
  assert.fail('expected asynchronous progress did not arrive');
}
function fixture(createController, initial = makeDevices()) {
  const state = {
    devices: initial.map(device => ({ ...device })), groups: [], selectedDeviceId: null,
    isLoaded: true, generation: 0, resultRevision: 0, abortController: null,
    isBatchBusy: false, selectedDeviceIds: new Set(), pendingDeviceIds: new Set(),
    resultSnapshots: new Map(),
  };
  const server = new Map(initial.map(device => [device.id, { ...device }]));
  const requests = [], connections = [], lists = [], messages = [], renders = [];
  const busy = new Set();
  const behavior = { deferLists: false, failLists: false };
  const request = async (path, options = {}) => {
    requests.push({ path, method: options.method || 'GET', signal: options.signal });
    if (path.endsWith('/connect')) {
      const id = decodeURIComponent(path.split('/')[3]);
      const pending = deferred();
      connections.push({ id, device: { ...server.get(id) }, pending, signal: options.signal });
      // Deliberately ignore abort: generation checks must protect against late results too.
      return pending.promise;
    }
    assert(path === '/api/devices' || path === '/api/groups', 'no route change or extra API');
    if (behavior.failLists) throw Error('metadata unavailable');
    if (behavior.deferLists) {
      const pending = deferred();
      lists.push({ path, pending });
      return pending.promise;
    }
    return { json: async () => path === '/api/groups' ? [] : [...server.values()] };
  };
  const controller = createController({
    state, request, getToken: () => 'test-token', isDeviceBusy: id => busy.has(id),
    notify: (...args) => messages.push(args),
    onChange: () => renders.push({
      pending: [...state.pendingDeviceIds], selected: [...state.selectedDeviceIds],
      ready: state.devices.filter(device => device.status === 'connected').map(device => device.id),
    }),
  });
  function finish(entry, success = true, updateServer = true) {
    assert(entry && !entry.finished);
    entry.finished = true;
    const device = {
      ...entry.device, status: success ? 'connected' : 'error',
      active_serial: success ? entry.device.selected_serial : null,
      connect_failed: !success,
    };
    if (updateServer) server.set(entry.id, device);
    if (success) entry.pending.resolve({ json: async () => device });
    else entry.pending.reject(Error('offline'));
  }
  return { state, controller, request, server, requests, connections, lists, messages,
    renders, busy, behavior, finish };
}

(async () => {
  const { createDeviceConnectionController } = await import(
    '../web/features/devices/device-connection-controller.js'
  );
  for (const selectSuccessful of [false, true]) {
    const f = fixture(createDeviceConnectionController);
    const selection = f.state.selectedDeviceIds;
    const pendingIds = f.state.pendingDeviceIds;
    f.state.selectedDeviceIds.add('5');
    assert.equal(f.requests.length, 0, 'construction cannot load, connect or scan');
    f.state.isBatchBusy = true;
    const run = f.controller.connectDevices(f.state.devices.slice(), 0, selectSuccessful, '测试', 0);
    assert.equal(f.connections.length, 4, 'exactly four concurrent requests start');
    assert.equal(f.state.pendingDeviceIds.size, 5);
    assert.deepEqual([...selection], selectSuccessful ? [] : ['5']);
    f.finish(f.connections[1]);
    await until(() => f.connections.length === 5);
    assert(!pendingIds.has('2'), 'a fast phone is unlocked before slow peers');
    assert(pendingIds.has('1'));
    assert.deepEqual(f.renders.at(-1).ready, ['2']);
    assert.deepEqual([...selection], selectSuccessful ? ['2'] : ['5']);
    f.finish(f.connections[2], false);
    await tick();
    assert.equal(f.state.devices[2].connect_failed, true);
    for (const index of [0, 3, 4]) f.finish(f.connections[index]);
    await run;
    assert.equal(f.state.isBatchBusy, false);
    assert.equal(f.state.abortController, null);
    assert.equal(pendingIds.size, 0);
    assert.equal(f.state.resultSnapshots.size, 0);
    assert.equal(f.state.selectedDeviceIds, selection, 'selection is not replaced by a copy');
    assert.equal(f.state.pendingDeviceIds, pendingIds);
    assert.deepEqual([...selection].sort(), selectSuccessful ? ['1', '2', '4', '5'] : ['5']);
    assert.equal(f.connections.length, 5, 'each device attempted once, no retry');
    assert.equal(f.requests.filter(request => request.method === 'GET').length, 2,
      'one final devices/groups metadata refresh');
  }

  // Preserve a result that completed after an overlapping metadata GET started.
  {
    const f = fixture(createDeviceConnectionController, makeDevices(2));
    f.behavior.deferLists = true;
    const staleRows = f.state.devices.map(device => ({ ...device }));
    const load = f.controller.loadDevices(true);
    f.behavior.deferLists = false;
    f.state.isBatchBusy = true;
    const run = f.controller.connectDevices(f.state.devices.slice(), 0, false, '重叠', 0);
    f.finish(f.connections[0]);
    await until(() => f.state.resultRevision === 1);
    for (const item of f.lists) item.pending.resolve({
      json: async () => item.path === '/api/devices' ? staleRows : [],
    });
    assert.equal(await load, true);
    assert.equal(f.state.devices[0].status, 'connected', 'older GET cannot erase fresh progress');
    f.finish(f.connections[1]);
    await run;
  }

  // Invalidated old batches must neither start queued requests nor release a new batch.
  {
    const f = fixture(createDeviceConnectionController);
    f.state.isBatchBusy = true;
    const oldRun = f.controller.connectDevices(f.state.devices.slice(), 0, true, '旧批次', 0);
    const oldRequests = f.connections.slice();
    f.state.generation++;
    f.state.abortController.abort();
    assert(oldRequests.every(entry => entry.signal.aborted));
    f.state.abortController = null;
    f.state.pendingDeviceIds.clear();
    f.state.resultSnapshots.clear();
    f.state.devices = makeDevices();
    const newRun = f.controller.connectDevices(f.state.devices.slice(), 0, true, '新批次', 1);
    const newController = f.state.abortController;
    const beforeMessages = f.messages.length;
    for (const entry of oldRequests) f.finish(entry, true, false);
    await oldRun;
    assert.equal(f.connections.length, 8, 'old fifth device never issues a request');
    assert.equal(f.state.abortController, newController);
    assert.equal(f.state.isBatchBusy, true);
    assert.equal(f.state.pendingDeviceIds.size, 5);
    assert.equal(f.state.selectedDeviceIds.size, 0);
    assert.equal(f.messages.length, beforeMessages, 'late successes/errors stay silent');
    assert.equal(f.requests.filter(request => request.method === 'GET').length, 0);
    for (const entry of f.connections.slice(4, 8)) f.finish(entry);
    await until(() => f.connections.length === 9);
    f.finish(f.connections[8]);
    await newRun;
    assert.equal(f.state.pendingDeviceIds.size, 0);
    assert.deepEqual([...f.state.selectedDeviceIds].sort(), ['1', '2', '3', '4', '5']);
  }

  for (const rejectOldLoad of [false, true]) {
    const f = fixture(createDeviceConnectionController, makeDevices(1));
    f.behavior.deferLists = true;
    const load = f.controller.loadDevices(false);
    f.state.generation++;
    const replacement = [{ ...makeDevices(1)[0], name: 'New credentials' }];
    f.state.devices = replacement;
    for (const item of f.lists) {
      if (rejectOldLoad && item.path === '/api/devices') item.pending.reject(Error('old 401'));
      else item.pending.resolve({ json: async () => [] });
    }
    assert.equal(await load, false);
    assert.equal(f.state.devices, replacement);
    assert.equal(f.renders.length, 0);
    assert.equal(f.messages.length, 0, 'stale metadata failures cannot overwrite new status');
  }

  // Per-device busy checks remain active; refresh failure cannot strand the batch lock.
  {
    const f = fixture(createDeviceConnectionController, makeDevices(3));
    f.busy.add('2');
    f.behavior.failLists = true;
    f.state.isBatchBusy = true;
    const run = f.controller.connectDevices(f.state.devices.slice(), 0, true, '失败隔离', 0);
    assert.deepEqual(f.connections.map(entry => entry.id), ['1', '3']);
    for (const entry of f.connections) f.finish(entry);
    await run;
    assert.equal(f.state.isBatchBusy, false);
    assert.equal(f.state.abortController, null);
    assert.equal(f.state.pendingDeviceIds.size, 0);
    assert.deepEqual([...f.state.selectedDeviceIds].sort(), ['1', '3']);
  }
  {
    const f = fixture(createDeviceConnectionController, makeDevices(1));
    const original = f.state.devices[0];
    const changed = { ...original, selected_serial: '10.0.0.1:5556' };
    f.state.devices = [changed];
    assert.equal(f.controller.applyConnectionResult(original, {
      status: 'fulfilled', value: { ...original, status: 'connected' },
    }), false);
    assert.equal(f.state.devices[0], changed, 'old route response cannot overwrite the current route');
    assert.equal(f.state.resultSnapshots.size, 0);
    f.state.selectedDeviceId = 'removed';
    f.state.selectedDeviceIds.add('removed');
    assert.equal(await f.controller.loadDevices(true), true);
    assert.equal(f.state.selectedDeviceId, null);
    assert.equal(f.state.selectedDeviceIds.size, 0);
  }

  // Execute real page bootstrap/load/bulk/token handlers with the production factory.
  {
    const html = fs.readFileSync('web/index.html', 'utf8');
    const main = fs.readFileSync('web/app/main.js', 'utf8');
    assert(main.includes("from '../features/devices/device-connection-controller.js'"));
    assert(main.includes('createDeviceConnectionController: deviceConnection.createDeviceConnectionController'));
    const section = (first, last) => {
      const start = html.indexOf(first), end = html.indexOf(last, start);
      assert(start >= 0 && end > start, 'page boundary missing: ' + first);
      return html.slice(start, end);
    };
    const f = fixture(createDeviceConnectionController, makeDevices(2));
    const events = new Map(), handlers = new Map();
    let factoryCalls = 0, created, closes = 0;
    const sandbox = {
      AbortController,
      document: {
        getElementById(id) { return {
          value: id === 'token' ? 'current-token' : '',
          addEventListener(event, handler) { handlers.set(id + ':' + event, handler); },
        }; },
        addEventListener(event, handler) { events.set(event, handler); },
      },
      api: f.request, render() {}, message() {}, dismissToast() {},
      runDeviceBatch() { assert.fail('injected path ran the legacy batch worker'); },
      liveView: { isBusyFor: id => f.busy.has(id), closeAll() { closes++; } },
    };
    const setup = section('const $=id=>', 'const inventoryDrawer=') + `
const toastItems=new Map();
let frontendModules=null,deviceConnectionController=null;
` + section("document.addEventListener('easyadb:frontend-modules-ready'", '// Browser requests') +
      section('async function load(quiet=false)', 'function reset()') +
      section('async function connectProgressively(', "$('bulkSelectAll').addEventListener") +
      section("$('bulkConnect').addEventListener", "$('bulkDelete').addEventListener") + `
multiView=liveView;
globalThis.readState=()=>({devices,groups,loaded,loading,connectGeneration,connectProgressRevision,
 managementSelected,connectingDevices,connectSnapshots,connectionBatchBusy,connectController});
`;
    const context = vm.createContext(sandbox);
    vm.runInContext(setup, context);
    vm.runInContext(`
managementSelected.add('2');connectingDevices.add('1');connectProgressRevision=7;
connectSnapshots.set('1',{revision:7,device:{id:'1'}});
connectController=new AbortController();connectionBatchBusy=true;
`, context);
    const before = sandbox.readState();
    const detail = { createDeviceConnectionController(options) {
      factoryCalls++;
      created = createDeviceConnectionController(options);
      return created;
    } };
    const bootstrap = events.get('easyadb:frontend-modules-ready');
    bootstrap({ detail });
    bootstrap({ detail });
    assert.equal(factoryCalls, 1);
    assert.equal(f.requests.length, 0, 'bootstrap does not implicitly load/connect');
    assert.equal(created.state.pendingDeviceIds, before.connectingDevices);
    assert.equal(created.state.resultSnapshots, before.connectSnapshots);
    assert.equal(created.state.selectedDeviceIds, before.managementSelected);
    assert.equal(created.state.abortController, before.connectController);
    assert.equal(created.state.resultRevision, 7);
    vm.runInContext('connectProgressRevision=8;', context);
    assert.equal(created.state.resultRevision, 8, 'adapter reads live state, not a snapshot');
    vm.runInContext(`
connectingDevices.clear();connectSnapshots.clear();connectController=null;connectionBatchBusy=false;
`, context);
    f.busy.add('2');
    const initialRun = handlers.get('load:click')();
    await until(() => f.connections.length === 1);
    assert.equal(sandbox.readState().loading, false, 'page lock ends before ADB I/O');
    assert.equal(f.connections[0].id, '1', 'live devices are skipped');
    f.finish(f.connections[0]);
    await initialRun;
    assert.deepEqual(Array.from(sandbox.readState().managementSelected), ['2']);
    f.busy.clear();
    vm.runInContext("managementSelected.add('1');", context);
    const bulkRun = handlers.get('bulkConnect:click')();
    await until(() => f.connections.length === 3);
    assert.equal(sandbox.readState().managementSelected.size, 0);
    for (const entry of f.connections.slice(1)) f.finish(entry);
    await bulkRun;
    assert.deepEqual(Array.from(sandbox.readState().managementSelected).sort(), ['1', '2']);
    assert.equal(sandbox.readState().connectionBatchBusy, false);
    handlers.get('token:input')();
    assert.equal(sandbox.readState().connectGeneration, 1);
    assert.equal(sandbox.readState().devices.length, 0);
    assert.equal(sandbox.readState().managementSelected.size, 0);
    assert.equal(closes, 1, 'existing live cleanup callback remains intact');
  }
  console.log('Device connection controller: concurrency, generation isolation, shared state and page integration: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
