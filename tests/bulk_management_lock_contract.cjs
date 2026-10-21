/* Real page events retain their own management lock while rechecking each device. */
'use strict';
const assert = require('node:assert/strict');
const {createPageFixture} = require('./helpers/page-fixture.cjs');

async function verify(handlerId, suffix) {
  const initial = [
    {id: 'ready', name: 'Ready', status: 'connected'},
    {id: 'late', name: 'Becomes busy', status: 'connected'},
    {id: 'prebusy', name: 'Already projecting', status: 'connected'},
  ];
  const server = new Map(initial.map(device => [device.id, {...device}]));
  let f;
  f = await createPageFixture({devices: initial, busy: ['prebusy'], request: async (path, options) => {
    if (!options.method) return {json: async () => path === '/api/groups' ? [] : [...server.values()]};
    assert.equal(f.state.isLoading, true, 'the batch still owns the page lock during its own I/O');
    const id = decodeURIComponent(path.split('/')[3]);
    if (id === 'ready') f.busy.add('late');
    if (options.method === 'DELETE') server.delete(id);
    else server.set(id, {...server.get(id), status: 'checked'});
    return {json: async () => server.get(id)};
  }});
  f.state.selectedDeviceId = 'ready';
  for (const device of initial) f.state.selectedDeviceIds.add(device.id);
  const redraws = f.live.redrawCount;
  await f.get(handlerId).fire('click');
  const {state, requests, confirmations, messages} = f;
  assert.deepEqual(requests.filter(entry => entry.method !== 'GET').map(entry => [entry.path, entry.method]),
    [['/api/devices/ready' + suffix, handlerId === 'bulkDelete' ? 'DELETE' : 'POST']],
    'page-level loading cannot block an eligible batch target; newly busy targets are skipped');
  assert.equal(state.isLoading, false, 'the page lock must be released');
  assert.equal(state.activeBatch, null, 'the finished batch relinquishes ownership');
  assert.deepEqual(requests.filter(entry => entry.method === 'GET').map(entry => entry.path),
    ['/api/devices', '/api/groups'], 'one final metadata refresh');
  assert(f.live.redrawCount >= redraws + 2, 'disabled controls redraw before and after the operation');
  assert.equal(confirmations.length, handlerId === 'bulkDelete' ? 1 : 0);
  if (handlerId === 'bulkDelete') {
    assert.equal(state.selectedDeviceId, null);
    assert.deepEqual([...state.selectedDeviceIds], ['late', 'prebusy']);
    assert(messages.some(message => message.text.includes('已删除 1 台')));
    assert(messages.some(message => message.text.includes('其他未删除 1 台')));
  } else {
    assert.equal(state.devices[0].status, 'checked');
    assert(messages.some(message => message.text.includes('已检查 1 台')));
    assert(messages.some(message => message.text.includes('其他失败/跳过 1 台')));
  }
  f.dispose();
}

(async () => {
  await verify('bulkDelete', '');
  await verify('refreshAll', '/refresh');
  console.log('Bulk delete/refresh: page lock does not self-skip; per-device busy state is rechecked: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
