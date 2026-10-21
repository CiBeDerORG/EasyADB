/* Exercise the production D2 controller and the real classic-page adapter. */
'use strict';
const assert = require('node:assert/strict');
const {createPageFixture} = require('./helpers/page-fixture.cjs');

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
    isLoaded: true, isLoading: false, generation: 0, activeBatch: null,
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

  // Actual page events call the single production controller and metadata reader.
  {
    const server = new Map(devices(['1', '2']).map(device => [device.id, device]));
    const f = await createPageFixture({devices: [...server.values()], request: async (path, options) => {
      if (!options.method) return {json: async () => path === '/api/groups' ? [] : [...server.values()]};
      const id = decodeURIComponent(path.split('/')[3]);
      if (options.method === 'DELETE') server.delete(id);
      else server.set(id, {...server.get(id), status: 'checked'});
      return {json: async () => server.get(id)};
    }});
    const {state, controllers, requests} = f;
    state.selectedDeviceId = '1'; state.selectedDeviceIds.add('1');
    assert.equal(f.bootstrap(), f.page);
    assert.equal(requests.length, 0, 'mounting is passive');
    const selection = state.selectedDeviceIds;
    assert.equal(controllers.management.state.selectedDeviceIds, selection);
    f.get('bulkSelectAll').checked = true; await f.get('bulkSelectAll').fire('change');
    assert.deepEqual([...selection], ['1', '2'], 'bulk selection uses shared state');
    await f.get('refreshAll').fire('click');
    assert.deepEqual(requests.map(entry => [entry.path, entry.method]), [
      ['/api/devices/1/refresh', 'POST'], ['/api/devices/2/refresh', 'POST'],
      ['/api/devices', 'GET'], ['/api/groups', 'GET'],
    ]);
    assert.deepEqual(state.devices.map(device => device.id), ['1', '2'], 'responses preserve both device identities');
    assert(state.devices.every(device => device.status === 'checked'));
    assert.equal(state.isLoading, false);
    await f.get('bulkDelete').fire('click');
    assert.deepEqual(requests.slice(4).map(entry => [entry.path, entry.method]), [
      ['/api/devices/1', 'DELETE'], ['/api/devices/2', 'DELETE'], ['/api/devices', 'GET'], ['/api/groups', 'GET'],
    ]);
    assert.equal(selection.size, 0);
    assert.equal(state.selectedDeviceId, null, 'deleting the active device clears its selection');
    await f.get('token').fire('input');
    assert.equal(state.isLoaded, false);
    assert.equal(state.devices.length, 0);
    assert.equal(selection.size, 0);
    assert(f.live.redrawCount > 3);
    f.dispose();
  }
  await tick();
  console.log('D2 controller selection/delete/check, token isolation and real page events: OK');
})().catch((error) => { console.error(error); process.exitCode = 1; });
