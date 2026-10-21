import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createApiClient } from '../web/core/api-client.js';
import { createDomHelpers } from '../web/shared/dom.js';
import { createDialogController } from '../web/shared/ui/dialog.js';
import { createToastController } from '../web/shared/ui/toast.js';
import pageFixtures from './helpers/page-fixture.cjs';

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.attrs = {};
    this.textContent = '';
    this.className = '';
    this.parentNode = null;
    this.hidden = false;
  }

  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) || [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  fire(name) {
    for (const listener of this.listeners.get(name) || []) listener();
  }

  setAttribute(name, value) {
    this.attrs[name] = value;
  }

  append(...children) {
    for (const child of children) {
      child.parentNode = this;
      this.children.push(child);
    }
  }

  contains(element) {
    for (let current = element; current; current = current.parentNode) {
      if (current === this) return true;
    }
    return false;
  }

  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }

  showModal() {
    this.open = true;
  }

  close() {
    this.open = false;
  }

  focus() {
    this.focused = true;
  }
}

const listeners = new Map();
const documentRef = {
  createElement: (tag) => new FakeElement(tag),
  addEventListener(name, listener) {
    listeners.set(name, listener);
  },
  removeEventListener(name, listener) {
    if (listeners.get(name) === listener) listeners.delete(name);
  },
};

const calls = [];
const api = createApiClient({
  getToken: () => '  authenticated-token  ',
  request: async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ result: true }) };
  },
});
const response = await api('/api/devices', {
  method: 'POST',
  headers: { Accept: 'application/json', 'X-EasyADB-Token': 'stale' },
});
assert.equal(response.status, 200);
assert.deepEqual(calls[0], {
  url: '/api/devices',
  options: {
    method: 'POST',
    cache: 'no-store',
    headers: { Accept: 'application/json', 'X-EasyADB-Token': 'authenticated-token' },
  },
});
const failingApi = createApiClient({
  getToken: () => 'authenticated-token',
  request: async () => ({
    ok: false,
    status: 401,
    json: async () => ({ detail: '禁止访问' }),
  }),
});
await assert.rejects(failingApi('/api/devices'), /禁止访问/);
const textErrorApi = createApiClient({
  getToken: () => 'authenticated-token',
  request: async () => ({
    ok: false,
    status: 503,
    json: async () => {
      throw Error('not JSON');
    },
  }),
});
await assert.rejects(textErrorApi('/api/devices'), /请求失败：HTTP 503/);

let clicked = 0;
const dom = createDomHelpers({ documentRef });
const element = dom.elem('span', 'device-label', '<name>');
assert.equal(element.textContent, '<name>');
assert.equal(element.className, 'device-label');
const button = dom.action('保存', () => {
  clicked += 1;
});
button.fire('click');
assert.equal(button.type, 'button');
assert.equal(clicked, 1);

const dialogElements = new Map(
  ['deviceDialog', 'name', 'groupMessage'].map((id) => [id, new FakeElement()]),
);
const dialogs = createDialogController({ getElement: (id) => dialogElements.get(id) });
dialogs.showDialog('deviceDialog', 'name');
assert.equal(dialogElements.get('deviceDialog').open, true);
assert.equal(dialogElements.get('name').focused, true);
dialogs.modalMessage('处理失败', 'error', 'groupMessage');
assert.equal(dialogElements.get('groupMessage').textContent, '处理失败');
assert.equal(dialogElements.get('groupMessage').className, 'status modal-status error');
dialogs.closeDialog('deviceDialog');
assert.equal(dialogElements.get('deviceDialog').open, false);

const host = new FakeElement();
const toast = createToastController({
  host,
  documentRef,
  windowRef: { getSelection: () => ({ isCollapsed: true }) },
});
const first = toast.showToast('正在连接', { kind: 'ok' });
assert.equal(first.attrs.role, 'status');
const replacement = toast.showToast('连接失败', { kind: 'error' });
assert.equal(host.children.length, 1, 'same-key messages replace rather than stack');
assert.equal(replacement.attrs.role, 'alert');
first.children[1].fire('click'); // stale close must not delete the replacement
assert.equal(host.children.length, 1);
const richContent = new FakeElement();
toast.showToast(richContent, { key: 'discovery:home', kind: 'ok' });
assert.equal(host.children.length, 2);
toast.dismissToast('discovery:home');
assert.equal(host.children.length, 1);
assert(listeners.has('selectionchange'));
toast.dispose();
assert.equal(host.children.length, 0);
assert(!listeners.has('selectionchange'));

const page = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const main = readFileSync(new URL('../web/app/main.js', import.meta.url), 'utf8');
assert.match(page, /<script type="module" src="\/app\/main\.js"><\/script>/);
assert.doesNotMatch(page, /<script>/);
assert.match(main, /createPageController\(\)/);
assert.doesNotMatch(main, /window\.EasyADB\w*\s*=/);
const fixture = await pageFixtures.createPageFixture();
try {
  assert.equal(fixture.bootstrap(), fixture.page, 'one document has one page instance');
  assert.deepEqual(fixture.ports, { multi: 1, group: 1, lab: 1 });
  assert.equal(fixture.requests.length, 0, 'assembly must not load, connect or scan');
  assert.equal(fixture.controllers.connection.state, fixture.state);
  assert.equal(fixture.controllers.management.state, fixture.state);
  assert.equal(fixture.controllers.deviceDialogs.state, fixture.state);
  assert.equal(fixture.liveOptions.getBatchSelection(), fixture.state.selectedDeviceIds);
  assert.equal(fixture.controllers.configuration.state.devices, fixture.state.devices);
  assert.equal(fixture.controllers.groupDialogs.state.groups, fixture.state.groups);
  for (const name of [
    'createLiveSessionController',
    'createLiveQualitySettings',
    'createLiveBatchScheduler',
    'createLiveCardView',
  ]) {
    assert.equal(typeof fixture.liveOptions.featureModules[name], 'function');
  }
} finally {
  fixture.dispose();
}
console.log('V4 ES Modules, single page assembly and shared state: OK');
