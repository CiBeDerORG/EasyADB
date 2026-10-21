/* Actual page, selection, MultiView and four live factories. Browser/media ports only are mocked. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createPageFixture, until} = require('./page-fixture.cjs');
const devices = Array.from({length: 5}, (_, index) => {
  const id = String(index + 1);
  return {id, name: 'Device ' + id, group_name: 'Default', ip: '192.0.2.' + id,
    port: 5555, status: 'connected', selected_route: 'mesh',
    selected_serial: '192.0.2.' + id + ':5555', active_serial: '192.0.2.' + id + ':5555'};
});

async function fixture() {
  const sockets = [], engineRequests = [];
  class MockSocket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(message) { this.sent.push(message); }
    close() { this.readyState = 3; }
    open() { this.readyState = 1; this.onopen(); }
    emit(type, data = {}) { this.onmessage({data: JSON.stringify({type, ...data})}); }
  }
  const f = await createPageFixture({devices, groups: [{name: 'Default'}],
    createGroupControl: () => ({refresh() {}, updateLog() {}}), createMultiView(supplied) {
    const browser = {document: supplied.picker.ownerDocument,
      location: {protocol: 'http:', host: 'mock.invalid'}, performance: {now: () => 0}, WebSocket: MockSocket,
      setTimeout: (callback, ms) => global.setTimeout(callback, ms), clearTimeout: id => global.clearTimeout(id),
      fetch: async url => {
        assert.equal(url, '/api/m2/video-engine'); engineRequests.push(url);
        return {ok: true, json: async () => ({engine: 'webrtc', implemented: true, max_starting: 3})};
      },
      EasyADBWebRTC: {create: (_video, callbacks) => ({
        async start() {}, initialize() { callbacks.onState('ready'); }, destroy() {}, resume() {},
      })},
      EasyADBTouch: {create: () => ({enable() {}, disable() {}, destroy() {}})},
    };
    browser.window = browser;
    const context = vm.createContext(browser);
    for (const file of ['web/m2-traffic.js', 'web/m2-metrics.js', 'web/m2-multi.js']) {
      vm.runInContext(fs.readFileSync(path.join(__dirname, '../../', file), 'utf8'), context, {filename: file});
    }
    assert.equal(browser.EasyADBMulti.MAX_DEVICES, 20, 'execute the unchanged production capacity');
    return browser.EasyADBMulti.create(supplied);
  }});
  const view = f.page.multiView;
  await until(() => view.engineReady);
  for (const device of devices) f.controllers.management.selectDevice(device.id, true);
  assert.equal(f.get('multiStart').disabled, false); await f.get('multiStart').click();
  assert.deepEqual([...view.cards.keys()], ['1', '2', '3']);
  assert.deepEqual(Array.from(view.launchQueue, item => item.device.id), ['4', '5']);
  assert.equal(view.launchInFlight, 3); assert.equal(sockets.length, 3);
  const originalCards = new Map(view.cards);
  return {...f, view, sockets, originalCards,
    choose(ids) {
      for (const device of devices) f.controllers.management.selectDevice(device.id, ids.includes(device.id));
      assert.deepEqual([...f.state.selectedDeviceIds].sort(), [...ids].sort());
      assert.equal(view.selected, f.state.selectedDeviceIds, 'the management and live controls share one selection');
    },
    assertButton(count, disabled = count === 0) {
      assert.equal(f.get('multiStop').textContent, '批量停止投屏（' + count + ' 台）');
      assert.equal(f.get('multiStop').disabled, disabled);
    },
    unchanged(ids) {
      for (const id of ids) {
        const card = view.cards.get(id);
        assert.equal(card, originalCards.get(id)); assert.equal(card.closed, false);
        assert.equal(card.state, 'connecting');
        assert.equal(card.ws.readyState, 0); assert.deepEqual(card.ws.sent, []);
      }
    },
    start(id) {
      const socket = view.cards.get(id).ws;
      socket.open(); socket.emit('starting', {session_id: 'session-' + id}); return socket;
    },
    ready(id) {
      const socket = view.cards.get(id).ws;
      if (!socket.readyState) { socket.open(); socket.emit('starting', {session_id: 'session-' + id}); }
      socket.emit('init', {session_id: 'session-' + id, width: 720, height: 1280, control_available: false});
    },
    cleanup() {
      view.closeAll(); assert.deepEqual(engineRequests, ['/api/m2/video-engine']);
      assert.equal(f.requests.length, 0, 'the batch stop never creates an ADB or metadata request'); f.dispose();
    },
  };
}

async function queuedOnly() {
  const f = await fixture();
  try {
    f.choose(['4', '5']); f.assertButton(2);
    await f.get('multiStop').click();
    assert.equal(f.view.launchQueue.length, 0); assert.equal(f.view.stopBatch, null);
    assert.equal(f.sockets.length, 3); f.unchanged(['1', '2', '3']); f.assertButton(0);
    assert.deepEqual([...f.state.selectedDeviceIds], ['4', '5'], 'bulk cancellation preserves the existing selection contract');
    for (const id of ['1', '2', '3']) f.ready(id);
    assert.equal(f.sockets.length, 3, 'cancelled queue entries cannot launch after startup slots settle');
    assert.equal(f.view.launchInFlight, 0); assert.equal(f.view.opening, false);
    assert.equal(f.get('multiStart').disabled, false, 'an intentional later batch can reuse the retained selection');
  } finally { f.cleanup(); }
}

async function queuedSubset() {
  const f = await fixture();
  try {
    f.choose(['4']); f.assertButton(1); await f.get('multiStop').click();
    assert.deepEqual(Array.from(f.view.launchQueue, item => item.device.id), ['5']);
    f.unchanged(['1', '2', '3']); f.assertButton(0);
    f.ready('1');
    assert.equal(f.sockets.length, 4);
    assert.deepEqual([...f.view.cards.keys()], ['1', '2', '3', '5'], 'only the unselected queued peer may start');
    assert.equal(f.view.cards.has('4'), false);
  } finally { f.cleanup(); }
}

async function mixedCleanup() {
  const f = await fixture();
  try {
    f.choose(['1', '2', '4']); f.assertButton(3);
    const first = f.start('1'), second = f.start('2');
    await f.get('multiStop').click();
    assert.equal(first.sent.at(-1), 'stop'); assert.equal(second.sent.at(-1), 'stop');
    assert.deepEqual(Array.from(f.view.launchQueue, item => item.device.id), ['5']);
    assert.equal(f.view.stopBatch.total, 2, 'only opened sessions participate in server cleanup accounting');
    assert.equal(f.view.stopBatch.pending.size, 2); assert.equal(f.view.stopBatch.clean, 0); assert.equal(f.view.stopBatch.failed, 0);
    f.unchanged(['3']); f.assertButton(0, true);
    assert.equal(f.view.cards.get('1').state, 'stopping'); assert.equal(f.view.cards.get('2').state, 'stopping');
    // A different queued selection is shown but cannot start a second stop batch during cleanup.
    f.choose(['5']); f.assertButton(1, true); await f.get('multiStop').click();
    assert.deepEqual(Array.from(f.view.launchQueue, item => item.device.id), ['5']);
    second.emit('ended', {session_id: 'session-2', cleanup_complete: false});
    assert.equal(f.view.stopBatch.total, 2); assert.equal(f.view.stopBatch.failed, 1); assert.equal(f.view.stopBatch.clean, 0);
    assert.equal(f.view.stopBatch.pending.has('1'), true);
    assert.equal(f.view.cards.has('4'), false, 'a selected cancelled queue entry stays cancelled');
    assert.equal(f.view.cards.has('5'), true, 'the unselected peer retains its queued startup');
    first.emit('ended', {session_id: 'session-1', cleanup_complete: true});
    assert.equal(f.view.stopBatch, null);
    assert.match(f.get('multiInfo').textContent, /2 \/ 2 台；已确认清理 1 台，未确认 1 台/);
    assert.equal(f.sockets.length, 4); f.unchanged(['3']);
    assert.equal(f.view.cards.has('4'), false); f.assertButton(1);
  } finally { f.cleanup(); }
}

module.exports = async function queuedStopContract() {
  await queuedOnly(); await queuedSubset(); await mixedCleanup();
  console.log('Real page queued-only/subset/mixed batch stop: shared selection, cancellation and cleanup counters: OK');
};
