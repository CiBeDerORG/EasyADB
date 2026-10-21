/* Shared DOM/request ports for the real production page controller. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
async function until(predicate, message = 'expected asynchronous progress did not arrive') {
  for (let index = 0; index < 40; index++) {
    if (predicate()) return;
    await tick();
  }
  assert.fail(message);
}
function findAll(root, predicate) {
  return [...(predicate(root) ? [root] : []), ...root.children.flatMap(child => findAll(child, predicate))];
}

class Element {
  constructor(tagName = 'div', className = '', textContent = '') {
    this.tagName = tagName.toUpperCase();
    this.attrs = {};
    this.children = [];
    this.parentNode = null;
    this.ownerDocument = null;
    this.events = new Map();
    this.listeners = this.events;
    this.eventOptions = new Map();
    this.className = className;
    this._text = String(textContent ?? '');
    this.value = this.defaultValue = '';
    this.checked = this.defaultChecked = false;
    this.hidden = this.disabled = this.open = false;
    this.inert = false;
    this.closeCount = this.showCount = this.resetCount = this.focusCount = 0;
    this.css = {};
    this.style = {setProperty: (name, value) => { this.css[name] = String(value); }};
    const names = () => new Set(this.className.split(/\s+/).filter(Boolean));
    this.classList = {
      contains: name => names().has(name),
      add: (...values) => { this.className = [...new Set([...names(), ...values])].join(' '); },
      remove: (...values) => { this.className = [...names()].filter(name => !values.includes(name)).join(' '); },
      toggle: (name, force) => {
        const next = force === undefined ? !names().has(name) : Boolean(force);
        if (next) this.classList.add(name); else this.classList.remove(name);
        return next;
      },
    };
  }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this._text = String(value ?? '');
  }
  append(...nodes) {
    for (let node of nodes) {
      if (typeof node === 'string') node = new Element('#text', '', node);
      node.remove(); node.parentNode = this; this.children.push(node);
    }
  }
  prepend(...nodes) {
    for (const node of [...nodes].reverse()) {
      node.remove(); node.parentNode = this; this.children.unshift(node);
    }
  }
  replaceChildren(...nodes) {
    this.textContent = ''; this.append(...nodes);
  }
  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.children, index = siblings.indexOf(this);
    if (index >= 0) siblings.splice(index, 1);
    this.parentNode = null;
  }
  contains(node) {
    for (let current = node; current; current = current.parentNode || current.parent) if (current === this) return true;
    return false;
  }
  setAttribute(name, value) {
    this.attrs[name] = String(value);
    if (name === 'class') this.className = String(value);
    if (name === 'id') this.id = String(value);
  }
  getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; }
  hasAttribute(name) { return Object.hasOwn(this.attrs, name); }
  removeAttribute(name) { delete this.attrs[name]; }
  addEventListener(name, listener, options = {}) {
    if (!this.events.has(name)) this.events.set(name, []);
    this.events.get(name).push(listener);
    if (!this.eventOptions.has(name)) this.eventOptions.set(name, []);
    this.eventOptions.get(name).push(typeof options === 'boolean' ? {capture: options} : options);
  }
  removeEventListener(name, listener) {
    const listeners = this.events.get(name) || [], index = listeners.indexOf(listener);
    if (index < 0) return;
    listeners.splice(index, 1); this.eventOptions.get(name).splice(index, 1);
    if (!listeners.length) { this.events.delete(name); this.eventOptions.delete(name); }
  }
  dispatch(name, overrides = {}) {
    const event = {type: name, target: this, currentTarget: this, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...overrides};
    const results = [...(this.events.get(name) || [])].map(listener => listener(event));
    const pending = Promise.all(results).then(values => values.findLast(value => value !== undefined));
    return {event, results, pending};
  }
  fire(name, overrides = {}) { return this.dispatch(name, overrides).pending; }
  dispatchEvent(event) { return !this.dispatch(event.type, event).event.defaultPrevented; }
  click() { if (!this.disabled) return this.fire('click'); }
  reset() {
    this.resetCount++;
    for (const element of findAll(this, node => ['INPUT', 'SELECT', 'TEXTAREA'].includes(node.tagName))) {
      element.value = element.defaultValue; element.checked = element.defaultChecked;
    }
  }
  reportValidity() {
    if (this.valid !== undefined) return this.valid;
    for (const field of findAll(this, node => node.tagName === 'INPUT')) {
      if (field.disabled) continue;
      if (field.hasAttribute('required') && !String(field.value).trim()) return false;
      if (!String(field.value)) continue;
      if (field.attrs.type === 'number') {
        const value = Number(field.value);
        if (!Number.isFinite(value)) return false;
        if (field.attrs.min !== undefined && value < Number(field.attrs.min)) return false;
        if (field.attrs.max !== undefined && value > Number(field.attrs.max)) return false;
      }
      if (field.attrs.pattern && !(new RegExp('^(?:' + field.attrs.pattern + ')$')).test(field.value)) return false;
    }
    return true;
  }
  focus() { this.focusCount++; this.focused = true; if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  showModal() { this.open = true; this.showCount++; }
  close() {
    if (!this.open) return;
    this.open = false; this.closeCount++; this.dispatch('close');
  }
  cancel() {
    const {event} = this.dispatch('cancel');
    if (!event.defaultPrevented) this.close();
    return event;
  }
  querySelectorAll(selector) {
    const selectors = selector.split(',').map(value => value.trim());
    return findAll(this, element => selectors.some(value => {
      if (value === 'dialog[open]') return element.tagName === 'DIALOG' && element.open;
      if (value.startsWith('#')) return element.id === value.slice(1);
      if (value.startsWith('.')) return element.classList.contains(value.slice(1));
      return element.tagName === value.toUpperCase();
    })).filter(element => element !== this);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function createDOM(source = fs.readFileSync(path.join(__dirname, '../../web/index.html'), 'utf8')) {
  const elements = new Map(), document = new Element('document');
  document.ownerDocument = document;
  document.createElement = tag => { const node = new Element(tag); node.ownerDocument = document; return node; };
  document.getElementById = id => {
    assert(elements.has(id), 'production references an absent HTML id: ' + id);
    return elements.get(id);
  };
  const stack = [document];
  const empty = new Set(['AREA', 'BASE', 'BR', 'COL', 'EMBED', 'HR', 'IMG', 'INPUT', 'LINK', 'META', 'PARAM', 'SOURCE', 'TRACK', 'WBR']);
  for (const match of source.matchAll(/<!--[\s\S]*?-->|<![^>]*>|<\/?([a-zA-Z][\w-]*)\b([^>]*?)>|([^<]+)/g)) {
    if (!match[1]) {
      if (match[3] && !['SCRIPT', 'STYLE'].includes(stack.at(-1).tagName)) stack.at(-1)._text += match[3];
      continue;
    }
    const tag = match[1].toUpperCase();
    if (match[0].startsWith('</')) {
      const index = stack.findLastIndex(node => node.tagName === tag);
      if (index > 0) stack.length = index;
      continue;
    }
    const node = document.createElement(tag), attributes = match[2];
    for (const attr of attributes.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      node.setAttribute(attr[1], attr[2] ?? attr[3] ?? attr[4] ?? '');
    }
    node.value = node.defaultValue = node.attrs.value || '';
    node.type = node.attrs.type || '';
    node.checked = node.defaultChecked = node.hasAttribute('checked');
    for (const name of ['hidden', 'disabled', 'inert', 'open']) node[name] = node.hasAttribute(name);
    if (node.id) { assert(!elements.has(node.id), 'duplicate HTML id: ' + node.id); elements.set(node.id, node); }
    stack.at(-1).append(node);
    if (!empty.has(tag) && !/\/\s*$/.test(attributes)) stack.push(node);
  }
  document.documentElement = document.querySelector('html');
  document.body = document.querySelector('body');
  document.activeElement = document.body;
  document.fullscreenElement = null;
  const window = new Element('window');
  window.document = document;
  window.selection = {isCollapsed: true};
  window.getSelection = () => window.selection;
  const storageValues = new Map();
  const storage = {
    values: storageValues, getItem: key => storageValues.get(key) ?? null,
    setItem: (key, value) => storageValues.set(key, String(value)), removeItem: key => storageValues.delete(key),
  };
  window.localStorage = storage;
  return {document, window, elements, get: document.getElementById, storage, html: source};
}

const originalTimers = {setTimeout, clearTimeout, setInterval, clearInterval, now: Date.now};
function createClock() {
  let now = 0, next = 1;
  const timers = new Map(), scheduled = [];
  const schedule = (callback, delay = 0) => {
    const id = next++; timers.set(id, {callback, at: now + delay, delay}); scheduled.push({id, delay}); return id;
  };
  return {
    timers, scheduled, get now() { return now; },
    setTimeout: schedule, clearTimeout: id => timers.delete(id),
    install() {
      global.setTimeout = schedule; global.clearTimeout = id => timers.delete(id); Date.now = () => now;
      global.setInterval = () => { throw Error('the page must not create polling intervals'); };
      global.clearInterval = () => {};
    },
    restore() {
      global.setTimeout = originalTimers.setTimeout; global.clearTimeout = originalTimers.clearTimeout;
      global.setInterval = originalTimers.setInterval; global.clearInterval = originalTimers.clearInterval; Date.now = originalTimers.now;
    },
    advance(amount) {
      const end = now + amount;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((left, right) => left[1].at - right[1].at)[0];
        if (!due) break;
        now = due[1].at; timers.delete(due[0]); due[1].callback();
      }
      now = end;
    },
  };
}

async function createPageFixture(options = {}) {
  const {createPageController} = await import('../../web/app/page-controller.js');
  const dom = createDOM(options.html), {document, window, get} = dom;
  const clock = options.clock || createClock(); clock.install();
  window.setTimeout = clock.setTimeout; window.clearTimeout = clock.clearTimeout;
  if (options.storage) {
    const entries = options.storage instanceof Map ? options.storage : Object.entries(options.storage);
    for (const [key, value] of entries) dom.storage.setItem(key, value);
  }
  get('token').value = options.token ?? 'test-token';
  const requests = [], confirmations = [], messages = [], toasts = [], dismissed = [];
  const busy = new Set(options.busy || []), data = {devices: options.devices || [], groups: options.groups || []};
  const requestOptions = {handler: options.request || null, confirm: options.confirm ?? true};
  const ports = {multi: 0, group: 0, lab: 0}, liveOptions = {}, labOptions = {};
  const live = {
    closeCount: 0, redrawCount: 0, openedSettings: [],
    isBusyFor: id => busy.has(id),
    updatePicker() { this.redrawCount++; },
    closeAll() { this.closeCount++; },
    projectionButton(device) { const node = document.createElement('button'); node.className = 'projector'; node.textContent = device.name; return node; },
    openSettings(device) { this.openedSettings.push(device); },
  };
  const normalize = result => ({ok: true, status: 200, ...result});
  const request = async (requestPath, supplied = {}) => {
    const entry = {path: requestPath, method: supplied.method || 'GET', options: supplied,
      body: supplied.body && JSON.parse(supplied.body), signal: supplied.signal,
      headers: supplied.headers, token: supplied.headers?.['X-EasyADB-Token'], pending: deferred()};
    requests.push(entry);
    if (requestOptions.handler) return normalize(await requestOptions.handler(requestPath, supplied, entry));
    assert.equal(entry.method, 'GET', 'test must supply a response for mutation ' + requestPath);
    assert(['/api/devices', '/api/groups'].includes(requestPath), 'unexpected automatic request ' + requestPath);
    return normalize({json: async () => requestPath === '/api/devices' ? data.devices : data.groups});
  };
  const createOptions = {
    documentRef: document, windowRef: window, request, storage: dom.storage,
    confirmAction: text => { confirmations.push(text); return typeof requestOptions.confirm === 'function' ? requestOptions.confirm(text) : requestOptions.confirm; },
    createMultiView: supplied => { ports.multi++; Object.assign(liveOptions, supplied); return options.createMultiView ? options.createMultiView(supplied) : live; },
    createGroupControl: supplied => { ports.group++; return options.createGroupControl ? options.createGroupControl(supplied) : {refresh() {}}; },
    createDisplayLab: supplied => { ports.lab++; Object.assign(labOptions, supplied); return options.createDisplayLab ? options.createDisplayLab(supplied) : {opened: [], open(id) { this.opened.push(id); }}; },
  };
  const page = createPageController(createOptions);
  const showToast = page.toast.showToast;
  page.toast.showToast = (content, supplied = {}) => {
    const record = {content, key: supplied.key || 'status', kind: supplied.kind || ''};
    toasts.push(record);
    if (typeof content === 'string' && record.key === 'status') messages.push({text: content, kind: record.kind});
    const card = showToast(content, supplied); record.card = card; return card;
  };
  const dismissToast = page.toast.dismissToast;
  page.toast.dismissToast = key => { dismissed.push(key); return dismissToast(key); };
  // Group dialogs capture this presentation port during production assembly.
  // Observe it without replacing the real toast controller's behavior.
  const dismissGroupToast = page.controllers.groupDialogs.dismissToast;
  page.controllers.groupDialogs.dismissToast = key => { dismissed.push(key); return dismissGroupToast(key); };
  const installRows = (devices = data.devices, groups = data.groups) => {
    data.devices = devices; data.groups = groups;
    page.state.devices = devices; page.state.groups = groups; page.state.isLoaded = true; page.render();
  };
  if (options.loaded !== false && options.devices) installRows();
  return { ...dom, page, state: page.state, controllers: page.controllers, clock, requests, confirmations,
    messages, toasts, dismissed, busy, data, requestOptions, live, liveOptions, labOptions, ports, installRows,
    bootstrap: () => createPageController(createOptions),
    dispose() { page.toast.dispose(); clock.restore(); },
  };
}

module.exports = {Element, createDOM, createClock, createPageFixture, deferred, tick, until, findAll};
