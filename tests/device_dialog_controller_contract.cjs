/* E device dialog behavior and real page lifecycle; no network or real devices. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('web/index.html', 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
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
const makeDevices = () => [1, 2].map(number => ({
  id: String(number), name: 'Phone ' + number, group_name: 'Home',
  ip: '10.0.0.' + number, mesh_ip: '10.0.0.' + number,
  lan_ip: '192.168.0.' + number, temp_ip: number === 1 ? '172.16.0.1' : null, port: 5555,
  selected_route: 'mesh', selected_serial: '10.0.0.' + number + ':5555',
  active_serial: null, status: 'error', connect_failed: true,
}));
const makeGroups = () => [
  {name: 'Work', ip_prefix: null, discovery_configured: false},
  {name: 'Home', ip_prefix: '192.168.0.*', discovery_configured: true,
    discovery_url: 'http://router/ubus', discovery_username: 'easyadb'},
];

class Element {
  constructor(tagName, className = '', textContent = '') {
    Object.assign(this, {tagName, className, textContent, children: [], events: new Map(),
      attrs: {}, style: {}, value: '', defaultValue: '', checked: false, disabled: false,
      hidden: false, open: false, closeCount: 0, showCount: 0, resetCount: 0, focusCount: 0});
  }
  append(...nodes) { this.children.push(...nodes); }
  prepend(...nodes) { this.children.unshift(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  addEventListener(name, listener) {
    if (!this.events.has(name)) this.events.set(name, []);
    this.events.get(name).push(listener);
  }
  dispatch(name, overrides = {}) {
    const event = {target: this, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, ...overrides};
    const results = (this.events.get(name) || []).map(listener => listener(event));
    return {event, pending: Promise.all(results)};
  }
  fire(name, overrides = {}) {
    assert(this.events.has(name), 'missing DOM event: ' + this.id + '/' + name);
    return this.dispatch(name, overrides).pending;
  }
  reset() {
    this.resetCount++;
    for (const element of this.controls || []) element.value = element.defaultValue;
  }
  focus() { this.focusCount++; }
  showModal() { this.open = true; this.showCount++; }
  close() {
    if (!this.open) return;
    this.open = false; this.closeCount++;
    this.dispatch('close');
  }
  cancel() {
    const {event} = this.dispatch('cancel');
    if (!event.defaultPrevented) this.close();
    return event;
  }
}

function makeDOM() {
  const elements = new Map();
  for (const match of html.matchAll(/<([\w-]+)\b([^<>]*\bid="([^"]+)"[^<>]*)>/g)) {
    const [, tag, attributes, id] = match;
    assert(!elements.has(id), 'the page contains duplicate id ' + id);
    const element = new Element(tag);
    element.id = id;
    for (const attr of attributes.matchAll(/([\w-]+)="([^"]*)"/g)) element.attrs[attr[1]] = attr[2];
    element.value = element.defaultValue = element.attrs.value || '';
    element.hidden = /(?:^|\s)hidden(?:\s|$)/.test(attributes);
    element.disabled = /(?:^|\s)disabled(?:\s|$)/.test(attributes);
    elements.set(id, element);
  }
  const getElement = id => {
    assert(elements.has(id), 'controller references an absent HTML id: ' + id);
    return elements.get(id);
  };
  for (const match of html.matchAll(/<form\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)) {
    getElement(match[1]).controls = [...match[2].matchAll(/<(?:input|select|textarea)\b[^>]*id="([^"]+)"/g)]
      .map(control => getElement(control[1]));
  }
  const createElement = tag => new Element(tag);
  return {elements, getElement, createElement};
}

function assertMarkup() {
  const dialogs = [...html.matchAll(/<dialog\b[^>]*id="([^"]+)"[^>]*>/g)].map(match => match[1]);
  assert.deepEqual(dialogs, ['deviceDialog', 'tempDialog', 'groupDialog', 'firstPairDialog', 'displayLabDialog']);
  const {getElement} = makeDOM();
  for (const [id, title] of [['deviceDialog', 'formTitle'], ['tempDialog', 'tempDialogTitle'],
    ['groupDialog', 'groupFormTitle'], ['firstPairDialog', 'firstPairTitle'], ['displayLabDialog', 'labTitle']]) {
    assert.equal(getElement(id).attrs['aria-labelledby'], title);
    assert(getElement(title));
  }
  const input = id => {
    const match = html.match(new RegExp('<input\\b[^>]*id="' + id + '"[^>]*>'));
    assert(match, 'missing input ' + id);
    return match[0];
  };
  for (const id of ['name', 'ip', 'port', 'tempIp', 'tempSharedPort', 'groupName', 'firstPairPort', 'firstPairCode']) {
    assert(/\srequired(?:\s|>)/.test(input(id)), id + ' retains native required validation');
  }
  for (const id of ['port', 'tempSharedPort', 'firstPairPort', 'pairPort']) {
    assert.equal(getElement(id).attrs.type, 'number');
    assert.equal(getElement(id).attrs.min, '1');
    assert.equal(getElement(id).attrs.max, '65535');
  }
  for (const id of ['name', 'group', 'groupName']) assert.equal(getElement(id).attrs.maxlength, '64');
  assert(/\sreadonly(?:\s|>)/.test(input('firstPairIp')));
  assert.equal(getElement('firstPairIp').attrs['aria-readonly'], 'true');
  assert.equal(getElement('firstPairCode').attrs.pattern, '[0-9]{6}');
  assert.equal(getElement('firstPairCode').attrs.maxlength, '6');
  assert.equal(getElement('groupOpenWrtPassword').attrs.type, 'password');
  assert.equal(getElement('groupOpenWrtPassword').attrs.autocomplete, 'new-password');
  for (const id of ['formMessage', 'tempMessage', 'groupMessage']) assert.equal(getElement(id).attrs.role, 'alert');
  for (const id of ['pairMessage', 'firstPairMessage']) {
    assert.equal(getElement(id).attrs.role, 'status');
    assert.equal(getElement(id).attrs['aria-live'], 'polite');
  }
}

function fixture(modules) {
  const dom = makeDOM(), get = dom.getElement;
  const state = {
    devices: makeDevices(), groups: makeGroups(), selectedDeviceId: '2',
    editingDeviceId: null, editingTempDeviceId: null, pairingDeviceId: null, pairingSerial: null,
    isLoaded: true, isLoading: false, generation: 0, activeOperation: null, activePairOperation: null,
    deviceDialogRevision: 0, tempDialogRevision: 0, firstPairDialogRevision: 0,
  };
  const server = new Map(state.devices.map(device => [device.id, {...device}]));
  const requests = [], refreshes = [], notices = [], changes = [], saves = [], tempSaves = [];
  const busy = new Set(), connecting = new Set();
  const behavior = {deferRequests: false, onRequest: null, refresh: null, onChange: null,
    saveDevice: null, saveTempAddress: null};
  const dialog = modules.createDialogController({getElement: get});
  const response = (entry, updateServer = true) => {
    if (entry.path === '/api/pair' || entry.path.endsWith('/pair')) return {json: async () => ({message: '已配对'})};
    let device = {...server.get(entry.deviceId)};
    if (entry.path === '/api/devices') device = {...makeDevices()[0], ...entry.body, id: 'new', mesh_ip: entry.body.ip};
    else if (entry.path.endsWith('/temp-address')) device = {...device, temp_ip: entry.body.ip, port: entry.body.port};
    else device = {...device, ...entry.body, mesh_ip: entry.body.ip};
    if (updateServer) server.set(device.id, device);
    return {json: async () => device};
  };
  const request = async (path, options = {}) => {
    const entry = {path, deviceId: decodeURIComponent(path.split('/')[3] || ''), method: options.method || 'GET',
      body: options.body && JSON.parse(options.body), signal: options.signal, headers: options.headers, pending: deferred()};
    requests.push(entry);
    if (behavior.onRequest) await behavior.onRequest(entry);
    if (behavior.deferRequests) return entry.pending.promise;
    return response(entry);
  };
  const onChange = () => {
    changes.push({loading: state.isLoading, operation: state.activePairOperation});
    if (behavior.onChange) behavior.onChange();
  };
  const notify = (text, kind = '') => notices.push({text, kind});
  const configuration = modules.createDeviceConfigurationController({
    state, request,
    refreshDevices: async () => {
      refreshes.push(true);
      if (behavior.refresh) return behavior.refresh();
      state.devices = [...server.values()];
      return true;
    },
    isDeviceBusy: id => busy.has(id) || connecting.has(id),
    isDeviceConnecting: id => connecting.has(id), confirmRemoveTemp: () => true,
    onChange, notify, onDeviceSaved: () => dialog.closeDialog('deviceDialog'),
    onDeviceError: text => dialog.modalMessage(text),
    onTempError: text => dialog.modalMessage(text, 'error', 'tempMessage'),
  });
  const options = {state, ...dom, dialog, request,
    saveDevice: (id, payload) => {
      saves.push({id, payload});
      return behavior.saveDevice ? behavior.saveDevice(id, payload) : configuration.saveDevice(id, payload);
    },
    saveTempAddress: (id, ip, port) => {
      tempSaves.push({id, ip, port});
      return behavior.saveTempAddress ? behavior.saveTempAddress(id, ip, port) : configuration.saveTempAddress(id, ip, port);
    },
    isDeviceBusy: id => busy.has(id), isDeviceConnecting: id => connecting.has(id), onChange, notify,
  };
  const controller = modules.createDeviceDialogController(options);
  controller.bindEvents();
  return {state, ...dom, get, server, requests, refreshes, notices, changes, saves, tempSaves, busy, connecting,
    behavior, configuration, controller, options, response,
    finish(entry) { entry.pending.resolve(response(entry)); }};
}

function fillPair(f, kind, code = '123456') {
  if (kind === 'address') {
    f.controller.openDevice('1');
    f.get('pairIp').value = ' 192.168.99.1 ';
    f.get('pairPort').value = '37123'; f.get('pairCode').value = ' ' + code + ' ';
  } else {
    f.controller.openFirstPair('1');
    f.get('firstPairPort').value = '37123'; f.get('firstPairCode').value = ' ' + code + ' ';
  }
}
const pairAction = (f, kind) => kind === 'address' ? f.controller.pairAddress() : f.controller.pairDevice();
const pairField = kind => kind === 'address' ? 'pairCode' : 'firstPairCode';
const pairMessage = kind => kind === 'address' ? 'pairMessage' : 'firstPairMessage';

async function checkDialogForms(modules) {
  const f = fixture(modules), get = f.get;
  assert.equal(f.requests.length, 0, 'dialog construction and binding are passive');
  for (let repeat = 0; repeat < 3; repeat++) f.controller.bindEvents();
  for (const element of f.elements.values()) {
    for (const listeners of element.events.values()) assert.equal(listeners.length, 1, 'bindEvents is idempotent');
  }
  assert.equal(get('displayLabDialog').events.size, 0, 'the existing display lab retains its own dialog owner');
  get('formMessage').hidden = false; get('formMessage').textContent = 'old error';
  get('pairCode').value = 'old code';
  assert.equal(f.controller.openDevice(), true);
  assert.equal(get('deviceDialog').open, true);
  assert.equal(get('name').focusCount, 1);
  assert.equal(f.state.editingDeviceId, null);
  assert.equal(get('formMessage').hidden, true);
  assert.equal(get('pairCode').value, '');
  assert.deepEqual(get('groupNames').children.map(node => node.value), ['Home', 'Work']);
  get('name').value = 'New phone'; get('group').value = 'Work';
  get('ip').value = ' 10.9.8.7 '; get('port').value = '6000';
  const submitted = get('form').dispatch('submit');
  assert.equal(submitted.event.defaultPrevented, true);
  await submitted.pending;
  assert.equal(f.saves.length, 1);
  assert.deepEqual(f.saves[0], {id: null, payload: {name: 'New phone', group_name: 'Work', ip: '10.9.8.7', port: 6000}});
  assert.deepEqual(f.requests.map(entry => [entry.path, entry.method]), [['/api/devices', 'POST']]);
  assert.equal(f.state.selectedDeviceId, 'new');
  assert.equal(get('deviceDialog').open, false);
  assert.equal(f.state.editingDeviceId, null);
  assert.deepEqual(f.refreshes, [true], 'D3 owns the one metadata refresh');

  assert.equal(f.controller.openDevice('1'), true);
  assert.equal(f.state.editingDeviceId, '1');
  assert.equal(get('name').value, 'Phone 1');
  assert.equal(get('group').value, 'Home');
  assert.equal(get('ip').value, '10.0.0.1');
  assert.equal(get('pairIp').value, '10.0.0.1');
  assert.equal(get('formTitle').textContent, '编辑设备');
  get('name').value = 'Changed';
  await get('form').fire('submit');
  assert.equal(f.saves[1].id, '1');
  assert.equal(f.requests[1].method, 'PUT');
  assert.equal(f.requests[1].path, '/api/devices/1');
  assert.equal(f.refreshes.length, 2);

  assert.equal(f.controller.openTemp('1'), true);
  assert.equal(get('tempDialogTitle').textContent, '修改临时 IP');
  assert.equal(get('tempIp').focusCount, 1);
  assert.equal(get('tempIp').value, '172.16.0.1');
  assert.equal(get('tempSharedPort').value, '5555');
  get('tempIp').value = ' 10.9.8.6 '; get('tempSharedPort').value = '6555';
  await get('tempForm').fire('submit');
  assert.deepEqual(f.tempSaves, [{id: '1', ip: '10.9.8.6', port: 6555}]);
  assert.equal(f.requests[2].path, '/api/devices/1/temp-address');
  assert.deepEqual(f.requests[2].body, {ip: '10.9.8.6', port: 6555});
  assert.equal(get('tempDialog').open, false);
  assert.equal(f.state.editingTempDeviceId, null);
  assert.equal(f.refreshes.length, 3);
  assert(f.requests.every(entry => !entry.path.endsWith('/connect')), 'dialog saves never add a second connect flow');
  assert.equal(f.controller.openTemp('2'), true);
  assert.equal(get('tempDialogTitle').textContent, '添加临时 IP');
  assert.equal(get('tempIp').value, '');
}

async function checkGuardsAndFailures(modules) {
  const opens = [f => f.controller.openDevice('1'), f => f.controller.openTemp('1'), f => f.controller.openFirstPair('1')];
  for (const reason of ['loading', 'unloaded', 'missing', 'connecting', 'projecting']) {
    for (const open of opens) {
      const f = fixture(modules);
      if (reason === 'loading') f.state.isLoading = true;
      if (reason === 'unloaded') f.state.isLoaded = false;
      if (reason === 'missing') f.state.devices = [];
      if (reason === 'connecting') f.connecting.add('1');
      if (reason === 'projecting') f.busy.add('1');
      assert.equal(open(f), false, 'unavailable dialog target: ' + reason);
      assert.equal(f.requests.length, 0);
      assert.equal(f.get('deviceDialog').open || f.get('tempDialog').open || f.get('firstPairDialog').open, false);
    }
  }
  const idle = fixture(modules);
  idle.connecting.add('2'); idle.state.connectionBatchBusy = true;
  assert.equal(idle.controller.openDevice(), true);
  assert.equal(idle.controller.openDevice('1'), true, 'other connections leave an idle editor available');
  assert.equal(idle.controller.openTemp('1'), true);
  assert.equal(idle.controller.openFirstPair('1'), true);
  for (const reason of ['not-failed', 'no-serial']) {
    const f = fixture(modules);
    if (reason === 'not-failed') f.state.devices[0].connect_failed = false;
    else f.state.devices[0].selected_serial = null;
    assert.equal(f.controller.openFirstPair('1'), false);
  }
  for (const kind of ['device', 'temp']) {
    const f = fixture(modules);
    const formId = kind === 'device' ? 'form' : 'tempForm';
    const dialogId = kind === 'device' ? 'deviceDialog' : 'tempDialog';
    const messageId = kind === 'device' ? 'formMessage' : 'tempMessage';
    if (kind === 'device') f.controller.openDevice('1'); else f.controller.openTemp('1');
    f.behavior.onRequest = () => { throw Error('server refused this save'); };
    await f.get(formId).fire('submit');
    assert.equal(f.get(dialogId).open, true, 'a failed save keeps its editor and input');
    assert.match(f.get(messageId).textContent, /server refused/);
    assert.equal(f.get(messageId).hidden, false);
    assert.equal(f.state.isLoading, false);
    assert.equal(f.refreshes.length, kind === 'temp' ? 1 : 0);
  }
  const temp = fixture(modules), pending = deferred();
  temp.behavior.saveTempAddress = () => pending.promise;
  temp.controller.openTemp('1');
  const oldSave = temp.controller.submitTemp();
  temp.get('tempDialog').close(); temp.controller.openTemp('1');
  temp.get('tempIp').value = 'new session value';
  pending.resolve(true);
  assert.equal(await oldSave, false);
  assert.equal(temp.get('tempDialog').open, true, 'late temp success cannot close a replacement session for the same ID');
  assert.equal(temp.get('tempIp').value, 'new session value');
}

async function checkCancellation(modules) {
  for (const [dialogId, open, closeIds] of [
    ['deviceDialog', f => f.controller.openDevice('1'), ['closeDialog', 'cancelDialog']],
    ['tempDialog', f => f.controller.openTemp('1'), ['closeTempDialog', 'cancelTempDialog']],
    ['firstPairDialog', f => f.controller.openFirstPair('1'), ['closeFirstPair', 'cancelFirstPair']],
  ]) {
    const f = fixture(modules), dialog = f.get(dialogId);
    for (const button of closeIds) {
      open(f); f.state.isLoading = true;
      await f.get(button).fire('click');
      assert.equal(dialog.open, true, 'pending work blocks close buttons');
      assert.equal(dialog.cancel().defaultPrevented, true, 'pending work blocks native Escape cancellation');
      assert.equal(dialog.open, true);
      f.state.isLoading = false;
      await f.get(button).fire('click');
      assert.equal(dialog.open, false);
    }
    open(f);
    assert.equal(dialog.cancel().defaultPrevented, false);
    assert.equal(dialog.open, false);
    if (dialog.events.has('click')) {
      open(f);
      await dialog.fire('click', {target: f.get('name')});
      assert.equal(dialog.open, true, 'clicking contents is not a backdrop close');
      f.state.isLoading = true; await dialog.fire('click'); assert.equal(dialog.open, true);
      f.state.isLoading = false; await dialog.fire('click'); assert.equal(dialog.open, false);
    }
  }
}

async function checkPairing(modules) {
  for (const kind of ['address', 'device']) {
    const f = fixture(modules);
    fillPair(f, kind);
    if (kind === 'device') {
      assert.equal(f.state.pairingDeviceId, '1');
      assert.equal(f.state.pairingSerial, '10.0.0.1:5555');
      assert.equal(f.get('firstPairIp').value, '10.0.0.1');
      assert.equal(f.get('firstPairPort').focusCount, 1);
      f.get('firstPairIp').value = 'untrusted edited target';
    }
    const event = f.get(kind === 'address' ? 'pair' : 'firstPairForm').dispatch(kind === 'address' ? 'click' : 'submit');
    await event.pending;
    assert.equal(f.requests.length, 1);
    const entry = f.requests[0];
    assert.equal(entry.path, kind === 'address' ? '/api/pair' : '/api/devices/1/pair');
    assert.equal(entry.method, 'POST');
    assert.equal(entry.headers['Content-Type'], 'application/json');
    assert.deepEqual(entry.body, kind === 'address'
      ? {ip: '192.168.99.1', port: 37123, code: '123456'}
      : {port: 37123, code: '123456', selected_serial: '10.0.0.1:5555'});
    assert(entry.signal instanceof AbortSignal);
    assert.equal(f.get(pairField(kind)).value, '');
    assert.equal(f.get(pairMessage(kind)).hidden, false);
    assert.match(f.get(pairMessage(kind)).className, /\bok\b/);
    assert.equal(f.refreshes.length, 0, 'pairing does not silently reload or connect');
    if (kind === 'device') assert.match(f.get(pairMessage(kind)).textContent, /手动点击.*不会自动重试/);
    assert.equal(f.state.isLoading, false);
    assert.equal(f.state.activePairOperation, null);
    assert.equal(f.get('submitFirstPair').disabled, false);
  }
  const fallback = fixture(modules);
  fillPair(fallback, 'address'); fallback.get('pairIp').value = '  '; fallback.get('ip').value = ' 10.8.7.6 ';
  await fallback.controller.pairAddress();
  assert.equal(fallback.requests[0].body.ip, '10.8.7.6', 'generic pairing retains the form-IP fallback');
  const encoded = fixture(modules);
  encoded.state.devices[0].id = 'phone/one';
  encoded.controller.openFirstPair('phone/one');
  await encoded.controller.pairDevice();
  assert.equal(encoded.requests[0].path, '/api/devices/phone%2Fone/pair');
  for (const reason of ['missing', 'connecting', 'projecting', 'route']) {
    const f = fixture(modules); fillPair(f, 'device');
    if (reason === 'missing') f.state.devices = [];
    if (reason === 'connecting') f.connecting.add('1');
    if (reason === 'projecting') f.busy.add('1');
    if (reason === 'route') f.state.devices[0].selected_serial = '192.168.0.1:5555';
    assert.equal(await f.controller.pairDevice(), false, 'pair target must still match on submission: ' + reason);
    assert.equal(f.requests.length, 0);
    assert.equal(f.state.isLoading, false);
    assert.match(f.get('firstPairMessage').className, /error/);
  }
  for (const kind of ['address', 'device']) {
    for (const stage of ['request', 'json', 'render']) {
      const f = fixture(modules); fillPair(f, kind);
      if (stage === 'request') f.behavior.onRequest = () => { throw Error('pair failed'); };
      if (stage === 'json') f.behavior.deferRequests = true;
      if (stage === 'render') {
        let thrown = false;
        f.behavior.onChange = () => { if (!thrown) { thrown = true; throw Error('render failed'); } };
      }
      const run = pairAction(f, kind);
      if (stage === 'json') f.requests[0].pending.resolve({json: async () => { throw Error('bad response'); }});
      assert.equal(await run, false);
      assert.equal(f.state.isLoading, false, 'every current failure releases its own lock');
      assert.equal(f.state.activePairOperation, null);
      assert.equal(f.get('submitFirstPair').disabled, false);
      assert.match(f.get(pairMessage(kind)).className, /error/);
      assert.equal(f.refreshes.length, 0);
    }
  }
}

async function checkPairLifecycle(modules) {
  for (const kind of ['address', 'device']) {
    for (const stage of ['request', 'json']) {
      for (const reject of [false, true]) {
        const f = fixture(modules); fillPair(f, kind); f.behavior.deferRequests = true;
        const oldRun = pairAction(f, kind), old = f.requests[0];
        assert.equal(await pairAction(f, kind), false, 'duplicate clicks cannot start a second request');
        assert.equal(f.requests.length, 1);
        let pending = old.pending;
        if (stage === 'json') {
          pending = deferred(); let reading = false;
          old.pending.resolve({json: () => { reading = true; return pending.promise; }});
          await until(() => reading);
        }
        f.state.generation++; f.controller.invalidate();
        assert.equal(old.signal.aborted, true);
        assert.equal(f.state.activePairOperation, null);
        assert.equal(f.state.isLoading, false);
        fillPair(f, kind, '654321');
        const newRun = pairAction(f, kind), newOperation = f.state.activePairOperation;
        const counts = [f.notices.length, f.changes.length];
        if (reject) pending.reject(Error('old pair failure'));
        else pending.resolve(stage === 'json' ? {message: 'old success'} : {json: async () => ({message: 'old success'})});
        assert.equal(await oldRun, false);
        assert.equal(f.state.activePairOperation, newOperation);
        assert.equal(f.state.isLoading, true, 'stale finally cannot release a replacement pairing lock');
        assert.equal(f.get(pairField(kind)).value, ' 654321 ');
        assert.equal(f.get(pairMessage(kind)).hidden, true);
        assert.deepEqual([f.notices.length, f.changes.length], counts);
        if (kind === 'device') assert.equal(f.get('submitFirstPair').disabled, true);
        f.finish(f.requests[1]);
        assert.equal(await newRun, true);
        assert.equal(f.state.isLoading, false);
        assert.equal(f.requests.length, 2);
      }
    }
  }
  for (const kind of ['address', 'device']) {
    const f = fixture(modules); fillPair(f, kind); f.behavior.deferRequests = true;
    const run = pairAction(f, kind), operation = f.state.activePairOperation;
    const adopted = modules.createDeviceDialogController(f.options);
    assert.equal(f.state.activePairOperation, operation, 'bootstrap construction preserves a pre-existing owner');
    assert.equal(f.state.isLoading, true);
    adopted.invalidate();
    assert.equal(f.requests[0].signal.aborted, true);
    f.finish(f.requests[0]); assert.equal(await run, false);
    f.state.isLoading = true; adopted.invalidate();
    assert.equal(f.state.isLoading, true, 'no pairing operation means another feature owns the lock');
  }
  for (const reason of ['closed', 'reopened', 'missing', 'connecting', 'projecting', 'route']) {
    for (const stage of ['request', 'json']) {
      const f = fixture(modules); fillPair(f, 'device'); f.behavior.deferRequests = true;
      const run = f.controller.pairDevice(), request = f.requests[0];
      let pending = request.pending;
      if (stage === 'json') {
        pending = deferred(); let reading = false;
        request.pending.resolve({json: () => { reading = true; return pending.promise; }});
        await until(() => reading);
      }
      if (reason === 'closed' || reason === 'reopened') {
        f.get('firstPairDialog').close();
        if (reason === 'reopened') {
          f.state.isLoading = false; f.controller.openFirstPair('1'); f.state.isLoading = true;
          f.get('firstPairCode').value = '654321';
        }
      }
      if (reason === 'missing') f.state.devices = [];
      if (reason === 'connecting') f.connecting.add('1');
      if (reason === 'projecting') f.busy.add('1');
      if (reason === 'route') f.state.devices[0].selected_serial = '192.168.0.1:5555';
      pending.resolve(stage === 'json' ? {message: 'late'} : {json: async () => ({message: 'late'})});
      assert.equal(await run, false, 'response must match the current session and target: ' + reason + '/' + stage);
      assert.equal(f.get('firstPairMessage').hidden, true);
      if (reason === 'reopened') assert.equal(f.get('firstPairCode').value, '654321');
      assert.equal(f.state.isLoading, false);
      assert.equal(f.state.activePairOperation, null);
    }
  }
}

function findAll(root, predicate) {
  return [...(predicate(root) ? [root] : []), ...root.children.flatMap(child => findAll(child, predicate))];
}

async function pageFixture(modules, shouldBootstrap = true) {
  const {createDeviceConnectionController} = await import('../web/features/devices/device-connection-controller.js');
  const {createDeviceManagementController} = await import('../web/features/devices/device-management-controller.js');
  const {createGroupDialogController} = await import('../web/features/devices/group-dialog-controller.js');
  const deviceList = await import('../web/features/devices/device-list-model.js');
  const deviceListView = await import('../web/features/devices/device-list-view.js');
  const groupDiscoveryView = await import('../web/features/devices/group-discovery-view.js');
  const source = fs.readFileSync('web/index.html', 'utf8');
  const section = (first, last) => {
    const start = source.indexOf(first), end = source.indexOf(last, start);
    assert(start >= 0 && end > start, 'missing page boundary: ' + first);
    return source.slice(start, end);
  };
  const dom = makeDOM(), get = dom.getElement, documentEvents = new Element('document');
  const server = new Map(makeDevices().map(device => [device.id, {...device}]));
  const groups = new Map(makeGroups().map(group => [group.name, {...group}]));
  const requests = [], messages = [], toasts = [], dismissed = [], busy = new Set();
  const controllers = {}, factoryCounts = {connection: 0, management: 0, configuration: 0, deviceDialog: 0, groupDialog: 0};
  const behavior = {deferRequests: false, deferGets: false, onRequest: null, confirm: true};
  const elem = (tag, className = '', text = '') => new Element(tag, className, text);
  const action = (label, callback, className = 'secondary') => {
    const button = elem('button', className, label); button.addEventListener('click', callback); return button;
  };
  const live = {isBusyFor: id => busy.has(id), updatePicker() {}, closeAll() {}, openSettings() {},
    projectionButton: device => elem('button', 'projector', device.name)};
  const scanResult = {found: 1, updated: ['1'], unmatched: [], busy: [],
    endpoints: [{ip: '192.168.0.1', port: 5555, status: 'updated', device_name: 'Phone 1'}]};
  const response = (entry, updateServer = true) => {
    if (entry.method === 'GET') return {json: async () => entry.path === '/api/groups' ? [...groups.values()] : [...server.values()]};
    if (entry.path === '/api/pair' || entry.path.endsWith('/pair')) return {json: async () => ({message: '已配对'})};
    if (/\/discovery\/(test|scan)$/.test(entry.path)) return {json: async () => scanResult};
    if (entry.path.startsWith('/api/groups')) {
      if (entry.path.endsWith('/discovery')) {
        if (updateServer && groups.has(entry.entityId)) {
          const group = groups.get(entry.entityId);
          group.discovery_configured = entry.method !== 'DELETE';
          if (entry.body) { group.discovery_url = entry.body.url; group.discovery_username = entry.body.username; }
        }
        return {json: async () => ({ok: true})};
      }
      if (entry.method === 'DELETE') {
        const moved = [...server.values()].filter(device => device.group_name === entry.entityId);
        if (updateServer) {
          groups.delete(entry.entityId);
          for (const device of moved) server.set(device.id, {...device, group_name: ''});
        }
        return {json: async () => ({moved_count: moved.length})};
      }
      const saved = {...groups.get(entry.entityId), ...entry.body};
      if (updateServer) { groups.delete(entry.entityId); groups.set(saved.name, saved); }
      return {json: async () => saved};
    }
    let device = {...server.get(entry.entityId)};
    if (entry.path === '/api/devices') device = {...makeDevices()[0], ...entry.body, id: 'new', mesh_ip: entry.body.ip};
    else if (entry.path.endsWith('/temp-address')) device = {...device, temp_ip: entry.body.ip, port: entry.body.port};
    else device = {...device, ...entry.body, mesh_ip: entry.body.ip};
    if (updateServer) server.set(device.id, device);
    return {json: async () => device};
  };
  const api = async (path, options = {}) => {
    const entry = {path, entityId: decodeURIComponent(path.split('/')[3] || ''),
      method: options.method || 'GET', body: options.body && JSON.parse(options.body),
      signal: options.signal, token: get('token').value, pending: deferred()};
    requests.push(entry);
    if (behavior.onRequest) {
      const overridden = await behavior.onRequest(entry);
      if (overridden !== undefined) return overridden;
    }
    if (entry.method === 'GET' ? behavior.deferGets : behavior.deferRequests) return entry.pending.promise;
    return response(entry);
  };
  const sandbox = {
    AbortController, api, elem, action, LIVE: live, document: {
      getElementById: get, createElement: dom.createElement,
      addEventListener: (name, callback) => documentEvents.addEventListener(name, callback),
    },
    confirm: () => behavior.confirm,
    message: (text, kind = '') => messages.push({text, kind}),
    showToast: (content, options) => toasts.push({content, ...options}),
    dismissToast: key => dismissed.push(key),
    hasConnectedAdb: deviceList.hasConnectedAdb,
    connectedFirst: (left, right) => Number(deviceList.hasConnectedAdb(right)) - Number(deviceList.hasConnectedAdb(left)),
  };
  const setup = section('const $=id=>', 'const inventoryDrawer=') + '\nconst toastItems=new Map();\n' +
    section('let frontendModules=', 'function toastSelected(') +
    section("document.addEventListener('easyadb:frontend-modules-ready'", '// Browser requests') +
    section('function buildLegacyDeviceGroups()', '// Each connect uses') +
    section("$('token').addEventListener('input'", "$('bulkSelectAll').addEventListener") +
    section("$('newDevice').addEventListener", "$('refreshAll').addEventListener") +
    section("$('pair').addEventListener", 'multiView=EasyADBMulti.create') + `
multiView=LIVE;
globalThis.readState=()=>({devices,groups,selected,editing,editingTemp,editingGroup,pairingDeviceId,pairingSerial,
 loaded,loading,connectGeneration,managementSelected,connectingDevices,connectionBatchBusy,configurationOperation,
 pairingOperation,groupOperation,scanningGroups,groupScanOperations,groupHasSavedDiscovery,
 deviceDialogRevision,tempDialogRevision,firstPairDialogRevision,groupDialogRevision});
globalThis.installRows=(rows,configs)=>{devices=rows;groups=configs;loaded=true;render();};
globalThis.openDevice=id=>openModal(id);
globalThis.openTemp=id=>openTempEditor(devices.find(device=>device.id===id));
globalThis.openPair=id=>openFirstPair(id);
globalThis.openGroupEditor=name=>openGroup(name);
globalThis.runScan=(name,isTest=false)=>scanGroup(name,isTest);
`;
  get('token').value = 'current-token';
  vm.runInContext(setup, vm.createContext(sandbox), {filename: 'device-dialog-page.js'});
  const installRows = () => sandbox.installRows(makeDevices(), makeGroups());
  installRows();
  const recordFactory = (name, factory) => options => {
    factoryCounts[name]++; controllers[name] = factory(options); return controllers[name];
  };
  const detail = {
    deviceList, deviceListView, groupDiscoveryView,
    dialog: modules.createDialogController({getElement: get}),
    createDeviceConnectionController: recordFactory('connection', createDeviceConnectionController),
    createDeviceManagementController: recordFactory('management', createDeviceManagementController),
    createDeviceConfigurationController: recordFactory('configuration', modules.createDeviceConfigurationController),
    createDeviceDialogController: recordFactory('deviceDialog', modules.createDeviceDialogController),
    createGroupDialogController: recordFactory('groupDialog', createGroupDialogController),
  };
  const bootstrap = () => documentEvents.fire('easyadb:frontend-modules-ready', {detail});
  if (shouldBootstrap) { await bootstrap(); await bootstrap(); }
  return { ...dom, get, sandbox, installRows, requests, messages, toasts, dismissed, busy, server, groups,
    behavior, controllers, factoryCounts, bootstrap, response,
    finish(entry) { entry.pending.resolve(response(entry)); }};
}

function openPagePair(f, kind, code = '123456') {
  if (kind === 'address') {
    f.sandbox.openDevice('1');
    f.get('pairIp').value = ' 192.168.99.1 ';
    f.get('pairPort').value = '37123'; f.get('pairCode').value = code;
  } else {
    f.sandbox.openPair('1');
    f.get('firstPairPort').value = '37123'; f.get('firstPairCode').value = code;
  }
}
const pagePairAction = (f, kind) => f.get(kind === 'address' ? 'pair' : 'firstPairForm')
  .fire(kind === 'address' ? 'click' : 'submit');

async function checkPageWiring(modules) {
  const main = fs.readFileSync('web/app/main.js', 'utf8');
  assert(main.includes("from '../features/devices/device-dialog-controller.js'"));
  const f = await pageFixture(modules), state = () => f.sandbox.readState();
  assert.deepEqual(f.factoryCounts, {connection: 1, management: 1, configuration: 1, deviceDialog: 1, groupDialog: 1});
  assert.equal(f.requests.length, 0, 'all real page factories install without requests');
  assert.equal(f.controllers.deviceDialog.state.devices, state().devices);
  assert.equal(f.controllers.deviceDialog.state.devices, f.controllers.configuration.state.devices);
  assert.equal(f.controllers.deviceDialog.state.groups, f.controllers.groupDialog.state.groups);
  for (const [id, event] of [['newDevice', 'click'], ['form', 'submit'], ['tempForm', 'submit'],
    ['firstPairForm', 'submit'], ['pair', 'click'], ['groupForm', 'submit'], ['deleteGroup', 'click']]) {
    assert.equal(f.get(id).events.get(event).length, 2, 'fixture executes both retained classic and module listeners');
  }
  f.controllers.deviceDialog.bindEvents(); f.controllers.groupDialog.bindEvents();
  assert.equal(f.get('form').events.get('submit').length, 2);
  const beforeReset = f.get('form').resetCount;
  await f.get('newDevice').fire('click');
  assert.equal(f.get('form').resetCount, beforeReset + 1, 'classic listener must not forward into the module twice');
  assert.equal(f.get('name').focusCount, 1);
  f.get('name').value = 'New from page'; f.get('ip').value = ' 10.9.8.7 '; f.get('port').value = '6000';
  await f.get('form').fire('submit');
  assert.deepEqual(f.requests.map(entry => [entry.path, entry.method]),
    [['/api/devices', 'POST'], ['/api/devices', 'GET'], ['/api/groups', 'GET']]);
  assert.equal(f.get('deviceDialog').open, false);
  assert.equal(state().selected, 'new');
  const revision = state().deviceDialogRevision;
  const editButton = findAll(f.get('devices'), node => node.attrs['aria-label'] === '编辑设备 Phone 1')[0];
  assert(editButton, 'real device-list view exposes the editor callback');
  await editButton.fire('click');
  assert.equal(state().editing, '1');
  assert.equal(state().deviceDialogRevision, revision + 1);
  const beforeEdit = f.requests.length;
  f.get('name').value = 'Renamed'; await f.get('form').fire('submit');
  assert.equal(f.requests[beforeEdit].path, '/api/devices/1');
  assert.equal(f.requests[beforeEdit].method, 'PUT');
  assert.equal(f.requests.length, beforeEdit + 3, 'editing delegates once to D3 and its metadata refresh');
  const tempButton = findAll(f.get('devices'), node => node.className === 'address-add')[0];
  await tempButton.fire('click');
  assert.equal(f.get('tempDialog').open, true);
  assert.equal(f.get('tempIp').focusCount, 1);
  f.get('tempIp').value = ' 10.9.8.6 '; f.get('tempSharedPort').value = '6555';
  const beforeTemp = f.requests.length;
  await f.get('tempForm').fire('submit');
  assert.equal(f.requests[beforeTemp].path, '/api/devices/1/temp-address');
  assert.deepEqual(f.requests[beforeTemp].body, {ip: '10.9.8.6', port: 6555});
  assert.equal(f.requests.length, beforeTemp + 3);
  assert.equal(f.get('tempDialog').open, false);
  const pairButton = findAll(f.get('devices'), node => node.className === 'first-pair')[0];
  await pairButton.fire('click');
  assert.equal(state().pairingDeviceId, '1');
  assert.equal(f.get('firstPairPort').focusCount, 1);
  f.get('firstPairPort').value = '37123'; f.get('firstPairCode').value = '123456';
  const beforePair = f.requests.length;
  await f.get('firstPairForm').fire('submit');
  assert.equal(f.requests.length, beforePair + 1, 'two registered listeners issue one scoped pair request');
  assert.equal(f.requests[beforePair].path, '/api/devices/1/pair');
  await f.get('closeFirstPair').fire('click');
  assert.equal(state().pairingDeviceId, null);
  const beforeRaw = f.requests.length;
  openPagePair(f, 'address'); await pagePairAction(f, 'address');
  assert.equal(f.requests.length, beforeRaw + 1);
  assert.equal(f.requests[beforeRaw].path, '/api/pair');
  assert(f.requests.every(entry => !entry.path.endsWith('/connect')), 'dialog work retains explicit connection semantics');
  await f.get('cancelDialog').fire('click');
  assert.equal(state().editing, null);
  assert.equal(state().loading, false);

  f.sandbox.openGroupEditor('Home');
  assert.equal(f.get('groupName').focusCount, 1);
  f.get('groupOpenWrtUrl').value = ' http://draft-router/ubus ';
  f.get('groupOpenWrtUser').value = '  '; f.get('groupOpenWrtPassword').value = 'draft-secret';
  const beforeTest = f.requests.length;
  await f.get('testGroupDiscovery').fire('click');
  assert.equal(f.requests.length, beforeTest + 1);
  assert.deepEqual(f.requests[beforeTest].body, {url: 'http://draft-router/ubus', username: 'easyadb', password: 'draft-secret'});
  assert.match(f.get('groupMessage').textContent, /不会更新设备端口/);
  const beforeGroup = f.requests.length;
  await f.get('groupForm').fire('submit');
  assert.deepEqual(f.requests.slice(beforeGroup).map(entry => [entry.path, entry.method]), [
    ['/api/groups/Home', 'PUT'], ['/api/groups/Home/discovery', 'PUT'], ['/api/devices', 'GET'], ['/api/groups', 'GET'],
  ]);
  assert.equal(f.get('groupDialog').open, false);
  assert.equal(f.get('groupOpenWrtPassword').value, '');
  const beforeScan = f.requests.length;
  await f.sandbox.runScan('Home');
  assert.deepEqual(f.requests.slice(beforeScan).map(entry => [entry.path, entry.method]), [
    ['/api/groups/Home/discovery/scan', 'POST'], ['/api/devices', 'GET'], ['/api/groups', 'GET'],
  ]);
  assert.equal(f.toasts.at(-1).key, 'discovery:Home');
  assert.equal(f.toasts.at(-1).kind, 'ok');
  assert(findAll(f.toasts.at(-1).content, node => node.textContent === '192.168.0.1:5555').length);
}

async function checkPagePairAdoption(modules) {
  for (const startWithModules of [false, true]) {
    for (const kind of ['address', 'device']) {
      for (const stage of ['request', 'json']) {
        for (const reject of [false, true]) {
          const f = await pageFixture(modules, startWithModules);
          f.behavior.deferRequests = true; openPagePair(f, kind);
          const oldRun = pagePairAction(f, kind), old = f.requests[0];
          const owner = f.sandbox.readState().pairingOperation;
          assert(owner, 'the current pairing implementation establishes shared ownership');
          let pending = old.pending;
          if (stage === 'json') {
            pending = deferred(); let reading = false;
            old.pending.resolve({json: () => { reading = true; return pending.promise; }});
            await until(() => reading);
          }
          await f.bootstrap(); await f.bootstrap();
          assert.equal(f.controllers.deviceDialog.state.activePairOperation, owner);
          assert.equal(f.factoryCounts.deviceDialog, 1);
          f.get('token').value = 'replacement-token'; await f.get('token').fire('input');
          assert.equal(old.signal.aborted, true);
          assert.equal(f.sandbox.readState().loading, false);
          assert.equal(f.sandbox.readState().devices.length, 0);
          f.installRows(); openPagePair(f, kind, '654321');
          const newRun = pagePairAction(f, kind), newOwner = f.sandbox.readState().pairingOperation;
          const snapshot = [f.messages.length, f.toasts.length, f.get('deviceDialog').closeCount, f.get('firstPairDialog').closeCount];
          if (reject) pending.reject(Error('stale pair error'));
          else pending.resolve(stage === 'json' ? {message: 'stale pair success'} : {json: async () => ({message: 'stale pair success'})});
          await oldRun;
          assert.equal(f.sandbox.readState().pairingOperation, newOwner);
          assert.equal(f.sandbox.readState().loading, true);
          assert.equal(f.get(pairField(kind)).value, '654321');
          assert.equal(f.get(pairMessage(kind)).hidden, true);
          if (kind === 'device') assert.equal(f.get('submitFirstPair').disabled, true);
          assert.deepEqual([f.messages.length, f.toasts.length, f.get('deviceDialog').closeCount, f.get('firstPairDialog').closeCount], snapshot);
          assert.equal(f.requests.length, 2, 'stale pairing cannot issue requests or duplicate the newly bound handler');
          assert.equal(f.requests[1].token, 'replacement-token');
          f.finish(f.requests[1]); await newRun;
          assert.equal(f.sandbox.readState().loading, false);
          assert.equal(f.sandbox.readState().pairingOperation, null);
        }
      }
    }
  }
}

async function checkPageConfigurationAdoption(modules) {
  for (const kind of ['device', 'temp']) {
    for (const stage of ['request', ...(kind === 'device' ? ['json'] : []), 'refresh']) {
      for (const reject of [false, true]) {
        const f = await pageFixture(modules, false), form = kind === 'device' ? 'form' : 'tempForm';
        const open = () => kind === 'device' ? f.sandbox.openDevice('1') : f.sandbox.openTemp('1');
        f.behavior.deferRequests = true; f.behavior.deferGets = stage === 'refresh'; open();
        const oldRun = f.get(form).fire('submit'), old = f.requests[0], owner = f.sandbox.readState().configurationOperation;
        assert(owner);
        let pending = old.pending, oldGets = [];
        if (stage === 'json') {
          pending = deferred(); let reading = false;
          old.pending.resolve({json: () => { reading = true; return pending.promise; }});
          await until(() => reading);
        } else if (stage === 'refresh') {
          f.finish(old);
          await until(() => f.requests.filter(entry => entry.method === 'GET').length === 2);
          oldGets = f.requests.filter(entry => entry.method === 'GET');
        }
        await f.bootstrap();
        assert.equal(f.controllers.configuration.state.activeOperation, owner);
        f.get('token').value = 'replacement-token'; await f.get('token').fire('input');
        assert.equal(old.signal.aborted, true);
        f.installRows(); open(); f.behavior.deferGets = false;
        const start = f.requests.length;
        const newRun = f.get(form).fire('submit'), newOwner = f.sandbox.readState().configurationOperation;
        const snapshot = [f.messages.length, f.get('deviceDialog').closeCount, f.get('tempDialog').closeCount];
        if (stage === 'refresh') {
          for (const entry of oldGets) {
            if (reject) entry.pending.reject(Error('stale saved metadata error'));
            else entry.pending.resolve({json: async () => entry.path === '/api/groups' ? [{name: 'stale'}] : []});
          }
        } else if (reject) pending.reject(Error('stale save error'));
        else pending.resolve(stage === 'json' ? {...makeDevices()[0], name: 'stale saved'} : f.response(old, false));
        await oldRun;
        assert.equal(f.sandbox.readState().configurationOperation, newOwner);
        assert.equal(f.sandbox.readState().loading, true);
        assert.deepEqual([f.messages.length, f.get('deviceDialog').closeCount, f.get('tempDialog').closeCount], snapshot,
          'retained classic callbacks cannot close a new module-owned editor after token change');
        assert.equal(f.requests.length, start + 1);
        f.finish(f.requests[start]); await newRun;
        assert.equal(f.requests.length, start + 3, 'only the current save refreshes device and group metadata');
        assert.equal(f.sandbox.readState().loading, false);
        assert.equal(f.get(kind === 'device' ? 'deviceDialog' : 'tempDialog').open, false);
      }
    }
  }
}

function startGroupAction(f, kind) {
  if (kind === 'save') return f.get('groupForm').fire('submit');
  if (kind === 'delete') return f.get('deleteGroup').fire('click');
  return f.sandbox.runScan('Home', kind === 'test');
}

async function checkPageGroupAdoption(modules) {
  for (const kind of ['save', 'delete', 'scan', 'test']) {
    for (const stage of ['request', 'json', ...(kind === 'test' ? [] : ['refresh'])]) {
      for (const reject of [false, true]) {
        const f = await pageFixture(modules, false);
        f.behavior.deferRequests = true; f.behavior.deferGets = stage === 'refresh';
        f.sandbox.openGroupEditor('Home'); f.get('groupOpenWrtPassword').value = 'old-secret';
        const oldRun = startGroupAction(f, kind), old = f.requests[0];
        const oldState = f.sandbox.readState();
        const oldOwner = kind === 'save' || kind === 'delete' ? oldState.groupOperation : oldState.groupScanOperations.get('Home');
        assert(oldOwner, 'classic group work owns its shared operation: ' + kind);
        let pending = old.pending, oldGets = [];
        if (stage === 'json') {
          pending = deferred(); let reading = false;
          old.pending.resolve({json: () => { reading = true; return pending.promise; }});
          await until(() => reading);
        } else if (stage === 'refresh') {
          f.finish(old);
          if (kind === 'save') {
            await until(() => f.requests.some(entry => entry.path.endsWith('/discovery')));
            f.finish(f.requests.find(entry => entry.path.endsWith('/discovery')));
          }
          await until(() => f.requests.filter(entry => entry.method === 'GET').length === 2);
          oldGets = f.requests.filter(entry => entry.method === 'GET');
        }
        await f.bootstrap();
        const moduleState = f.controllers.groupDialog.state;
        assert.equal(kind === 'save' || kind === 'delete' ? moduleState.activeOperation : moduleState.scanOperations.get('Home'), oldOwner);
        f.get('token').value = 'replacement-token'; await f.get('token').fire('input');
        assert.equal(old.signal.aborted, true);
        assert.equal(f.sandbox.readState().loading, false);
        assert.equal(f.sandbox.readState().scanningGroups.size, 0);
        f.installRows(); f.sandbox.openGroupEditor('Home'); f.get('groupOpenWrtPassword').value = 'new-secret';
        f.behavior.deferGets = false;
        const start = f.requests.length, newRun = startGroupAction(f, kind), newRequest = f.requests[start];
        assert(newRequest);
        const state = f.sandbox.readState();
        const newOwner = kind === 'save' || kind === 'delete' ? state.groupOperation : state.groupScanOperations.get('Home');
        const snapshot = [f.messages.length, f.toasts.length, f.dismissed.length, f.get('groupDialog').closeCount];
        if (stage === 'refresh') {
          for (const entry of oldGets) {
            if (reject) entry.pending.reject(Error('old metadata failure'));
            else entry.pending.resolve({json: async () => entry.path === '/api/groups' ? [{name: 'stale'}] : []});
          }
        } else if (reject) pending.reject(Error('stale group error'));
        else pending.resolve(stage === 'json' ? await f.response(old, false).json() : f.response(old, false));
        await oldRun;
        const after = f.sandbox.readState();
        assert.equal(kind === 'save' || kind === 'delete' ? after.groupOperation : after.groupScanOperations.get('Home'), newOwner,
          'old group finally must preserve the replacement owner: ' + kind + '/' + stage);
        assert.equal(after.loading, kind === 'save' || kind === 'delete');
        if (kind === 'scan' || kind === 'test') assert.equal(after.scanningGroups.has('Home'), true);
        if (kind === 'test') assert.equal(f.get('testGroupDiscovery').disabled, true);
        assert.equal(after.editingGroup, 'Home');
        assert.equal(after.devices.length, 2, 'old metadata cannot replace the new token inventory');
        assert.equal(f.get('groupOpenWrtPassword').value, 'new-secret');
        assert.equal(f.get('groupMessage').hidden, true);
        assert.deepEqual([f.messages.length, f.toasts.length, f.dismissed.length, f.get('groupDialog').closeCount], snapshot);
        assert.equal(f.requests.length, start + 1, 'old group work cannot continue discovery persistence or metadata reads');
        f.behavior.deferRequests = false;
        f.finish(newRequest); await newRun;
        assert.equal(f.sandbox.readState().loading, false);
        assert.equal(f.sandbox.readState().groupOperation, null);
        assert.equal(f.sandbox.readState().scanningGroups.size, 0);
        assert.equal(f.get('testGroupDiscovery').disabled, false);
      }
    }
  }
}

async function checkPageDiscoveryRetry(modules) {
  const f = await pageFixture(modules, false);
  f.sandbox.openGroupEditor('Home');
  f.get('groupName').value = 'Renamed'; f.get('groupOpenWrtUrl').value = '';
  let failOnce = true;
  f.behavior.onRequest = entry => {
    if (entry.method === 'DELETE' && entry.path.endsWith('/discovery') && failOnce) {
      failOnce = false; throw Error('discovery deletion unavailable');
    }
  };
  await f.get('groupForm').fire('submit');
  assert.equal(f.sandbox.readState().editingGroup, 'Renamed');
  assert.equal(f.sandbox.readState().groupHasSavedDiscovery, true);
  assert.equal(f.sandbox.readState().groups.some(group => group.name === 'Renamed'), false,
    'saved group metadata is deliberately stale after partial persistence');
  assert.equal(f.get('groupDialog').open, true);
  await f.bootstrap();
  assert.equal(f.controllers.groupDialog.state.hasSavedDiscovery, true);
  await f.get('groupForm').fire('submit');
  assert.deepEqual(f.requests.map(entry => [entry.path, entry.method]), [
    ['/api/groups/Home', 'PUT'], ['/api/groups/Renamed/discovery', 'DELETE'],
    ['/api/groups/Renamed', 'PUT'], ['/api/groups/Renamed/discovery', 'DELETE'],
    ['/api/devices', 'GET'], ['/api/groups', 'GET'],
  ], 'bootstrap preserves a partially saved rename and its pending discovery deletion');
  assert.equal(f.get('groupDialog').open, false);
  assert.equal(f.sandbox.readState().loading, false);
}

(async () => {
  const modules = {
    ...await import('../web/features/devices/device-dialog-controller.js'),
    ...await import('../web/features/devices/device-configuration-controller.js'),
    ...await import('../web/shared/ui/dialog.js'),
  };
  assertMarkup();
  await checkDialogForms(modules);
  await checkGuardsAndFailures(modules);
  await checkCancellation(modules);
  await checkPairing(modules);
  await checkPairLifecycle(modules);
  await checkPageWiring(modules);
  await checkPagePairAdoption(modules);
  await checkPageConfigurationAdoption(modules);
  await checkPageGroupAdoption(modules);
  await checkPageDiscoveryRetry(modules);
  console.log('E device dialogs: forms, D3 delegation, pairing, group adoption and real page lifecycle: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
