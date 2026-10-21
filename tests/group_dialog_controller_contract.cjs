'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

class Element {
  constructor(tag = 'div', className = '', text) {
    this.tagName = tag;
    this.className = className;
    this.textContent = text === undefined ? '' : text;
    this.value = '';
    this.open = false;
    this.hidden = false;
    this.disabled = false;
    this.children = [];
    this.listeners = new Map();
  }
  append(...children) {
    this.children.push(...children);
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  dispatch(type, event = {}) {
    const prepared = {
      target: this,
      prevented: false,
      preventDefault() {
        this.prevented = true;
      },
      ...event,
    };
    const results = (this.listeners.get(type) || []).map((handler) => handler(prepared));
    return { event: prepared, results };
  }
  async fire(type, event) {
    const result = this.dispatch(type, event);
    await Promise.all(result.results);
    return result.event;
  }
}

function fixture(createController, initial = {}) {
  const elements = new Map();
  const getElement = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const state = {
    devices: [{ id: 'one', name: 'Phone', group_name: 'Home' }],
    groups: [
      {
        name: 'Home',
        ip_prefix: '192.168.10.*',
        discovery_configured: true,
        discovery_url: 'http://router/ubus',
        discovery_username: 'saved-user',
      },
      { name: 'Work', ip_prefix: null, discovery_configured: false },
    ],
    editingGroupName: null,
    isLoaded: true,
    isLoading: false,
    generation: 0,
    activeOperation: null,
    dialogRevision: 0,
    hasSavedDiscovery: false,
    scanningGroupNames: new Set(),
    scanOperations: new Map(),
    groupOpen: new Map([['named:Home', true]]),
    ...initial,
  };
  const record = {
    requests: [],
    messages: [],
    modalMessages: [],
    dismissed: [],
    results: [],
    errors: [],
    confirmations: [],
    focused: [],
    refreshes: 0,
    renders: 0,
  };
  const busy = new Set();
  const connecting = new Set();
  let requestHandler = async (requestPath, options) => ({
    json: async () => {
      if (requestPath.includes('/discovery/')) return { found: 2, endpoints: [] };
      if (options.method === 'DELETE') return { deleted: true, moved_count: 1 };
      return { name: JSON.parse(options.body).name };
    },
  });
  let refreshHandler = async () => true;
  let renderHandler = () => {};
  let confirmHandler = () => true;
  getElement('groupForm').reset = () => {
    for (const id of [
      'groupName',
      'groupPrefix',
      'groupOpenWrtUrl',
      'groupOpenWrtUser',
      'groupOpenWrtPassword',
    ])
      getElement(id).value = '';
  };
  getElement('groupForm').reportValidity = () => true;
  const options = {
    state,
    getElement,
    dialog: {
      showDialog(id, focusId) {
        getElement(id).open = true;
        record.focused.push(focusId);
      },
      closeDialog(id) {
        getElement(id).open = false;
        getElement(id).dispatch('close');
      },
      modalMessage(text, kind, id) {
        record.modalMessages.push({ text, kind, id });
        getElement(id).textContent = text;
        getElement(id).hidden = false;
      },
    },
    request(requestPath, requestOptions) {
      record.requests.push({ path: requestPath, options: requestOptions });
      return requestHandler(requestPath, requestOptions);
    },
    async refreshDevices() {
      record.refreshes++;
      return refreshHandler();
    },
    isDeviceBusy: (id) => busy.has(id),
    isDeviceConnecting: (id) => connecting.has(id),
    confirmDelete(text) {
      record.confirmations.push(text);
      return confirmHandler(text);
    },
    onChange() {
      record.renders++;
      renderHandler();
    },
    notify: (text, kind) => record.messages.push({ text, kind }),
    dismissToast: (key) => record.dismissed.push(key),
    showScanResult: (name, result) => record.results.push({ name, result }),
    showScanError: (name, text) => record.errors.push({ name, text }),
  };
  const controller = createController(options);
  return {
    state,
    record,
    elements,
    getElement,
    options,
    controller,
    busy,
    connecting,
    setRequest: (handler) => (requestHandler = handler),
    setRefresh: (handler) => (refreshHandler = handler),
    setRender: (handler) => (renderHandler = handler),
    setConfirm: (handler) => (confirmHandler = handler),
    setFields(fields) {
      for (const [id, value] of Object.entries(fields)) getElement(id).value = value;
    },
  };
}

function routeSummary(record) {
  return record.requests.map(({ path: requestPath, options }) => [requestPath, options.method]);
}

(async () => {
  const { createGroupDialogController } = await import(
    pathToFileURL(path.resolve('web/features/devices/group-dialog-controller.js')).href
  );
  const { renderDiscoveryResult } = await import(
    pathToFileURL(path.resolve('web/features/devices/group-discovery-view.js')).href
  );

  // Constructor and binding preserve shared owners and never perform I/O.
  {
    const owner = { generation: 3, abortController: new AbortController() };
    const scan = {
      generation: 3,
      abortController: new AbortController(),
      groupName: 'Home',
      isTest: false,
    };
    const scans = new Map([['Home', scan]]);
    const names = new Set(['Home']);
    const f = fixture(createGroupDialogController, {
      activeOperation: owner,
      scanOperations: scans,
      scanningGroupNames: names,
      dialogRevision: 4,
      hasSavedDiscovery: true,
    });
    assert.equal(f.controller.state, f.state);
    assert.equal(f.state.activeOperation, owner);
    assert.equal(f.state.scanOperations, scans);
    assert.equal(f.state.scanningGroupNames, names);
    assert.equal(f.state.dialogRevision, 4);
    assert.equal(f.state.hasSavedDiscovery, true);
    f.controller.bindEvents();
    f.controller.bindEvents();
    assert.equal(f.record.requests.length, 0);
    assert.equal(f.record.refreshes, 0);
    for (const element of f.elements.values()) {
      for (const listeners of element.listeners.values()) assert.equal(listeners.length, 1);
    }
  }

  // Real handlers retain dialog focus, validation, cancellation and close state.
  {
    const f = fixture(createGroupDialogController);
    f.controller.bindEvents();
    await f.getElement('newGroup').fire('click');
    assert.equal(f.getElement('groupDialog').open, true);
    assert.equal(f.state.editingGroupName, null);
    assert.equal(f.getElement('deleteGroup').hidden, true);
    assert.equal(f.getElement('testGroupDiscovery').hidden, true);
    assert.equal(f.getElement('groupOpenWrtUser').value, 'easyadb');
    assert.deepEqual(f.record.focused, ['groupName']);
    assert.equal(f.record.requests.length, 0, 'opening is not a scan or load');
    f.getElement('groupForm').reportValidity = () => false;
    const submitted = await f.getElement('groupForm').fire('submit');
    assert.equal(submitted.prevented, true);
    assert.equal(f.record.requests.length, 0);
    await f.getElement('cancelGroup').fire('click');
    assert.equal(f.getElement('groupDialog').open, false);
    f.controller.openGroup('Home');
    assert.equal(f.getElement('groupName').value, 'Home');
    assert.equal(f.getElement('groupPrefix').value, '192.168.10.*');
    assert.equal(f.state.hasSavedDiscovery, true);
    f.state.scanningGroupNames.add('Home');
    assert.equal((await f.getElement('groupDialog').fire('cancel')).prevented, true);
    await f.getElement('closeGroup').fire('click');
    assert.equal(f.getElement('groupDialog').open, true);
    f.state.scanningGroupNames.clear();
    await f.getElement('groupDialog').fire('click', { target: new Element() });
    assert.equal(f.getElement('groupDialog').open, true);
    await f.getElement('groupDialog').fire('click');
    assert.equal(f.getElement('groupDialog').open, false);
    assert.equal(f.state.editingGroupName, null);
    assert.equal(f.state.hasSavedDiscovery, false);
    f.connecting.add('one');
    assert.equal(f.controller.openGroup('Home'), false);
    assert.equal(f.controller.openGroup(), true, 'busy members do not block a new group');
    f.state.isLoading = true;
    assert.equal((await f.getElement('groupDialog').fire('cancel')).prevented, true);
  }

  // Save snapshots the whole form, retains exact wire fields, and releases after close.
  {
    const f = fixture(createGroupDialogController);
    f.controller.bindEvents();
    f.controller.openGroup();
    f.setFields({
      groupName: '新组 / 一',
      groupPrefix: ' 192.168.20.* ',
      groupOpenWrtUrl: ' http://router/ubus ',
      groupOpenWrtUser: ' ',
      groupOpenWrtPassword: ' secret with spaces ',
    });
    const first = deferred();
    f.setRequest((requestPath) =>
      requestPath === '/api/groups' ? first.promise : Promise.resolve({}),
    );
    const save = f.getElement('groupForm').fire('submit');
    assert.equal(f.state.isLoading, true);
    const owner = f.state.activeOperation;
    f.setFields({ groupOpenWrtUrl: 'http://other/ubus', groupOpenWrtPassword: 'changed' });
    first.resolve({ json: async () => ({ name: '新组 / 一' }) });
    await save;
    assert.deepEqual(routeSummary(f.record), [
      ['/api/groups', 'POST'],
      ['/api/groups/' + encodeURIComponent('新组 / 一') + '/discovery', 'PUT'],
    ]);
    assert.deepEqual(JSON.parse(f.record.requests[0].options.body), {
      name: '新组 / 一',
      ip_prefix: '192.168.20.*',
    });
    assert.deepEqual(JSON.parse(f.record.requests[1].options.body), {
      url: 'http://router/ubus',
      username: 'easyadb',
      password: ' secret with spaces ',
    });
    assert.equal(f.record.requests[1].options.signal, owner.abortController.signal);
    assert.equal(f.getElement('groupOpenWrtPassword').value, '');
    assert.equal(f.getElement('groupDialog').open, false);
    assert.equal(
      f.state.editingGroupName,
      null,
      'close event clears the form, not request ownership',
    );
    assert.equal(f.state.isLoading, false);
    assert.equal(f.state.activeOperation, null);
    assert.equal(f.record.refreshes, 1);
    assert.equal(f.record.messages[0].text, '分组设置已保存');
  }

  // A failed discovery step never repeats POST; rename retry retains removal state
  // even though the shared metadata still contains only the previous group name.
  for (const creating of [true, false]) {
    const f = fixture(createGroupDialogController);
    f.controller.bindEvents();
    f.controller.openGroup(creating ? null : 'Home');
    f.setFields({
      groupName: 'Office',
      groupOpenWrtUrl: creating ? 'http://router/ubus' : '',
      groupOpenWrtPassword: 'keep-on-failure',
    });
    let shouldFail = true;
    f.setRequest(async (requestPath) => {
      if (requestPath.endsWith('/discovery')) {
        if (shouldFail) throw Error('discovery failed');
        return {};
      }
      return { json: async () => ({ name: 'Office' }) };
    });
    assert.equal(await f.controller.saveGroup(), false);
    assert.equal(f.state.editingGroupName, 'Office');
    assert.equal(f.state.hasSavedDiscovery, !creating);
    assert.equal(f.getElement('groupOpenWrtPassword').value, 'keep-on-failure');
    assert.equal(f.getElement('groupDialog').open, true);
    assert.equal(f.state.isLoading, false);
    assert.equal(f.record.refreshes, 0);
    // Emulate module bootstrap after the partial request: all state is inherited.
    const replacement = createGroupDialogController(f.options);
    shouldFail = false;
    assert.equal(await replacement.saveGroup(), true);
    assert.deepEqual(routeSummary(f.record), [
      [creating ? '/api/groups' : '/api/groups/Home', creating ? 'POST' : 'PUT'],
      ['/api/groups/Office/discovery', creating ? 'PUT' : 'DELETE'],
      ['/api/groups/Office', 'PUT'],
      ['/api/groups/Office/discovery', creating ? 'PUT' : 'DELETE'],
    ]);
    assert.equal(f.record.refreshes, 1);
    assert.equal(f.state.isLoading, false);
  }

  // Refresh failure preserves the successful mutation and unlocks even after close.
  for (const action of ['saveGroup', 'deleteGroup']) {
    for (const shouldThrow of [false, true]) {
      const f = fixture(createGroupDialogController);
      f.controller.bindEvents();
      f.controller.openGroup(action === 'saveGroup' ? null : 'Home');
      f.setFields({ groupName: 'Empty' });
      f.setRefresh(async () => {
        if (shouldThrow) throw Error('metadata offline');
        return false;
      });
      assert.equal(await f.controller[action](), true);
      assert.equal(f.state.activeOperation, null);
      assert.equal(f.state.isLoading, false);
      assert.equal(f.getElement('groupDialog').open, false);
      assert.equal(f.record.refreshes, 1);
      assert.match(f.record.messages.at(-1).text, /列表刷新失败/);
      assert.equal(f.record.messages.at(-1).kind, 'error');
      assert.equal(f.record.modalMessages.length, 0);
      if (action === 'deleteGroup') {
        assert.equal(f.state.groupOpen.has('named:Home'), false);
        assert.deepEqual(f.record.dismissed, ['discovery:Home']);
      }
    }
  }

  // Delete cancellation and changes inside the confirmation never issue DELETE.
  for (const mutation of ['cancel', 'busy', 'connecting', 'generation', 'dialog', 'scanning']) {
    const f = fixture(createGroupDialogController);
    f.controller.bindEvents();
    f.controller.openGroup('Home');
    f.setConfirm(() => {
      if (mutation === 'cancel') return false;
      if (mutation === 'busy') f.busy.add('one');
      if (mutation === 'connecting') f.connecting.add('one');
      if (mutation === 'generation') f.state.generation++;
      if (mutation === 'dialog') f.state.dialogRevision++;
      if (mutation === 'scanning') f.state.scanningGroupNames.add('Home');
      return true;
    });
    assert.equal(await f.controller.deleteGroup(), false, mutation);
    assert.match(f.record.confirmations[0], /1 台设备会移入「未分组」/);
    assert.equal(f.record.requests.length, 0, mutation);
    assert.equal(f.state.isLoading, false);
  }

  // Late request/JSON failures and successes cannot mutate a replacement form/owner.
  for (const action of ['saveGroup', 'deleteGroup']) {
    for (const stage of ['request', 'json']) {
      for (const shouldReject of [false, true]) {
        const f = fixture(createGroupDialogController);
        f.controller.bindEvents();
        f.controller.openGroup('Home');
        f.setFields({ groupName: 'Old', groupOpenWrtPassword: 'old-password' });
        const pending = deferred();
        f.setRequest(() =>
          stage === 'request' ? pending.promise : Promise.resolve({ json: () => pending.promise }),
        );
        const task = f.controller[action]();
        await flush();
        const oldOwner = f.state.activeOperation;
        f.state.generation++;
        f.controller.invalidate();
        assert.equal(oldOwner.abortController.signal.aborted, true);
        assert.equal(f.getElement('groupDialog').open, true, 'invalidate keeps existing token UI');
        f.controller.openGroup('Work');
        f.setFields({ groupOpenWrtPassword: 'new-password' });
        const newOwner = { generation: f.state.generation, abortController: new AbortController() };
        f.state.activeOperation = newOwner;
        f.state.isLoading = true;
        if (shouldReject) pending.reject(Error('old failure'));
        else if (stage === 'request')
          pending.resolve({ json: async () => ({ name: 'Old', moved_count: 1 }) });
        else pending.resolve({ name: 'Old', moved_count: 1 });
        assert.equal(await task, false);
        assert.equal(f.state.activeOperation, newOwner);
        assert.equal(f.state.isLoading, true);
        assert.equal(f.state.editingGroupName, 'Work');
        assert.equal(f.getElement('groupOpenWrtPassword').value, 'new-password');
        assert.equal(f.getElement('groupDialog').open, true);
        assert.equal(f.record.requests.length, 1);
        assert.equal(f.record.modalMessages.length, 0);
        assert.equal(f.record.messages.length, 0);
        assert.equal(f.record.dismissed.length, 0);
        assert.equal(f.record.refreshes, 0);
      }
    }
  }

  // A refreshed list awaiting I/O must not release a newer global operation.
  {
    const f = fixture(createGroupDialogController);
    f.controller.bindEvents();
    f.controller.openGroup();
    f.setFields({ groupName: 'Saved' });
    const pending = deferred();
    f.setRefresh(() => pending.promise);
    const task = f.controller.saveGroup();
    await flush();
    assert.equal(f.record.refreshes, 1);
    f.state.generation++;
    f.controller.invalidate();
    const owner = { generation: f.state.generation, abortController: new AbortController() };
    f.state.activeOperation = owner;
    f.state.isLoading = true;
    const messageCount = f.record.messages.length;
    pending.reject(Error('old refresh error'));
    assert.equal(await task, false);
    assert.equal(f.state.activeOperation, owner);
    assert.equal(f.state.isLoading, true);
    assert.equal(f.record.messages.length, messageCount);
  }

  // Scan coordination is per group, without page-wide loading or implicit ADB work.
  {
    const f = fixture(createGroupDialogController);
    const pending = new Map();
    f.setRequest((requestPath) => {
      const job = deferred();
      pending.set(requestPath, job);
      return job.promise;
    });
    const home = f.controller.scanGroup('Home');
    const work = f.controller.scanGroup('Work');
    assert.equal(f.state.isLoading, false);
    assert.equal(await f.controller.scanGroup('Home'), false);
    assert.deepEqual([...f.state.scanningGroupNames], ['Home', 'Work']);
    assert.equal(f.record.requests.length, 2);
    assert.equal(f.record.requests[0].options.body, undefined);
    pending.get('/api/groups/Work/discovery/scan').resolve({ json: async () => ({ found: 1 }) });
    assert.equal(await work, true);
    assert.deepEqual([...f.state.scanningGroupNames], ['Home']);
    pending.get('/api/groups/Home/discovery/scan').resolve({ json: async () => ({ found: 2 }) });
    assert.equal(await home, true);
    assert.equal(f.state.scanningGroupNames.size, 0);
    assert.equal(f.state.scanOperations.size, 0);
    assert.equal(f.record.refreshes, 2);
    assert.deepEqual(
      f.record.results.map((entry) => entry.name),
      ['Work', 'Home'],
    );
    assert(f.record.requests.every((entry) => entry.path.endsWith('/discovery/scan')));
    f.connecting.add('one');
    assert.equal(await f.controller.scanGroup('Home'), false);
    f.connecting.clear();
    f.busy.add('one');
    const busyScan = f.controller.scanGroup('Home');
    assert.equal(
      f.record.requests.length,
      3,
      'scan leaves active/live devices to server filtering',
    );
    pending.get('/api/groups/Home/discovery/scan').resolve({ json: async () => ({ found: 0 }) });
    await busyScan;
  }

  // Authorization test uses unsaved fields, and never saves or refreshes devices.
  {
    const f = fixture(createGroupDialogController);
    f.controller.bindEvents();
    f.controller.openGroup('Home');
    f.setFields({
      groupOpenWrtUrl: ' http://unsaved/ubus ',
      groupOpenWrtUser: ' ',
      groupOpenWrtPassword: ' unsaved password ',
    });
    const pending = deferred();
    f.setRequest(() => pending.promise);
    const test = f.getElement('testGroupDiscovery').fire('click');
    assert.equal(f.getElement('testGroupDiscovery').disabled, true);
    assert.equal(f.state.isLoading, false);
    assert.deepEqual(JSON.parse(f.record.requests[0].options.body), {
      url: 'http://unsaved/ubus',
      username: 'easyadb',
      password: ' unsaved password ',
    });
    assert.equal(f.record.requests[0].path, '/api/groups/Home/discovery/test');
    pending.resolve({ json: async () => ({ authorized: true, found: 3 }) });
    await test;
    assert.equal(f.getElement('testGroupDiscovery').disabled, false);
    assert.equal(f.record.refreshes, 0);
    assert.equal(f.record.results.length, 0);
    assert.equal(f.record.modalMessages[0].kind, 'ok');
    assert.match(f.record.modalMessages[0].text, /3 条记录（不会更新设备端口）/);
    assert.equal(f.getElement('groupOpenWrtPassword').value, ' unsaved password ');
  }

  // Both test feedback and the button belong to the initiating dialog revision.
  for (const shouldReject of [false, true]) {
    const f = fixture(createGroupDialogController);
    f.controller.bindEvents();
    f.controller.openGroup('Home');
    const pending = deferred();
    f.setRequest(() => pending.promise);
    const test = f.controller.scanGroup('Home', true);
    f.getElement('groupDialog').open = false;
    f.controller.resetGroup();
    f.controller.openGroup('Work');
    f.getElement('testGroupDiscovery').disabled = true;
    if (shouldReject) pending.reject(Error('old test failure'));
    else pending.resolve({ json: async () => ({ authorized: true, found: 2 }) });
    await test;
    assert.equal(f.record.modalMessages.length, 0);
    assert.equal(f.getElement('testGroupDiscovery').disabled, true);
    assert.equal(f.state.editingGroupName, 'Work');
    assert.equal(f.state.scanningGroupNames.size, 0);
  }

  // Token invalidation restores only its own test button and keeps the dialog.
  {
    const f = fixture(createGroupDialogController);
    f.controller.bindEvents();
    f.controller.openGroup('Home');
    const pending = deferred();
    f.setRequest(() => pending.promise);
    const task = f.controller.scanGroup('Home', true);
    const owner = f.state.scanOperations.get('Home');
    const revision = f.state.dialogRevision;
    f.state.generation++;
    // This loading lock belongs to a different feature, not to a group mutation.
    f.state.isLoading = true;
    f.controller.invalidate();
    assert.equal(f.state.isLoading, true);
    assert.equal(f.getElement('groupDialog').open, true);
    assert.equal(f.state.editingGroupName, 'Home');
    assert.equal(f.state.hasSavedDiscovery, true);
    assert.equal(f.state.dialogRevision, revision + 1);
    assert.equal(f.getElement('testGroupDiscovery').disabled, false);
    assert.equal(owner.abortController.signal.aborted, true);
    assert.equal(f.state.scanOperations.size, 0);
    pending.reject(Error('old credential failed'));
    assert.equal(await task, false);
    assert.equal(f.record.modalMessages.length, 0);
    assert.equal(f.state.isLoading, true);
  }

  // An old scan cannot clear or present the new scan of the same group after reset.
  for (const stage of ['request', 'json', 'refresh']) {
    const f = fixture(createGroupDialogController);
    const pending = deferred();
    if (stage === 'refresh') f.setRefresh(() => pending.promise);
    else
      f.setRequest(() =>
        stage === 'request' ? pending.promise : Promise.resolve({ json: () => pending.promise }),
      );
    const old = f.controller.scanGroup('Home');
    await flush();
    const oldOwner = f.state.scanOperations.get('Home');
    f.state.generation++;
    f.controller.invalidate();
    assert.equal(oldOwner.abortController.signal.aborted, true);
    const fresh = deferred();
    f.setRequest(() => fresh.promise);
    f.setRefresh(async () => true);
    const next = f.controller.scanGroup('Home');
    const newOwner = f.state.scanOperations.get('Home');
    if (stage === 'request') pending.resolve({ json: async () => ({ found: 4 }) });
    else if (stage === 'json') pending.resolve({ found: 4 });
    else pending.reject(Error('old refresh failed'));
    assert.equal(await old, false);
    assert.equal(f.state.scanOperations.get('Home'), newOwner);
    assert.equal(f.state.scanningGroupNames.has('Home'), true);
    assert.equal(f.record.results.length, 0);
    assert.equal(f.record.errors.length, 0);
    fresh.resolve({ json: async () => ({ found: 1 }) });
    assert.equal(await next, true);
    assert.equal(f.record.results.length, 1);
    assert.equal(f.state.scanningGroupNames.size, 0);
  }

  // Failed refreshes and initial rendering errors release their own state.
  for (const action of ['saveGroup', 'deleteGroup', 'scanGroup']) {
    const f = fixture(createGroupDialogController);
    f.controller.bindEvents();
    f.controller.openGroup('Home');
    let shouldThrow = true;
    f.setRender(() => {
      if (shouldThrow) {
        shouldThrow = false;
        throw Error('render failed');
      }
    });
    assert.equal(await f.controller[action]('Home'), false);
    assert.equal(f.state.activeOperation, null);
    assert.equal(f.state.isLoading, false);
    assert.equal(f.state.scanOperations.size, 0);
    assert.equal(f.state.scanningGroupNames.size, 0);
    assert.equal(f.record.requests.length, 0);
  }
  for (const shouldThrow of [false, true]) {
    const f = fixture(createGroupDialogController);
    f.setRefresh(async () => {
      if (shouldThrow) throw Error('scan refresh failed');
      return false;
    });
    assert.equal(await f.controller.scanGroup('Home'), true);
    assert.equal(f.record.errors.length, 0);
    assert.equal(f.record.results.length, 1, 'successful discovery keeps its endpoint details');
    assert.match(f.record.messages.at(-1).text, /扫描已完成，但列表刷新失败/);
    assert.equal(f.record.messages.at(-1).kind, 'error');
    assert.equal(f.state.scanOperations.size, 0);
    assert.equal(f.state.scanningGroupNames.size, 0);
  }

  // The extracted renderer is identical to the retained pre-bootstrap view.
  {
    const html = fs.readFileSync('web/index.html', 'utf8');
    const start = html.indexOf('function renderDiscoveryResult(last)');
    const end = html.indexOf('async function scanGroup(', start);
    assert(start >= 0 && end > start, 'legacy presentation comparison requires its real page code');
    const elem = (tag, className, text) => new Element(tag, className, text);
    const context = vm.createContext({ elem, frontendModules: null, groupDiscoveryView: null });
    vm.runInContext(html.slice(start, end), context);
    const legacyRender = vm.runInContext('renderDiscoveryResult', context);
    const project = (element) => ({
      tag: element.tagName,
      className: element.className,
      textContent: element.textContent,
      children: element.children.map(project),
    });
    const statusNames = [
      'updated',
      'unchanged',
      'unmatched',
      'busy',
      'ambiguous',
      'conflicting',
      'route_conflict',
      'unknown',
    ];
    const samples = [
      { error: 'Discovery failed' },
      { found: 1 },
      { found: 0, endpoints: [] },
      {
        found: 8,
        updated: ['one'],
        unmatched: ['two'],
        busy: ['three'],
        ambiguous: ['four'],
        conflicting: ['five'],
        route_conflict: ['six'],
        endpoints: statusNames.map((status, index) => ({
          status,
          ip: '192.168.1.' + index,
          port: 5555,
          device_name: index % 2 ? 'Phone ' + index : '',
        })),
      },
    ];
    for (const sample of samples) {
      assert.deepEqual(
        project(renderDiscoveryResult(sample, { elem })),
        project(legacyRender(sample)),
      );
    }
  }

  console.log(
    'Group dialog controller: form events, partial saves, confirmation, scan owners, stale async and equivalent discovery DOM: OK',
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
