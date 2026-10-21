/* Actual first-load and bulk handlers unlock completed phones before slow peers. */
'use strict';
const assert = require('node:assert/strict');
const {createPageFixture, deferred, until, findAll} = require('./helpers/page-fixture.cjs');
const serial = id => '10.10.12.' + id + ':5555';
const makeDevices = () => Array.from({length: 5}, (_, index) => {
  const id = String(index + 1);
  return {id, name: 'Phone ' + id, ip: '10.10.12.' + id, port: 5555, selected_route: 'mesh',
    selected_serial: serial(id), active_serial: null, status: 'idle', connect_failed: false};
});

(async () => {
  for (const bulk of [false, true]) {
    const rows = makeDevices(), server = new Map(rows.map(row => [row.id, row]));
    const pending = new Map(), requested = [];
    const f = await createPageFixture({devices: rows, loaded: bulk, request: async (path, options) => {
      if (options.method !== 'POST') return {json: async () => path === '/api/devices' ? [...server.values()] : []};
      assert(path.endsWith('/connect'));
      const id = decodeURIComponent(path.split('/')[3]), entry = deferred();
      requested.push(id); pending.set(id, entry);
      return entry.promise;
    }});
    try {
      if (bulk) for (const row of rows) f.state.selectedDeviceIds.add(row.id);
      else f.state.selectedDeviceIds.add('1');
      f.page.render();
      const selection = f.state.selectedDeviceIds;
      const run = f.get(bulk ? 'bulkConnect' : 'load').click();
      await until(() => requested.length === 4);
      assert.deepEqual(requested, ['1', '2', '3', '4']);
      assert.deepEqual([...f.state.pendingDeviceIds], ['1', '2', '3', '4', '5']);
      assert.equal(f.state.isLoading, false);
      assert.deepEqual([...selection], bulk ? [] : ['1']);
      const settle = async (id, success) => {
        const previous = server.get(id);
        const fresh = {...previous, status: success ? 'connected' : 'disconnected',
          active_serial: success ? serial(id) : null, connect_failed: !success};
        server.set(id, fresh);
        pending.get(id).resolve({json: async () => fresh});
        await until(() => !f.state.pendingDeviceIds.has(id));
      };
      const fast = bulk ? '4' : '2', failed = bulk ? '2' : '3';
      await settle(fast, true);
      await until(() => requested.includes('5'));
      assert(f.state.pendingDeviceIds.has('1'));
      assert.equal(f.state.devices.find(row => row.id === fast).status, 'connected');
      assert.equal(f.state.isLoading, false);
      const checkboxes = findAll(f.get('devices'), node => node.type === 'checkbox');
      assert.equal(checkboxes.find(node => node.value === fast).disabled, false,
        'the real list releases a completed phone while slow peers remain locked');
      assert.equal(checkboxes.find(node => node.value === '1').disabled, true);
      const settings = findAll(f.get('devices'), node => node.className === 'projection-settings-edit');
      assert.equal(settings.find(node => node.title.includes('Phone ' + fast)).disabled, false);
      assert.deepEqual([...selection], bulk ? [fast] : ['1']);
      await settle(failed, false);
      assert.equal(f.state.devices.find(row => row.id === failed).connect_failed, true);
      assert.deepEqual([...selection], bulk ? [fast] : ['1']);
      for (const id of ['1', '2', '3', '4', '5'].filter(id => ![fast, failed].includes(id))) await settle(id, true);
      await run;
      assert.equal(f.state.isBatchBusy, false);
      assert.equal(f.state.pendingDeviceIds.size, 0);
      assert.equal(f.state.devices.filter(row => row.status === 'connected').length, 4);
      assert.equal(f.state.selectedDeviceIds, selection);
      assert.deepEqual([...selection].sort(), bulk ? ['1', '3', '4', '5'] : ['1'],
        'first load preserves manual selection; bulk selects only successful responses');
      assert(f.messages.some(message => message.text.includes('已完成设备可立即操作')));
      assert.equal(requested.length, 5, 'each phone is attempted exactly once');
    } finally {f.dispose();}
  }
  console.log('Progressive real page initial/bulk connect: early unlock, DOM state and successful selection: OK');
})().catch(error => {console.error(error); process.exitCode = 1;});
