import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  LiveSessionController,
  createLiveSessionController,
} from '../web/features/live/live-session-controller.js';

const timers = new Map();
const canceled = [];
let timerId = 0;
let current = null;
const create = (id) =>
  createLiveSessionController({
    deviceId: id,
    serial: '10.10.0.1:5555',
    isCurrent: () => current === id,
    scheduleTimeout(fn, durationMs) {
      assert.equal(durationMs, 40000);
      timers.set(++timerId, fn);
      return timerId;
    },
    cancelTimeout(idToCancel) {
      canceled.push(idToCancel);
      timers.delete(idToCancel);
    },
  });
current = 'first';
const first = create('first');
assert(first instanceof LiveSessionController);
assert.equal(first.active, true);
assert(first.assignSession('session-one'));
assert(first.assignSession('session-one'));
assert.equal(first.assignSession('session-two'), false);
assert.equal(first.session, 'session-one');
const originalMeter = { totalBytes: 12 };
const originalMetrics = { samples: [{ fps: 24 }] };
assert(first.attachDiagnostics(originalMeter, originalMetrics));
assert.equal(first.attachDiagnostics({}, {}), false, 'one metrics owner per card');
assert.equal(first.meter, originalMeter);
assert.equal(first.metrics, originalMetrics);

const destroyed = [];
const socket = (name) => ({
  name,
  readyState: 1,
  sent: [],
  send(data) {
    this.sent.push(data);
  },
  close() {
    destroyed.push(name);
  },
});
const oldSocket = socket('old');
assert(first.bindSocket(oldSocket));
assert(first.ownsSocket(oldSocket));
assert(first.acceptsMessage(oldSocket, { session_id: 'session-one' }));
assert.equal(first.acceptsMessage(oldSocket, { session_id: 'foreign' }), false);
assert.equal(first.acceptsMessage(socket('other'), { session_id: 'session-one' }), false);
assert.equal(first.bindSocket(socket('rejected')), false);
assert(destroyed.includes('rejected'));

let playerDestroyed = 0;
let touchDestroyed = 0;
assert(first.bindPlayer({ destroy: () => playerDestroyed++ }));
assert(first.bindTouch({ destroy: () => touchDestroyed++ }));
assert.equal(first.bindPlayer({ destroy: () => playerDestroyed++ }), false);
first.armStopTimeout(() => assert.fail('superseded timeout'), 40000);
const originalTimer = first.stopTimer;
first.armStopTimeout(() => assert.fail('old timeout must not fire'), 40000);
const currentTimer = first.stopTimer;
assert(canceled.includes(originalTimer));
first.frameCallback = 75;

current = 'second';
const next = create('second');
assert.equal(first.active, false);
assert.equal(first.ownsSocket(oldSocket), false);
assert.equal(first.assignSession('late'), false);
assert.equal(
  first.armStopTimeout(() => {}, 40000),
  false,
);
timers.get(currentTimer)(); // Late timeout from an old session has no effect.
assert.equal(next.closed, false);
assert.equal(next.session, null);
const nextMeter = { totalBytes: 0 };
const nextMetrics = { samples: [] };
assert(next.attachDiagnostics(nextMeter, nextMetrics));
assert.notEqual(first.metrics, next.metrics, 'diagnostics must not be shared across sessions');
let frameCanceled = null;
assert(
  first.dispose({
    clean: false,
    openSocketState: 1,
    video: { cancelVideoFrameCallback: (id) => (frameCanceled = id) },
  }),
);
assert.equal(frameCanceled, 75);
assert.deepEqual(oldSocket.sent, ['stop']);
assert(destroyed.includes('old'));
assert.equal(playerDestroyed, 2);
assert.equal(touchDestroyed, 1);
assert.equal(first.ws, null);
assert.equal(first.player, null);
assert.equal(first.touch, null);
assert.equal(first.stopTimer, null);
assert.equal(first.metrics, originalMetrics, 'summary remains readable only until old card is released');
assert.equal(next.metrics, nextMetrics, 'new session metrics are untouched');
assert.equal(first.dispose({ clean: true, openSocketState: 1 }), false);
assert.equal(next.closed, false);

const nextSocket = socket('next');
assert(next.bindSocket(nextSocket));
assert(next.assignSession('session-two'));
assert.equal(next.acceptsMessage(oldSocket, { session_id: 'session-two' }), false);
assert(next.dispose({ clean: true, openSocketState: 1 }));
assert.deepEqual(nextSocket.sent, []);
assert(destroyed.includes('next'));

const multi = readFileSync(new URL('../web/m2-multi.js', import.meta.url), 'utf8');
const main = readFileSync(new URL('../web/app/main.js', import.meta.url), 'utf8');
assert.match(multi, /createSessionController=event\.detail\?\.createLiveSessionController/);
assert.match(multi, /card\.sessionController=controller/);
assert.match(multi, /controller\.attachDiagnostics\(card\.meter,card\.metrics\)/);
assert.match(multi, /card\.sessionController\.dispose\(/);
assert.match(multi, /this\.cards\.get\(card\.id\)!==card/);
assert.match(main, /createLiveSessionController,/);
console.log('V4-03 per-device ownership and stale session regression: OK');
