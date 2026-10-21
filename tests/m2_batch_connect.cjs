/* Production page and D1 controller: four concurrent connections, no copied worker. */
'use strict';
const assert = require('node:assert/strict');
const {createPageFixture, deferred, until} = require('./helpers/page-fixture.cjs');

(async () => {
  const ids = ['A', 'B', 'C', 'D', 'E', 'F'];
  const rows = ids.map((id, index) => ({id, name: id, ip: '10.0.0.' + (index + 1), port: 5555,
    selected_route: 'mesh', selected_serial: '10.0.0.' + (index + 1) + ':5555',
    active_serial: null, status: 'idle'}));
  const server = new Map(rows.map(row => [row.id, row]));
  const pending = new Map(), requested = [];
  let active = 0, maxActive = 0;
  const f = await createPageFixture({devices: rows, request: async (path, options) => {
    if (options.method !== 'POST') return {json: async () => path === '/api/devices' ? [...server.values()] : []};
    assert(path.endsWith('/connect'));
    const id = decodeURIComponent(path.split('/')[3]), entry = deferred();
    requested.push(id); active++; maxActive = Math.max(maxActive, active);
    pending.set(id, entry);
    try {return await entry.promise;} finally {active--;}
  }});
  try {
    for (const id of ids) f.state.selectedDeviceIds.add(id);
    f.page.render();
    const run = f.get('bulkConnect').click();
    assert.deepEqual(requested, ['A', 'B', 'C', 'D']);
    assert.equal(active, 4);
    assert.equal(f.state.isLoading, false, 'ADB work does not impose a global loading lock');
    const finish = (id, failed = false) => {
      const row = server.get(id);
      server.set(id, {...row, status: failed ? 'error' : 'connected',
        active_serial: failed ? null : row.selected_serial, connect_failed: failed});
      if (failed) pending.get(id).reject(Error('offline'));
      else pending.get(id).resolve({json: async () => server.get(id)});
    };
    finish('C', true);
    await until(() => requested.includes('E'));
    assert(f.state.pendingDeviceIds.has('A'));
    assert(!f.state.pendingDeviceIds.has('C'));
    assert.equal(f.state.devices.find(row => row.id === 'C').last_error, 'offline');
    finish('B');
    await until(() => requested.includes('F'));
    assert(f.state.pendingDeviceIds.has('A'), 'F starts while slow A is still pending');
    assert(f.state.selectedDeviceIds.has('B'));
    for (const id of ['A', 'D', 'E', 'F']) finish(id);
    await run;
    assert.deepEqual(f.state.devices.map(row => row.id), ids, 'responses stay associated with their device');
    assert.equal(f.state.devices.find(row => row.id === 'C').status, 'error');
    assert.deepEqual([...f.state.selectedDeviceIds].sort(), ['A', 'B', 'D', 'E', 'F']);
    assert.equal(f.messages.filter(message => message.text.includes('已完成设备可立即操作')).length, 6);
    assert(f.messages.some(message => message.text.includes('已完成 6 / 6')));
    assert.equal(maxActive, 4);
    assert.equal(active, 0);
    assert.equal(f.state.pendingDeviceIds.size, 0);
    assert.equal(f.state.isBatchBusy, false);
    assert.equal(f.requests.filter(entry => entry.method === 'GET').length, 2,
      'one final metadata refresh after all per-device results');
  } finally {f.dispose();}
  console.log('Actual page batch connect: four concurrent, next on settle, isolated failure and correct identities: OK');
})().catch(error => {console.error(error); process.exitCode = 1;});
