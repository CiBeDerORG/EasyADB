/* Actual page + actual display-lab IIFE; only DOM, transport and media ports are mocked. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createPageFixture, deferred, until, findAll} = require('./page-fixture.cjs');
const labSource = fs.readFileSync(path.join(__dirname, '../../web/display-lab.js'), 'utf8');
// Both devices meet lab_handlers.lab_connected_serial's connected-address prerequisite.
const devices = ['1', '2'].map(id => ({id, name: 'Phone ' + id, group_name: 'Home',
  ip: '192.0.2.' + id, port: 5555, selected_route: 'mesh',
  selected_serial: '192.0.2.' + id + ':5555', active_serial: '192.0.2.' + id + ':5555', status: 'connected'}));
const state = id => ({pending_restore: null, pending_castplus: null,
  logs: [{at: 'now', action: 'scan', detail: 'State for ' + id}]});
const scan = id => ({display_ids: [0, id], display_excerpt: 'Display ' + id,
  cast_display: {verified: false, display_id: null, display_ids: []}});
const response = result => ({json: async () => result});

async function fixture(request) {
  const starts = [], stops = [], media = new Set();
  let dialog, lab;
  const f = await createPageFixture({devices, groups: [{name: 'Home'}], request,
    createDisplayLab(options) {
      dialog = options.dialog;
      // Fill the browser DOM capabilities missing from the general fixture.
      const queryAll = dialog.querySelectorAll.bind(dialog);
      dialog.querySelectorAll = selector => selector === '[data-lab-action]'
        ? findAll(dialog, node => node.hasAttribute('data-lab-action')) : queryAll(selector);
      for (const button of dialog.querySelectorAll('[data-lab-action]')) {
        button.dataset = {labAction: button.getAttribute('data-lab-action')};
        button.closest = selector => selector === '[data-lab-action]' ? button : null;
      }
      options.multiView.isBusyFor = id => media.has(id);
      options.multiView.startLabFor = (id, payload) => {
        starts.push({id, payload: {...payload}}); media.add(id); return true;
      };
      options.multiView.stopFor = id => { stops.push(id); return media.delete(id); };
      const root = {document: dialog.ownerDocument, AbortController}; root.window = root;
      vm.runInNewContext(labSource, root, {filename: 'web/display-lab.js'});
      return lab = root.EasyADBDisplayLab.create(options);
    }});
  const action = name => dialog.querySelectorAll('[data-lab-action]').find(node => node.dataset.labAction === name);
  return {...f, dialog, lab, starts, stops, media, action,
    open(id) {
      const row = findAll(f.get('devices'), node => node.className === 'item' &&
        findAll(node, child => child.className === 'item-name' && child.textContent === 'Phone ' + id).length)[0];
      const button = findAll(row, node => node.tagName === 'BUTTON' && node.textContent === '电脑模式实验')[0];
      assert.equal(button.disabled, false); return button.click();
    },
    run(name) {
      assert.equal(action(name).disabled, false, name + ' should be available');
      return dialog.fire('click', {target: action(name)});
    },
    snapshot() {
      return JSON.stringify({open: dialog.open,
        text: ['labStatus', 'labRaw', 'labLogs', 'labPending', 'labEnvironment', 'labCastReport'].map(id => f.get(id).textContent),
        statusClass: f.get('labStatus').className,
        displays: f.get('labDisplayId').children.map(node => node.value),
        disabled: dialog.querySelectorAll('[data-lab-action]').map(node => node.disabled)});
    },
  };
}

async function lateCompletion(phase, failure, nextId) {
  const oldGate = deferred(), nextGate = deferred();
  let stateReads = 0, held = false, jsonEntered = false, newTask = false;
  const f = await fixture(async (url, options, entry) => {
    if (url === '/api/devices/1/display-lab/state') stateReads++;
    const old = !held && ((phase.startsWith('initial') && url.endsWith('/state')) ||
      (phase.startsWith('action') && url.endsWith('/scan')) ||
      (phase.startsWith('final') && url.endsWith('/state') && stateReads === 2));
    if (old) {
      held = entry;
      return phase.endsWith('json') ? {json: () => { jsonEntered = true; return oldGate.promise; }} : oldGate.promise;
    }
    if (url.endsWith('/scan')) return newTask ? nextGate.promise : response(scan(17));
    assert(url.endsWith('/state')); return response(state(url.includes('/1/') ? '1' : '2'));
  });
  try {
    let oldTask;
    if (phase.startsWith('initial')) oldTask = f.open('1');
    else { await f.open('1'); oldTask = f.run('b2'); }
    await until(() => held && (!phase.endsWith('json') || jsonEntered));
    if (!phase.startsWith('initial')) assert.equal(f.dialog.dispatch('cancel').event.defaultPrevented, true);
    assert.equal(f.get('labClose').disabled, false);
    await f.get('labClose').click();
    assert.equal(held.signal.aborted, true, 'closing must cancel the old request signal');
    await f.open(nextId);
    newTask = true;
    const pending = f.run('b2');
    await until(() => f.requests.at(-1).path.endsWith('/scan'));
    const nextRequest = f.requests.at(-1), snapshot = f.snapshot(), count = f.requests.length;
    // A native close event queued by A must not invalidate the already reopened dialog.
    await f.dialog.fire('close');
    assert.equal(nextRequest.signal.aborted, false);
    if (phase.endsWith('json')) {
      if (failure) oldGate.reject(Error('Old JSON failure'));
      else oldGate.resolve(phase.startsWith('action') ? scan(17) : {
        pending_restore: {serial: devices[0].selected_serial}, pending_castplus: {},
        logs: [{at: 'old', action: 'old', detail: 'old device state'}]});
    } else if (failure) {
      // Use the actual API client's non-OK HTTP boundary, rather than a fake success payload.
      oldGate.resolve({ok: false, status: 502, json: async () => ({detail: 'Old HTTP failure'})});
    } else oldGate.resolve(response(phase.startsWith('action') ? scan(17) : {
      pending_restore: {}, pending_castplus: {}, logs: [{at: 'old', action: 'old', detail: 'old device state'}]}));
    await oldTask;
    assert.equal(f.snapshot(), snapshot, phase + ': old success/error/finally must not change the new dialog');
    assert.equal(f.requests.length, count, 'the old operation cannot issue a follow-up GET for the new device');
    assert.equal(nextRequest.signal.aborted, false);
    assert.equal(f.action('b2').disabled, true, 'old finally must not release the new operation lock');
    assert.deepEqual(f.stops, []);
    nextGate.resolve(response(scan(29))); await pending;
    assert.equal(f.action('b2').disabled, false);
    assert.equal(f.get('labRaw').textContent, 'Display 29');
    assert.deepEqual(f.get('labDisplayId').children.map(node => node.value), ['29']);
    f.get('labDisplayId').value = '29'; await f.get('labDisplayId').fire('change');
    await f.run('b3');
    assert.deepEqual(f.starts, [{id: nextId, payload: {mode: 'display', display_id: 29}}]);
    assert.equal(f.dialog.open, false);
    assert(f.media.has(nextId), 'the new preview remains owned by MultiView after closing the lab');
    assert.deepEqual(f.stops, [], 'invalidating old lab requests must never stop a preview');
    await f.open(nextId); await f.get('labStop').click();
    assert.deepEqual(f.stops, [nextId], 'only the explicit current-device stop action may stop the preview');
  } finally { f.dispose(); }
}

async function tokenAndAddressInvalidation(kind, failure) {
  const gate = deferred(); let entered = false;
  const f = await fixture(async url => {
    if (url.endsWith('/scan')) return {json: () => { entered = true; return gate.promise; }};
    assert(url.endsWith('/state')); return response(state('current'));
  });
  try {
    await f.open('1'); const pending = f.run('b2'); await until(() => entered);
    const oldRequest = f.requests.at(-1);
    if (kind === 'token') {
      f.get('token').value = 'replacement-token'; await f.get('token').fire('input');
      assert.equal(f.dialog.open, false);
      assert.equal(oldRequest.signal.aborted, true);
      f.installRows(devices, [{name: 'Home'}]); await f.open('1');
    } else {
      f.installRows(devices.map(device => device.id === '1'
        ? {...device, selected_serial: '198.51.100.1:5555', active_serial: '198.51.100.1:5555'} : device));
    }
    const snapshot = f.snapshot(), count = f.requests.length;
    if (failure) gate.reject(Error('Late failed scan')); else gate.resolve(scan(17));
    await pending;
    assert.equal(f.snapshot(), snapshot);
    assert.equal(f.requests.length, count);
    assert.deepEqual(f.starts, []); assert.deepEqual(f.stops, []);
    await f.get('labClose').click(); await f.open('1');
    assert.equal(f.action('b2').disabled, false, 'a new context can retry after token or address invalidation');
  } finally { f.dispose(); }
}

async function currentActionsRemainUsable() {
  let fail = true, currentState = state('1');
  const f = await fixture(async (url, options, entry) => {
    if (url.endsWith('/state')) return response(currentState);
    assert.equal(entry.method, 'POST');
    if (url.endsWith('/scan') && fail) return {ok: false, status: 409, json: async () => ({detail: '当前线路暂不可用'})};
    if (url.endsWith('/castplus/auto')) return response({cast_display: {verified: false, display_id: 31}, note: '尚未验证'});
    if (url.endsWith('/environment')) return response({...scan(29), android_version: '13', api_level: 33,
      scrcpy_server_version: 'test', overlay_setting: '', castplus_capabilities: {available: true}});
    return response(scan(29));
  });
  try {
    await f.open('1');
    await f.run('b2');
    assert.equal(f.get('labStatus').textContent, '当前线路暂不可用');
    assert.equal(f.get('labStatus').className, 'status error');
    assert.equal(f.action('b2').disabled, false);
    fail = false; await f.run('b2');
    assert.equal(f.get('labRaw').textContent, 'Display 29');
    await f.run('env');
    assert.match(f.get('labEnvironment').textContent, /Android 13（API 33）/);
    assert.match(f.get('labCastReport').textContent, /available/);
    await f.run('cast2');
    assert.equal(f.get('labStatus').textContent, '尚未验证');
    assert.equal(f.get('labStatus').className, 'status error');
    assert(f.get('labDisplayId').children.some(node => node.value === '31'));
    assert.equal(f.action('castrestore').disabled, true);
    currentState = {...state('1'), pending_restore: {}, pending_castplus: {}};
    await f.run('b2');
    assert.equal(f.action('b1').disabled, true); assert.equal(f.action('cast1').disabled, true);
    assert.equal(f.action('restore').disabled, false); assert.equal(f.action('castrestore').disabled, false);
    assert.equal(f.dialog.cancel().defaultPrevented, false);
    assert.equal(f.dialog.open, false);
    assert.equal(f.requests.at(-1).signal.aborted, true);
  } finally { f.dispose(); }
}

module.exports = async function displayLabContract() {
  for (const phase of ['initial-request', 'initial-json', 'action-request', 'action-json', 'final-request', 'final-json']) {
    for (const failure of [false, true]) {
      for (const nextId of ['1', '2']) await lateCompletion(phase, failure, nextId);
    }
  }
  for (const kind of ['token', 'address']) for (const failure of [false, true]) await tokenAndAddressInvalidation(kind, failure);
  await currentActionsRemainUsable();
  console.log('Display lab real page: 24 stale response/JSON/finally cases, token/address invalidation and current preview ownership: OK');
};
