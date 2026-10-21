/* Exercise the production D2 controller and the real classic-page adapter. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function devices(ids) {
  return ids.map((id) => ({
    id, name: 'Phone ' + id, status: 'connected', connect_failed: false,
    selected_serial: '10.0.0.' + id + ':5555', active_serial: '10.0.0.' + id + ':5555',
  }));
}
function fixture(factory, ids = ['1', '2', '3']) {
  const state = {
    devices: devices(ids), selectedDeviceIds: new Set(ids), selectedDeviceId: '1',
    isLoaded: true, isLoading: false, generation: 0,
  };
  const busy = new Set(), connecting = new Set(), requests = [], notices = [], confirmations = [];
  const server = new Map(state.devices.map((device) => [device.id, device]));
  const holds = new Map(), failures = new Set(), renders = [];
  const f = {
    state, busy, connecting, requests, notices, confirmations, server, holds, failures, renders,
    refreshCount: 0, refreshOk: true, confirmOk: true,
  };
  f.controller = factory({
    state,
    isDeviceBusy: (id) => busy.has(id) || connecting.has(id),
    isDeviceConnecting: (id) => connecting.has(id),
    onChange: () => renders.push({ locked: state.isLoading, selected: [...state.selectedDeviceIds] }),
    notify: (...args) => notices.push(args),
    confirmDelete: (message) => { confirmations.push(message); return f.confirmOk; },
    refreshDevices: async () => {
      f.refreshCount++;
      if (!f.refreshOk) return false;
      state.devices = [...server.values()];
      return true;
    },
    request: async (path, options) => {
      const id = decodeURIComponent(path.split('/')[3]);
      requests.push({ id, path, method: options.method, signal: options.signal });
      if (holds.has(id)) await holds.get(id).promise;
      if (failures.has(id)) throw Error('offline');
      if (options.method === 'DELETE') server.delete(id);
      return { json: async () => ({ ...server.get(id), status: 'checked' }) };
    },
  });
  return f;
}
function section(html, start, end) {
  const first = html.indexOf(start), last = html.indexOf(end, first);
  assert(first >= 0 && last > first, 'missing adapter boundary: ' + start);
  return html.slice(first, last);
}

(async () => {
  const { createDeviceManagementController } = await import(
    '../web/features/devices/device-management-controller.js'
  );
  {
    const f = fixture(createDeviceManagementController);
    const selected = f.state.selectedDeviceIds;
    assert.equal(f.requests.length, 0, 'construction must not connect, scan or refresh');
    f.connecting.add('2');
    f.controller.selectAll(false);
    assert.deepEqual([...selected], ['2'], 'deselect all preserves a connecting selection');
    f.controller.selectDevice('2', false);
    assert.deepEqual([...selected], ['2'], 'connecting device cannot be toggled');
    f.controller.selectDevice('9', true);
    assert.equal(selected.has('9'), false, 'unknown devices cannot be selected');
    f.controller.selectAll(true);
    assert.deepEqual([...selected], ['2', '1', '3']);
    assert.equal(f.controller.getSelectionSummary().selectedSelectable.length, 2);
    f.controller.selectDevice('1', false);
    assert.equal(selected.has('1'), false);
    f.state.isLoading = true;
    f.controller.selectAll(false);
    assert.equal(selected.has('3'), true, 'page lock disables selection');
    f.state.isLoading = false;
    assert.equal(selected, f.state.selectedDeviceIds, 'projection uses the existing Set');
  }
  {
    const f = fixture(createDeviceManagementController);
    f.confirmOk = false;
    assert.equal(await f.controller.deleteSelected(), false);
    assert.equal(f.requests.length, 0);
    assert.equal(f.refreshCount, 0);
    assert.equal(f.state.isLoading, false);
    assert(f.confirmations[0].includes('Phone 1'));
    assert(f.confirmations[0].includes('不会清除手机上的 ADB 配对授权'));
  }
  {
    const f = fixture(createDeviceManagementController);
    f.busy.add('3');
    const hold = deferred();
    f.holds.set('1', hold);
    const run = f.controller.deleteSelected();
    assert.equal(f.state.isLoading, true);
    assert.equal(f.requests[0].id, '1', 'page loading must not self-skip');
    f.busy.add('2');
    hold.resolve();
    assert.equal(await run, true);
    assert.deepEqual(f.requests.map((entry) => entry.id), ['1']);
    assert.equal(f.refreshCount, 1);
    assert.equal(f.state.isLoading, false);
    assert.equal(f.state.selectedDeviceId, null);
    assert.deepEqual([...f.state.selectedDeviceIds], ['2', '3']);
    assert.equal(f.state.devices.length, 2);
    assert(f.confirmations[0].includes('另有 1 台'));
    assert(f.notices.at(-1)[0].includes('已删除 1 台'));
    assert(f.notices.at(-1)[0].includes('其他未删除 1 台'));
  }
  {
    const f = fixture(createDeviceManagementController);
    f.failures.add('2');
    f.refreshOk = false;
    assert.equal(await f.controller.checkSelected(), true);
    assert.deepEqual(f.requests.map((entry) => entry.method), ['POST', 'POST', 'POST']);
    assert(f.requests.every((entry) => entry.path.endsWith('/refresh')));
    assert.equal(f.state.devices[0].status, 'checked');
    assert.deepEqual([...f.state.selectedDeviceIds], ['1', '2', '3'], 'checking preserves selection');
    assert.equal(f.state.isLoading, false);
    assert.equal(f.refreshCount, 1);
    assert(f.notices.at(-1)[0].includes('已检查 2 台'));
    assert(f.notices.at(-1)[0].includes('offline'));
    assert(f.notices.at(-1)[0].includes('刷新失败'));
    assert.equal(f.notices.at(-1)[1], 'error');
    assert(f.requests.every((entry) => !entry.path.endsWith('/connect')));
  }
  for (const operation of ['deleteSelected', 'checkSelected']) {
    const f = fixture(createDeviceManagementController, ['1', '2']);
    f.refreshOk = false;
    const hold = deferred();
    f.holds.set('1', hold);
    const run = f.controller[operation]();
    assert.equal(f.requests.length, 1);
    const oldSelection = f.state.selectedDeviceIds;
    f.controller.invalidate();
    f.state.generation++;
    f.state.devices = devices(['9']);
    oldSelection.clear();
    oldSelection.add('9');
    assert.equal(f.state.isLoading, false);
    assert.equal(f.requests[0].signal.aborted, true);
    hold.resolve();
    assert.equal(await run, false);
    assert.deepEqual(f.state.devices.map((device) => device.id), ['9']);
    assert.deepEqual([...oldSelection], ['9']);
    assert.equal(f.refreshCount, 0, 'stale batch cannot refresh current credentials');
    assert.equal(f.notices.some(([message]) => message.includes('完成：')), false);
    f.holds.clear();
    assert.equal(await f.controller.checkSelected(), true, 'new batch owns the lock');
    assert.equal(f.requests.at(-1).id, '9');
  }
  {
    const f = fixture(createDeviceManagementController, ['1']);
    f.refreshOk = false;
    assert.equal(await f.controller.deleteSelected(), true);
    assert.deepEqual(f.state.devices, [], 'refresh failure does not resurrect a deleted row');
    assert.equal(f.state.isLoading, false);
    assert(f.notices.at(-1)[0].includes('刷新失败'));
  }

  // The actual page receives the production factory through app/main.js and
  // delegates checkbox, select-all, delete, check and credential invalidation.
  {
    const html = fs.readFileSync('web/index.html', 'utf8');
    const main = fs.readFileSync('web/app/main.js', 'utf8');
    assert(main.includes("from '../features/devices/device-management-controller.js'"));
    assert(main.includes('createDeviceManagementController: deviceManagement.createDeviceManagementController'));
    assert(html.includes('deviceManagementController.selectDevice(id,checked)'));
    assert(html.includes('deviceManagementController.getSelectionSummary()'));
    const handlers = new Map(), events = new Map(), notices = [], requests = [];
    const elements = new Map(), redraws = [];
    for (const id of ['token', 'bulkSelectAll', 'bulkDelete', 'refreshAll']) {
      elements.set(id, { checked: false, value: 'token', addEventListener(type, callback) {
        handlers.set(id + ':' + type, callback);
      } });
    }
    const sandbox = {
      INITIAL: devices(['1', '2']), AbortController, Map, Set,
      document: {
        getElementById(id) { return elements.get(id); },
        addEventListener(type, callback) { events.set(type, callback); },
      },
      confirm() { return true; },
      REDRAWS: redraws, NOTICES: notices, REQUESTS: requests,
      REQUEST: async (path, options) => {
        requests.push([path, options.method]);
        return { json: async () => ({ ...devices(['1'])[0], status: 'checked' }) };
      },
    };
    const setup = `
const $=id=>document.getElementById(id);
let devices=INITIAL.map(device=>({...device})),groups=[],selected='1',loaded=true,loading=false;
const managementSelected=new Set(['1']),connectingDevices=new Set(),connectSnapshots=new Map();
let connectGeneration=0,connectionBatchBusy=false,connectController=null;
let multiView={isBusyFor:()=>false,closeAll(){}};
let frontendModules=null,deviceConnectionController=null,deviceManagementController=null;
const toastItems=new Map();
function deviceConnecting(id){return connectingDevices.has(id);}
function deviceBusy(id){return deviceConnecting(id)||multiView.isBusyFor(id);}
function render(){REDRAWS.push([...managementSelected]);}
function message(...args){NOTICES.push(args);}
function dismissToast(){}
async function api(path,options){return REQUEST(path,options);}
async function load(){return true;}
` +
      section(html, "document.addEventListener('easyadb:frontend-modules-ready'", '// Browser requests') +
      section(html, "$('token').addEventListener('input'", "$('bulkSelectAll').addEventListener") +
      section(html, "$('bulkSelectAll').addEventListener", "$('bulkConnect').addEventListener") +
      section(html, "$('bulkDelete').addEventListener", "$('newDevice').addEventListener") +
      section(html, "$('refreshAll').addEventListener", "window.addEventListener('beforeunload'") +
      `
globalThis.snapshot=()=>({devices,selection:managementSelected,loading,loaded,controller:deviceManagementController});
`;
    vm.runInNewContext(setup, sandbox, { filename: 'device-management-page.js' });
    let installed = 0;
    events.get('easyadb:frontend-modules-ready')({ detail: {
      createDeviceManagementController(options) {
        installed++;
        return createDeviceManagementController(options);
      },
    } });
    assert.equal(installed, 1);
    assert.equal(requests.length, 0, 'bootstrap is passive');
    const selection = sandbox.snapshot().selection;
    assert.equal(sandbox.snapshot().controller.state.selectedDeviceIds, selection);
    elements.get('bulkSelectAll').checked = true;
    handlers.get('bulkSelectAll:change')();
    assert.deepEqual([...selection], ['1', '2'], 'bulk selection uses shared state');
    await handlers.get('refreshAll:click')();
    assert.deepEqual(requests, [
      ['/api/devices/1/refresh', 'POST'],
      ['/api/devices/2/refresh', 'POST'],
    ]);
    assert.equal(sandbox.snapshot().loading, false);
    await handlers.get('bulkDelete:click')();
    assert.deepEqual(requests.slice(2), [
      ['/api/devices/1', 'DELETE'],
      ['/api/devices/2', 'DELETE'],
    ]);
    assert.equal(selection.size, 0);
    assert.equal(sandbox.snapshot().selected, undefined);
    handlers.get('token:input')();
    assert.equal(sandbox.snapshot().loaded, false);
    assert.equal(sandbox.snapshot().devices.length, 0);
    assert.equal(selection.size, 0);
    assert(redraws.length > 3);
  }
  await tick();
  console.log('D2 controller selection/delete/check, token isolation and real page events: OK');
})().catch((error) => { console.error(error); process.exitCode = 1; });
