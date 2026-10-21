/* Execute the real bulk delete/refresh click handlers with the page lock active. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('web/index.html', 'utf8');
function section(start, end) {
  const first = html.indexOf(start);
  const last = html.indexOf(end, first);
  assert(first >= 0 && last > first, 'missing page handler boundary: ' + start);
  return html.slice(first, last);
}
const locks = section('function deviceConnecting(id)', 'function applyConnectionResult(');
const deletion = section("$('bulkDelete').addEventListener", "$('newDevice').addEventListener");
const refresh = section("$('refreshAll').addEventListener", "window.addEventListener('beforeunload'");

async function verify(handlerId, suffix) {
  const initial = [
    {id: 'ready', name: 'Ready', status: 'connected'},
    {id: 'late', name: 'Becomes busy', status: 'connected'},
    {id: 'prebusy', name: 'Already projecting', status: 'connected'},
  ];
  const busy = new Set(['prebusy']);
  const handlers = new Map(), requests = [], messages = [], confirmations = [];
  let renderCount = 0, reloadCount = 0;
  const sandbox = {
    INITIAL_DEVICES: initial, BUSY: busy, encodeURIComponent,
    $(id) {
      return {addEventListener(type, fn) {
        if (type === 'click') handlers.set(id, fn);
      }};
    },
    confirm(text) { confirmations.push(text); return true; },
    render() { renderCount++; },
    message(text) { messages.push(text); },
    async load() { reloadCount++; return true; },
    async api(path, options) {
      requests.push([path, options.method]);
      // The second eligible phone starts projecting while the first awaits I/O.
      if (path.includes('/ready')) busy.add('late');
      return {json: async () => ({...initial[0], status: 'checked'})};
    },
  };
  const script = `
let loading = false, loaded = true, selected = 'ready';
let devices = INITIAL_DEVICES.map(device => ({...device}));
const managementSelected = new Set(devices.map(device => device.id));
const connectingDevices = new Set();
const multiView = {isBusyFor: id => BUSY.has(id)};
${locks}
${deletion}
${refresh}
globalThis.snapshot = () => ({
 loading, selected, devices, selectedIds: [...managementSelected]
});
`;
  vm.runInNewContext(script, sandbox, {filename: 'bulk-management-page.js'});
  assert.equal(typeof handlers.get(handlerId), 'function');
  await handlers.get(handlerId)();
  const state = sandbox.snapshot();
  assert.deepEqual(requests, [['/api/devices/ready' + suffix, handlerId === 'bulkDelete' ? 'DELETE' : 'POST']],
    'page-level loading cannot block an eligible batch target; new busy targets are skipped');
  assert.equal(state.loading, false, 'the page lock must be released');
  assert.equal(reloadCount, 1, 'one final refresh');
  assert(renderCount >= 2, 'disabled controls redraw before and after the operation');
  assert.equal(confirmations.length, handlerId === 'bulkDelete' ? 1 : 0);
  if (handlerId === 'bulkDelete') {
    assert.equal(state.selected, null);
    assert.deepEqual(state.selectedIds, ['late', 'prebusy']);
    assert(messages.some(message => message.includes('已删除 1 台')));
    assert(messages.some(message => message.includes('其他未删除 1 台')));
  } else {
    assert.equal(state.devices[0].status, 'checked');
    assert(messages.some(message => message.includes('已检查 1 台')));
    assert(messages.some(message => message.includes('其他失败/跳过 1 台')));
  }
}

(async () => {
  await verify('bulkDelete', '');
  await verify('refreshAll', '/refresh');
  console.log('Bulk delete/refresh: page lock does not self-skip; per-device busy state is rechecked: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
