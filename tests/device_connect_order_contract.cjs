/* Actual list model and page connection pipeline: stable order and confirmed selection. */
'use strict';
const assert = require('node:assert/strict');
const {createPageFixture, findAll} = require('./helpers/page-fixture.cjs');
const device = (id, properties = {}) => ({id, name: id, ip: '10.10.10.' + id, port: 5555,
  selected_route: 'mesh', selected_serial: '10.10.10.' + id + ':5555',
  active_serial: '10.10.10.' + id + ':5555', status: 'connected', connect_failed: false, ...properties});

(async () => {
  const {hasConnectedAdb, buildDeviceGroups} = await import('../web/features/devices/device-list-model.js');
  const goodA = device('1'), goodB = device('2');
  const disconnected = device('3', {status: 'disconnected', active_serial: null, connect_failed: true});
  const stale = device('4', {selected_serial: '10.10.10.4:5556'});
  const noActive = device('5', {active_serial: null});
  assert(hasConnectedAdb(goodA));
  for (const row of [disconnected, stale, noActive, null, device('6', {connect_failed: true})]) {
    assert(!hasConnectedAdb(row));
  }
  const mixed = [disconnected, goodA, stale, goodB, noActive];
  assert.deepEqual(buildDeviceGroups(mixed, []).grouped.get('ungrouped').items.map(row => row.id),
    ['1', '2', '3', '4', '5'], 'connected first, stable relative order in both partitions');
  const devices = Object.freeze([
    Object.freeze(device('3', {group_name: 'Zulu', status: 'disconnected', active_serial: null})),
    Object.freeze(device('1', {group_name: 'Zulu'})),
    Object.freeze(device('4', {group_name: 'Alpha', selected_serial: '10.10.10.4:5556'})),
    Object.freeze(device('2', {group_name: 'Zulu'})),
    Object.freeze(device('5', {group_name: null, status: 'idle', active_serial: null})),
    Object.freeze(device('6', {group_name: 'Zulu', status: 'error', active_serial: null})),
  ]);
  const groups = Object.freeze([
    Object.freeze({name: 'Alpha', ip_prefix: '10.0.1.*', discovery_configured: true}),
    Object.freeze({name: 'Zulu', ip_prefix: '10.0.0.*', discovery_needs_password: true}),
    Object.freeze({name: 'Empty', ip_prefix: null}),
  ]);
  const before = JSON.stringify({devices, groups});
  const {grouped, keys} = buildDeviceGroups(devices, groups);
  assert.deepEqual(keys, ['named:Zulu', 'named:Alpha', 'named:Empty', 'ungrouped']);
  assert.deepEqual(grouped.get('named:Zulu').items.map(row => row.id), ['1', '2', '3', '6']);
  assert.equal(grouped.get('named:Alpha').discovery_configured, true);
  assert.equal(grouped.get('named:Zulu').discovery_needs_password, true);
  assert.equal(grouped.get('named:Empty').items.length, 0);
  assert.equal(grouped.get('ungrouped').title, '未分组');
  assert.equal(JSON.stringify({devices, groups}), before, 'projection never mutates input records');
  const rendered = await createPageFixture({devices, groups});
  try {
    assert.deepEqual(findAll(rendered.get('devices'), node => node.type === 'checkbox').map(node => node.value),
      ['1', '2', '3', '6', '4', '5'], 'real page consumes the model ordering');
    assert.equal(JSON.stringify({devices, groups}), before);
  } finally {rendered.dispose();}

  for (const allFail of [false, true]) {
    const rows = [goodA, disconnected, goodB, stale];
    const f = await createPageFixture({devices: rows});
    try {
      f.requestOptions.handler = async (path, options) => {
        if (options.method === 'POST') {
          const id = decodeURIComponent(path.split('/')[3]);
          if (allFail || id === '3') throw Error('offline');
          return {json: async () => rows.find(row => row.id === id)};
        }
        return {json: async () => path === '/api/devices' ? f.data.devices : []};
      };
      for (const row of rows) f.state.selectedDeviceIds.add(row.id);
      f.page.render();
      const running = f.get('bulkConnect').click();
      assert.equal(f.state.selectedDeviceIds.size, 0, 'the actual bulk handler clears old selection');
      await running;
      assert.deepEqual([...f.state.selectedDeviceIds].sort(), allFail ? [] : ['1', '2'],
        'only successful responses with current ADB identity are selected');
      assert.equal(f.state.pendingDeviceIds.size, 0);
      assert.equal(f.state.isBatchBusy, false);
      assert.equal(f.requests.filter(entry => entry.method === 'POST').length, 4, 'one attempt per device');
    } finally {f.dispose();}
  }
  console.log('Connected-first model and actual page: stable ordering, immutable input, successful-only selection: OK');
})().catch(error => {console.error(error); process.exitCode = 1;});
