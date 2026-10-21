/* Real page/MultiView/live factories and TouchController; media and transport are local fakes. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createPageFixture, until, findAll} = require('./page-fixture.cjs');

async function fixture() {
  const devices = [1, 2].map(index => ({id: String(index), name: 'Phone ' + index,
    group_name: 'Default', ip: '192.0.2.' + index, port: 5555, status: 'connected',
    selected_route: 'mesh', selected_serial: '192.0.2.' + index + ':5555',
    active_serial: '192.0.2.' + index + ':5555'}));
  const sockets = [], blurListeners = new Set();
  let fullscreenExits = 0;
  class Socket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.closeCount = 0; sockets.push(this); }
    send(message) { this.sent.push(message); }
    open() { this.readyState = 1; this.onopen?.(); }
    close() { this.readyState = 3; this.closeCount++; this.onclose?.(); }
    emit(type, data = {}) { this.onmessage?.({data: JSON.stringify({type, ...data})}); }
  }
  const f = await createPageFixture({devices, groups: [{name: 'Default'}],
    createGroupControl: () => ({refresh() {}, updateLog() {}}),
    createMultiView(supplied) {
      const document = supplied.picker.ownerDocument, createElement = document.createElement;
      document.createElement = tag => {
        const element = createElement(tag);
        if (tag === 'video') {
          element.videoWidth = element.videoHeight = 0;
          element.style.touchAction = 'auto'; element.style.cursor = 'default';
          element.getBoundingClientRect = () => ({left: 0, top: 0, width: 400, height: 400});
          element.setPointerCapture = id => { element.captured = id; };
          element.releasePointerCapture = id => { element.released = id; };
        }
        return element;
      };
      document.exitFullscreen = () => { fullscreenExits++; document.fullscreenElement = null; return Promise.resolve(); };
      const browser = {document, location: {protocol: 'http:', host: 'mock.invalid'},
        performance: {now: () => 0}, WebSocket: Socket,
        setTimeout: (callback, ms) => global.setTimeout(callback, ms), clearTimeout: id => global.clearTimeout(id),
        addEventListener(name, listener) { assert.equal(name, 'blur'); blurListeners.add(listener); },
        removeEventListener(name, listener) { assert.equal(name, 'blur'); blurListeners.delete(listener); },
        fetch: async url => {
          assert.equal(url, '/api/m2/video-engine');
          return {ok: true, json: async () => ({engine: 'webrtc', implemented: true, max_starting: 3})};
        },
        EasyADBWebRTC: {create: (_video, callbacks) => ({callbacks, starts: 0, initializes: 0, destroys: 0,
          async start() { this.starts++; }, async answer() {}, pollStats() {},
          initialize() { this.initializes++; callbacks.onState('ready'); },
          destroy() { this.destroys++; }, resume() {},
        })},
      };
      browser.window = browser;
      const context = vm.createContext(browser);
      for (const file of ['web/m2-traffic.js', 'web/m2-metrics.js', 'web/m2-touch.js', 'web/m2-multi.js']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, '../../', file), 'utf8'), context, {filename: file});
      }
      return browser.EasyADBMulti.create(supplied);
    }});
  const view = f.page.multiView;
  await until(() => view.engineReady);
  const port = id => {
    const row = findAll(f.get('devices'), element => element.className === 'item' &&
      findAll(element, child => child.className === 'item-name' && child.textContent === 'Phone ' + id).length)[0];
    return findAll(row, element => element.tagName === 'BUTTON' && element.classList.contains('device-projector'))[0];
  };
  return {...f, view, sockets, blurListeners, getFullscreenExits: () => fullscreenExits,
    async open(id, initialize = true) {
      await port(id).click();
      const card = view.cards.get(id); card.ws.open();
      card.ws.emit('starting', {session_id: 'session-' + sockets.length});
      if (initialize) {
        card.video.videoWidth = 720; card.video.videoHeight = 1280;
        card.ws.emit('init', {session_id: card.session, width: 720, height: 1280, control_available: true});
        await card.video.fire('loadedmetadata');
        card.ws.emit('control_enabled', {session_id: card.session});
        card.player.callbacks.onState('playing');
      }
      return card;
    },
    cleanup() {
      view.closeAll(); assert.equal(blurListeners.size, 0);
      assert.equal(f.requests.length, 0, 'rotation must not connect ADB, unlock or reload device metadata'); f.dispose();
    },
  };
}

const writes = socket => socket.sent.filter(message => message !== 'stop').map(message => JSON.parse(message));
const touches = socket => writes(socket).filter(message => message.type === 'touch');
const geometry = (card, width, height, extra = {}) => card.ws.emit('resize', {
  session_id: card.session, width, height, ...extra,
});
const point = (card, type, pointerId = 1) => card.video.fire(type, {
  isPrimary: true, button: 0, pointerId, timeStamp: 100, clientX: 200, clientY: 200,
});
const decoded = async (card, width, height) => {
  card.video.videoWidth = width; card.video.videoHeight = height; await card.video.fire('resize');
};

async function bidirectionalRotationKeepsOwners() {
  const f = await fixture();
  try {
    const card = await f.open('1'), other = await f.open('2');
    const socket = card.ws, player = card.player, touch = card.touch, session = card.session;
    const otherWrites = [...other.ws.sent], otherTouch = other.touch, otherPlayer = other.player;
    const inFlight = f.view.launchInFlight;
    f.document.fullscreenElement = card.screen; card.syncFullscreen();
    await point(card, 'pointerdown', 10);
    assert.equal(touch.activeId, 10);
    const beforeMediaRotation = socket.sent.length;
    // Media first: layout follows decoded pixels, but touch waits for matching server geometry.
    await decoded(card, 1280, 720);
    assert.equal(card.screen.style.aspectRatio, '1280 / 720'); assert.equal(card.box.style.width, '1306px');
    assert.equal(socket.sent.length, beforeMediaRotation, 'server already released the old gesture; do not send stale cancel');
    assert.equal(card.video.released, 10);
    assert.equal(touch.activeId, null); assert.equal(card.size.width, 720);
    const beforeBlocked = socket.sent.length;
    await point(card, 'pointerdown', 11); assert.equal(socket.sent.length, beforeBlocked);
    geometry(card, 1280, 720); await point(card, 'pointerdown', 11);
    assert.equal(touches(socket).at(-1).action, 'down'); assert.equal(touches(socket).at(-1).x, 640);
    assert.equal(touches(socket).at(-1).y, 360); assert.equal(touches(socket).at(-1).width, 1280);
    const beforeServerRotation = socket.sent.length;
    // WS first on the return rotation: cancel the old gesture and retain the decoded layout.
    geometry(card, 720, 1280);
    assert.equal(socket.sent.length, beforeServerRotation); assert.equal(card.video.released, 11);
    assert.equal(touch.activeId, null); assert.equal(card.screen.style.aspectRatio, '1280 / 720');
    const beforeSecondBlock = socket.sent.length;
    await point(card, 'pointerdown', 12); assert.equal(socket.sent.length, beforeSecondBlock);
    await decoded(card, 720, 1280); await point(card, 'pointerdown', 12);
    assert.equal(touches(socket).at(-1).action, 'down'); assert.equal(touches(socket).at(-1).x, 360);
    assert.equal(touches(socket).at(-1).y, 640); assert.equal(card.box.style.width, '746px');
    assert.equal(card.screen.getAttribute('data-orientation'), 'portrait');
    const beforeDuplicate = socket.sent.length;
    geometry(card, 720, 1280); assert.equal(touch.activeId, 12); assert.equal(socket.sent.length, beforeDuplicate);
    assert.equal(card.ws, socket); assert.equal(card.player, player); assert.equal(card.touch, touch);
    assert.equal(card.session, session); assert.equal(card.state, 'playing'); assert.equal(card.closed, false);
    assert.equal(card.enabled, true); assert.equal(touch.enabled, true); assert.equal(card.pending, false);
    assert.equal(player.starts, 1); assert.equal(player.initializes, 1); assert.equal(player.destroys, 0);
    assert.equal(socket.closeCount, 0); assert.equal(f.view.launchInFlight, inFlight); assert.equal(f.sockets.length, 2);
    assert.equal(writes(socket).filter(message => message.type === 'control_enable').length, 1);
    assert.equal(writes(socket).some(message => ['webrtc_offer', 'unlock', 'wake'].includes(message.type)), false);
    assert.equal(f.document.fullscreenElement, card.screen); assert.equal(f.getFullscreenExits(), 0);
    assert.equal(f.view.cards.get('2'), other); assert.equal(other.touch, otherTouch); assert.equal(other.player, otherPlayer);
    assert.deepEqual(other.ws.sent, otherWrites); assert.equal(other.closed, false);
    assert.equal(other.screen.style.aspectRatio, '720 / 1280');
  } finally { f.cleanup(); }
}

async function invalidAndStaleGeometryCannotCloseOrReenable() {
  const f = await fixture();
  try {
    const card = await f.open('1'), socket = card.ws, touch = card.touch;
    await point(card, 'pointerdown');
    const originalSize = card.size, before = [...socket.sent];
    for (const size of [[0, 720], [720, 0], [-1, 720], [8193, 720], [720, 8193],
      [1280.5, 720], ['1280', 720], [1280, null], [undefined, 720]]) {
      geometry(card, ...size);
    }
    geometry(card, 1280, 720, {session_id: 'other-session'});
    geometry(card, 1280, 720, {session_id: null});
    assert.equal(card.size, originalSize); assert.equal(touch.activeId, 1);
    assert.deepEqual(socket.sent, before); assert.equal(card.closed, false);
    socket.emit('control_disabled', {session_id: card.session});
    const disabledWrites = [...socket.sent];
    geometry(card, 1280, 720); await decoded(card, 1280, 720); await point(card, 'pointerdown', 2);
    assert.equal(card.enabled, false); assert.equal(touch.enabled, false); assert.equal(card.pending, false);
    assert.equal(touch.size.width, 1280); assert.equal(card.size.width, 1280);
    assert.deepEqual(socket.sent, disabledWrites); assert.equal(card.closed, false);
    const oldMessage = socket.onmessage, oldSize = card.size;
    const oldResizeCallbacks = [...card.video.events.get('resize')];
    const oldMetadataCallbacks = [...card.video.events.get('loadedmetadata')];
    f.view.end(card, true);
    assert.equal(card.video.events.has('resize'), false); assert.equal(card.video.events.has('loadedmetadata'), false);
    const endedAspect = card.screen.style.aspectRatio, endedWrites = [...socket.sent];
    const replacement = await f.open('1');
    oldMessage({data: JSON.stringify({type: 'resize', session_id: replacement.session, width: 200, height: 400})});
    card.video.videoWidth = 333; card.video.videoHeight = 777;
    for (const callback of [...oldResizeCallbacks, ...oldMetadataCallbacks]) callback();
    await card.video.fire('resize');
    assert.equal(card.screen.style.aspectRatio, endedAspect); assert.equal(card.size, oldSize);
    assert.deepEqual(socket.sent, endedWrites); assert.equal(f.view.cards.get('1'), replacement);
    assert.equal(replacement.size.width, 720); assert.equal(replacement.closed, false);
  } finally { f.cleanup(); }
}

async function preinitPendingAndStoppingKeepTheirState() {
  const f = await fixture();
  try {
    const card = await f.open('1', false), socket = card.ws;
    geometry(card, 1280, 720);
    assert.equal(card.size, null); assert.equal(card.touch, null); assert.equal(card.startSettled, false);
    socket.emit('init', {session_id: card.session, width: 720, height: 1280, control_available: true});
    assert.equal(card.pending, true); assert.equal(card.enabled, false);
    geometry(card, 1280, 720);
    assert.equal(card.pending, true); assert.equal(card.touch.enabled, false);
    assert.equal(card.screen.style.aspectRatio, '1280 / 720', 'use announced dimensions before first decoded frame');
    await decoded(card, 1280, 720); socket.emit('control_enabled', {session_id: card.session});
    assert.equal(card.enabled, true); assert.equal(card.touch.size.width, 1280);
    f.view.stop(card);
    const size = card.size, writesBeforeResize = [...socket.sent];
    geometry(card, 720, 1280);
    assert.equal(card.state, 'stopping'); assert.equal(card.size, size);
    assert.equal(card.touch.enabled, false); assert.deepEqual(socket.sent, writesBeforeResize);
    assert.equal(card.closed, false); assert.equal(socket.closeCount, 0);
  } finally { f.cleanup(); }
}

module.exports = async function liveRotationContract() {
  await bidirectionalRotationKeepsOwners();
  await invalidAndStaleGeometryCannotCloseOrReenable();
  await preinitPendingAndStoppingKeepTheirState();
  console.log('Real page rotation: same session/player/touch, decoded layout, strict coordinates, gesture cancel and stale-event cleanup: OK');
};
