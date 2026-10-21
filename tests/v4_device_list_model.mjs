import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildDeviceGroups, hasConnectedAdb } from '../web/features/devices/device-list-model.js';

const connected = {
  id: 'connected',
  name: 'Connected',
  group_name: 'Zulu',
  status: 'connected',
  selected_serial: '10.0.0.1:5555',
  active_serial: '10.0.0.1:5555',
  connect_failed: false,
};
assert.equal(hasConnectedAdb(connected), true);
assert.equal(hasConnectedAdb({ ...connected, connect_failed: true }), false);
assert.equal(hasConnectedAdb({ ...connected, active_serial: '10.0.0.2:5555' }), false);
assert.equal(hasConnectedAdb({ ...connected, status: 'connecting' }), false);
assert.equal(hasConnectedAdb(null), false);

const devices = [
  { ...connected, id: 'offline', name: 'Offline', status: 'error', active_serial: null },
  { ...connected },
  { ...connected, id: 'other', group_name: 'Alpha', status: 'idle', active_serial: null },
  { ...connected, id: 'loose', group_name: null, status: 'idle', active_serial: null },
];
const originalOrder = devices.map((device) => device.id);
const groups = [
  { name: 'Alpha', ip_prefix: '10.0.1.*', discovery_configured: true },
  { name: 'Zulu', ip_prefix: '10.0.0.*', discovery_needs_password: true },
  { name: 'Empty', ip_prefix: null },
];
const { grouped, keys } = buildDeviceGroups(devices, groups);
assert.deepEqual(keys, ['named:Zulu', 'named:Alpha', 'named:Empty', 'ungrouped']);
assert.deepEqual(
  grouped.get('named:Zulu').items.map((device) => device.id),
  ['connected', 'offline'],
);
assert.equal(grouped.get('named:Alpha').discovery_configured, true);
assert.equal(grouped.get('named:Zulu').discovery_needs_password, true);
assert.equal(grouped.get('named:Empty').items.length, 0);
assert.equal(grouped.get('ungrouped').title, '未分组');
assert.deepEqual(
  devices.map((device) => device.id),
  originalOrder,
  'display sorting cannot reorder batch input',
);

const view = readFileSync(
  new URL('../web/features/devices/device-management-view.js', import.meta.url),
  'utf8',
);
const pageController = readFileSync(
  new URL('../web/app/page-controller.js', import.meta.url),
  'utf8',
);
assert.match(
  view,
  /import \{ buildDeviceGroups, hasConnectedAdb \} from '\.\/device-list-model\.js'/,
);
assert.match(view, /buildDeviceGroups\(state\.devices, state\.groups\)/);
assert.match(pageController, /renderDeviceManagement\(/);
assert.doesNotMatch(pageController, /buildLegacyDeviceGroups|frontendModules/);
console.log('V4-05 single device grouping model: OK');
