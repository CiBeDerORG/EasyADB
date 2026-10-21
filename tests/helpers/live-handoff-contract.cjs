/* Actual page/MultiView/four live factories; DOM, transport and media ports only are mocked. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createPageFixture, deferred, tick, until, findAll} = require('./page-fixture.cjs');

async function fixture(count = 2) {
  const devices = Array.from({length: count}, (_, index) => {
    const id = String(index + 1);
    return {id, name: 'Device ' + id, group_name: 'Default', ip: '192.0.2.' + id,
      port: 5555, status: 'connected', selected_route: 'mesh',
      selected_serial: '192.0.2.' + id + ':5555', active_serial: '192.0.2.' + id + ':5555'};
  });
  const sockets = [], engineRequests = [];
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
      const document = supplied.picker.ownerDocument;
      const createElement = document.createElement;
      document.createElement = tag => {
        const element = createElement(tag);
        if (tag === 'video') {
          element.frameCallbacks = new Map(); element.cancelledFrames = []; element.nextFrame = 0;
          element.requestVideoFrameCallback = callback => {
            element.frameCallbacks.set(++element.nextFrame, callback); return element.nextFrame;
          };
          element.cancelVideoFrameCallback = id => { element.cancelledFrames.push(id); element.frameCallbacks.delete(id); };
        }
        return element;
      };
      document.exitFullscreen = () => { fullscreenExits++; document.fullscreenElement = null; return Promise.resolve(); };
      const browser = {document, location: {protocol: 'http:', host: 'mock.invalid'},
        performance: {now: () => 0}, WebSocket: Socket,
        setTimeout: (callback, ms) => global.setTimeout(callback, ms), clearTimeout: id => global.clearTimeout(id),
        fetch: async url => {
          assert.equal(url, '/api/m2/video-engine'); engineRequests.push(url);
          return {ok: true, json: async () => ({engine: 'webrtc', implemented: true, max_starting: 3})};
        },
        EasyADBWebRTC: {create: (_video, callbacks) => ({
          callbacks, starts: [], destroyed: 0, startGate: null,
          start(ws, session) { this.starts.push({ws, session}); return this.startGate?.promise || Promise.resolve(); },
          async answer() {}, pollStats() {}, initialize() { callbacks.onState('ready'); },
          destroy() { this.destroyed++; }, resume() {},
        })},
        EasyADBTouch: {create: (_video, send) => ({
          enabled: false, destroyed: 0,
          enable() { this.enabled = true; }, disable() { this.enabled = false; },
          destroy() { this.destroyed++; this.enabled = false; send({type: 'touch', action: 'cancel'}); },
        })},
      };
      browser.window = browser;
      const context = vm.createContext(browser);
      for (const file of ['web/m2-traffic.js', 'web/m2-metrics.js', 'web/m2-multi.js']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, '../../', file), 'utf8'), context, {filename: file});
      }
      assert.equal(browser.EasyADBMulti.MAX_DEVICES, 20);
      return browser.EasyADBMulti.create(supplied);
    }});
  const view = f.page.multiView;
  await until(() => view.engineReady);
  const port = id => {
    const row = findAll(f.get('devices'), node => node.className === 'item' &&
      findAll(node, child => child.className === 'item-name' && child.textContent === 'Device ' + id).length)[0];
    return findAll(row, node => node.tagName === 'BUTTON' && node.classList.contains('device-projector'))[0];
  };
  const ready = (card, session = 'session-' + card.id) => {
    card.ws.emit('starting', {session_id: session});
    card.ws.emit('init', {session_id: session, width: 720, height: 1280, control_available: true});
    card.ws.emit('control_enabled', {session_id: session});
    card.player.callbacks.onState('playing');
    assert.equal(card.enabled, true);
  };
  return {...f, view, sockets, port, ready, getFullscreenExits: () => fullscreenExits,
    async open(id, initialize = true) {
      assert.equal(port(id).disabled, false); await port(id).click();
      const card = view.cards.get(id); card.ws.open();
      if (initialize) ready(card);
      return card;
    },
    cleanup() {
      view.closeAll(); assert.deepEqual(engineRequests, ['/api/m2/video-engine']);
      assert.equal(f.requests.length, 0, 'handoff messages must not trigger ADB or metadata requests'); f.dispose();
    },
  };
}

const replaced = (socket, session) => socket.emit('replaced', {
  ...(session ? {session_id: session} : {}), message: '该设备的实时画面已由其他页面接管',
});
const waiting = socket => socket.emit('waiting', {reason: 'takeover', message: '正在等待旧画面完成清理…'});

async function onlyCurrentOwnerCloses() {
  const f = await fixture();
  try {
    const first = await f.open('1'), second = await f.open('2');
    const ws = first.ws, player = first.player, touch = first.touch, frame = first.frameCallback;
    const oldMessage = ws.onmessage, oldClose = ws.onclose, oldError = ws.onerror;
    const oldFrame = first.video.frameCallbacks.get(frame);
    const otherPlayer = second.player, otherTouch = second.touch, otherSocket = second.ws;
    const originalWrites = [...ws.sent], otherWrites = [...otherSocket.sent];
    replaced(ws, 'foreign-session');
    assert.equal(f.view.cards.get('1'), first, 'a foreign session message cannot revoke the current owner');
    assert.deepEqual(ws.sent, originalWrites);
    f.document.fullscreenElement = first.screen;
    replaced(ws, first.session);
    assert.equal(f.view.cards.has('1'), false); assert.equal(first.closed, true);
    assert.equal(player.destroyed, 1); assert.equal(touch.destroyed, 1);
    assert.equal(ws.closeCount, 1); assert.deepEqual(ws.sent, originalWrites, 'no stop or touch message is sent after revocation');
    assert(first.video.cancelledFrames.includes(frame)); assert.equal(first.video.frameCallbacks.size, 0);
    assert.equal(f.document.fullscreenElement, null); assert.equal(f.getFullscreenExits(), 1);
    assert.match(f.get('multiInfo').textContent, /其他页面接管/);
    assert.equal(f.view.lastLiveStatus.get('1'), '已由其他页面接管');
    assert.equal(f.port('1').disabled, false); assert.match(f.port('1').title, /开启此设备投屏.*其他页面接管/);
    const unchangedPeer = () => {
      assert.equal(f.view.cards.get('2'), second); assert.equal(second.closed, false);
      assert.equal(second.player, otherPlayer); assert.equal(otherPlayer.destroyed, 0);
      assert.equal(second.touch, otherTouch); assert.equal(otherTouch.destroyed, 0); assert.equal(second.enabled, true);
      assert.equal(second.ws, otherSocket); assert.equal(otherSocket.closeCount, 0); assert.deepEqual(otherSocket.sent, otherWrites);
    };
    const lateCallbacks = () => {
      for (const type of ['ended', 'replaced', 'starting', 'control_enabled', 'error']) {
        oldMessage({data: JSON.stringify({type, session_id: 'session-1', cleanup_complete: true})});
      }
      oldClose(); oldError(); player.callbacks.onState('playing'); player.callbacks.onError('late error'); oldFrame();
    };
    lateCallbacks(); await tick();
    assert.equal(f.sockets.length, 2, 'replaced must never automatically reclaim the device'); unchangedPeer();
    assert.equal(first.video.frameCallbacks.size, 0);
    const fresh = await f.open('1');
    assert.notEqual(fresh, first); assert.equal(f.sockets.length, 3, 'a later explicit user request remains available');
    lateCallbacks();
    assert.equal(f.view.cards.get('1'), fresh); assert.equal(fresh.closed, false); assert.equal(fresh.enabled, true);
    assert.deepEqual(ws.sent, originalWrites); unchangedPeer();
  } finally { f.cleanup(); }
}

async function startingPromiseCannotReclaim() {
  const f = await fixture();
  try {
    const second = await f.open('2'), first = await f.open('1', false);
    const oldPlayer = first.player, oldSocket = first.ws;
    oldPlayer.startGate = deferred();
    oldSocket.emit('starting', {session_id: 'pending-offer'});
    assert.equal(oldPlayer.starts.length, 1);
    const writes = [...oldSocket.sent];
    replaced(oldSocket, 'pending-offer');
    oldPlayer.startGate.reject(Error('late offer failure')); await tick();
    assert.equal(f.view.cards.has('1'), false); assert.equal(f.sockets.length, 2);
    assert.deepEqual(oldSocket.sent, writes); assert.equal(f.view.cards.get('2'), second);
    assert.equal(second.closed, false); assert.equal(second.enabled, true);
  } finally { f.cleanup(); }
}

async function reconnectAndStopBatchStayHonest() {
  const f = await fixture();
  try {
    const first = await f.open('1'), second = await f.open('2');
    const oldSocket = first.ws, oldMessage = oldSocket.onmessage;
    await first.reconnectButton.click();
    assert.equal(first.reconnectRequested, true);
    const timer = first.stopTimer, oldTimeout = f.clock.timers.get(timer).callback;
    const writes = [...oldSocket.sent];
    replaced(oldSocket, first.session);
    assert.equal(first.reconnectRequested, false); assert.equal(first.stopTimer, null);
    assert.equal(f.clock.timers.has(timer), false); assert.deepEqual(oldSocket.sent, writes);
    oldTimeout(); oldMessage({data: JSON.stringify({type: 'ended', session_id: first.session, cleanup_complete: true})});
    assert.equal(f.sockets.length, 2); assert.equal(f.view.cards.get('2'), second);
    const fresh = await f.open('1'), freshSocket = fresh.ws, peerSocket = second.ws;
    f.controllers.management.selectDevice('1', true); f.controllers.management.selectDevice('2', true);
    assert.equal(f.get('multiStop').disabled, false); await f.get('multiStop').click();
    const batch = f.view.stopBatch, freshWrites = [...freshSocket.sent];
    assert.equal(batch.total, 2);
    replaced(freshSocket, fresh.session);
    assert.equal(batch.clean, 0); assert.equal(batch.failed, 1); assert.deepEqual([...batch.pending], ['2']);
    assert.deepEqual(freshSocket.sent, freshWrites); assert.match(f.get('multiInfo').textContent, /已确认清理 0 台，未确认 1 台/);
    peerSocket.emit('ended', {session_id: second.session, cleanup_complete: true});
    assert.equal(batch.clean, 1); assert.equal(batch.failed, 1); assert.equal(batch.pending.size, 0);
    assert.equal(f.view.stopBatch, null); assert.match(f.get('multiInfo').textContent, /已确认清理 1 台，未确认 1 台/);
    assert.equal(f.view.lastLiveStatus.get('1'), '已由其他页面接管'); assert.equal(f.sockets.length, 3);
  } finally { f.cleanup(); }
}

async function waitingRetainsStartupOwnership() {
  const f = await fixture(5);
  try {
    f.controllers.management.selectAll(true); await f.get('multiStart').click();
    assert.equal(f.view.cards.size, 3); assert.equal(f.view.launchInFlight, 3); assert.equal(f.view.launchQueue.length, 2);
    const card = f.view.cards.get('1'), socket = card.ws;
    socket.open(); waiting(socket);
    assert.match(card.stateEl.textContent, /等待旧画面完成清理/);
    assert.equal(card.session, null); assert.equal(card.player.starts.length, 0); assert.equal(card.startSettled, false);
    assert.equal(card.state, 'connecting'); assert.equal(f.view.launchInFlight, 3); assert.equal(f.sockets.length, 3);
    assert.equal(f.view.launchQueue.length, 2);
    socket.emit('starting', {session_id: 'new-owner'});
    assert.equal(card.player.starts.length, 1); assert.equal(card.session, 'new-owner');
    const message = card.stateEl.textContent; waiting(socket);
    assert.equal(card.stateEl.textContent, message, 'late waiting cannot overwrite an admitted session');
    socket.emit('init', {session_id: 'new-owner', width: 720, height: 1280, control_available: true});
    assert.equal(card.startSettled, true); assert.equal(f.view.launchQueue.length, 1); assert.equal(f.sockets.length, 4);
    assert.equal(f.view.cards.get('1'), card);
  } finally { f.cleanup(); }
}

async function unreservedRequestCanBeReplaced() {
  const f = await fixture();
  try {
    const card = await f.open('1', false), socket = card.ws;
    waiting(socket); await f.port('1').click();
    assert.equal(card.state, 'stopping');
    const message = card.stateEl.textContent, writes = [...socket.sent];
    waiting(socket); assert.equal(card.stateEl.textContent, message, 'waiting cannot undo a user stop');
    replaced(socket);
    assert.equal(card.closed, true); assert.equal(card.session, null); assert.equal(card.stopTimer, null);
    assert.equal(f.view.cards.size, 0); assert.deepEqual(socket.sent, writes);
    assert.equal(f.sockets.length, 1);
    await f.open('1'); assert.equal(f.sockets.length, 2);
  } finally { f.cleanup(); }
}

module.exports = async function liveHandoffContract() {
  await onlyCurrentOwnerCloses(); await startingPromiseCannotReclaim(); await reconnectAndStopBatchStayHonest();
  await waitingRetainsStartupOwnership(); await unreservedRequestCanBeReplaced();
  console.log('Real page handoff: current owner only, no remote stop/reclaim, honest cleanup counters, waiting and explicit restart: OK');
};
