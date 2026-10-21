/* The actual page factory, model, list view and action controllers. */
'use strict';
const assert = require('node:assert/strict');
const {createPageFixture, findAll, until} = require('./helpers/page-fixture.cjs');

(async () => {
  const devices = [
    {id: 'b', name: 'Pending', group_name: 'Zulu', ip: '10.0.0.2', port: 5555,
      status: 'connecting', active_serial: null, selected_serial: '10.0.0.2:5555',
      selected_route: 'mesh', model: 'Phone B', android_version: '12',
      lan_ip: '192.168.1.2', temp_ip: '10.0.2.2', connect_failed: true},
    {id: 'a', name: 'Ready', group_name: 'Zulu', ip: '10.0.0.1', port: 5555,
      status: 'connected', active_serial: '10.0.0.1:5555', selected_serial: '10.0.0.1:5555',
      selected_route: 'mesh', temp_ip: null},
    {id: 'c', name: 'Unassigned', group_name: null, ip: '10.0.0.3', port: 5555,
      status: 'idle', active_serial: null, selected_serial: '10.0.0.3:5555', selected_route: 'lan'},
  ];
  const groups = [{name: 'Zulu', ip_prefix: '10.0.0.*', discovery_configured: true},
    {name: 'Empty', ip_prefix: '10.0.8.*', discovery_needs_password: true}];
  const f = await createPageFixture({devices, groups});
  try {
    f.state.selectedDeviceId = 'a';
    f.state.selectedDeviceIds.add('a');
    f.state.pendingDeviceIds.add('b');
    f.state.groupOpen.set('named:Empty', false);
    f.page.render();
    assert.equal(f.requests.length, 0, 'rendering never requests metadata, ADB or discovery');
    assert.equal(f.get('count').textContent, '3 台设备 · 3 个分组');
    const query = predicate => findAll(f.get('devices'), predicate);
    const checkboxes = () => query(node => node.tagName === 'INPUT' && node.type === 'checkbox');
    const buttons = query(node => node.tagName === 'BUTTON');
    assert.equal(buttons.filter(node => ['连接', '删除'].includes(node.textContent.trim())).length, 0,
      'device rows have no separate connect or delete button');
    const items = query(node => node.classList.contains('item'));
    assert.equal(items.length, devices.length);
    for (const item of items) {
      const checkbox = findAll(item, node => node.type === 'checkbox')[0];
      const device = devices.find(row => row.id === checkbox.value);
      const title = findAll(item, node => node.className === 'device-title')[0];
      const portWrap = findAll(item, node => node.className === 'device-port-wrap')[0];
      const projectors = findAll(item, node => node.className === 'projector');
      assert.equal(projectors.length, 1, device.name + ' has exactly one projection port');
      assert.equal(projectors[0].parentNode, portWrap, 'projection control stays inside its port wrapper');
      assert.equal(portWrap.parentNode, title);
      const edits = findAll(item, node => node.className === 'device-edit-icon');
      assert.equal(edits.length, 1);
      assert.equal(title.children.includes(edits[0]), false, 'device edit is not a direct title child');
      const meshRow = edits[0].parentNode;
      assert(meshRow.classList.contains('address-row'));
      const meshTarget = meshRow.children.find(node => node.className === 'address-target');
      assert.equal(meshTarget.textContent, '组网 IP：' + device.ip,
        'device edit remains attached to the mesh address, including devices with LAN/temp rows');
      const tooltips = findAll(item, node => node.className === 'device-model-tooltip');
      assert.equal(tooltips.length, device.model || device.android_version ? 1 : 0);
      const tooltip = tooltips[0];
      if (tooltip) {
        assert.deepEqual(tooltip.children.map(node => node.textContent), [
          ...(device.model ? ['型号：' + device.model] : []),
          ...(device.android_version ? ['Android：' + device.android_version] : []),
        ], 'model and Android metadata occur once in the name tooltip');
      }
      assert.equal(findAll(item, node => ['device-model', 'device-android', 'adb-badge'].some(
        className => node.classList.contains(className))).length, 0,
      'retired standalone metadata and ADB badges do not return');
      const ordinaryText = findAll(item, node => node.children.length === 0 &&
        !tooltip?.contains(node) && !portWrap.contains(node)).map(node => node.textContent.trim());
      assert(!ordinaryText.some(text => device.model && text.includes(device.model)),
        'model is not repeated outside its tooltip');
      assert(!ordinaryText.some(text => /^Android(?:\s|：|:)/.test(text)),
        'Android version is not repeated as a standalone line');
      assert(!ordinaryText.some(text => /^ADB\s*(?:已连接|连接失败|未连接)/.test(text)),
        'ADB status remains on the port control instead of an extra device row');
    }
    assert.deepEqual(checkboxes().map(node => node.value), ['a', 'b', 'c'],
      'the real page uses connected-first grouping');
    assert.equal(checkboxes().find(node => node.value === 'b').disabled, true);
    const selected = f.state.selectedDeviceIds;
    const ready = checkboxes().find(node => node.value === 'a');
    ready.checked = false;
    const oldList = f.get('devices').children[0];
    await ready.fire('change');
    assert.equal(selected.has('a'), false);
    assert.equal(f.state.selectedDeviceIds, selected, 'management owns the shared selection Set');
    assert.equal(f.liveOptions.getBatchSelection(), selected, 'projection reads that same selection');
    assert.notEqual(f.get('devices').children[0], oldList, 'selection invokes the production redraw');
    const sections = query(node => node.tagName === 'DETAILS');
    assert.equal(sections.length, 3);
    assert.equal(sections[1].open, false);
    sections[1].open = true;
    await sections[1].fire('toggle');
    assert.equal(f.state.groupOpen.get('named:Empty'), true);
    const discovery = () => query(node => node.classList.contains('group-discovery') &&
      node.textContent === '立即发现 ADB');
    assert.equal(discovery().length, 1);
    assert.equal(discovery()[0].disabled, true, 'a group with a connecting device cannot scan yet');
    await discovery()[0].click();
    assert.equal(f.requests.length, 0);
    const pendingName = query(node => node.className === 'item-name' &&
      node.attrs['aria-label']?.startsWith('Pending'))[0];
    assert.equal(pendingName.attrs['aria-label'], 'Pending，设备型号 Phone B，Android 12');
    assert.equal(pendingName.tabIndex, 0);
    const settings = query(node => node.className === 'projection-settings-edit');
    assert.equal(settings.length, 3);
    assert.equal(settings.find(node => node.title.includes('Pending')).disabled, true);
    const readySettings = settings.find(node => node.title.includes('Ready'));
    assert.equal(readySettings.disabled, false);
    await readySettings.click();
    assert.equal(f.live.openedSettings[0].id, 'a');

    f.state.pendingDeviceIds.clear();
    f.page.render();
    f.requestOptions.handler = async path => {
      if (path === '/api/groups/Zulu/discovery/scan') return {json: async () => ({endpoints: []})};
      assert(['/api/devices', '/api/groups'].includes(path));
      return {json: async () => path === '/api/devices' ? f.data.devices : f.data.groups};
    };
    await discovery()[0].click();
    await until(() => f.state.scanningGroupNames.size === 0);
    assert.equal(f.requests.filter(entry => entry.path.endsWith('/discovery/scan')).length, 1,
      'the visible action reaches the actual group scan controller exactly once');
    assert(f.toasts.some(toast => toast.key === 'discovery:Zulu'));
    assert.equal(f.bootstrap(), f.page, 'repeated initialization keeps a single page owner');
    assert.deepEqual(f.ports, {multi: 1, group: 1, lab: 1});
  } finally {f.dispose();}
  console.log('Device list: real page grouping, rendered controls, selection, busy state and discovery: OK');
})().catch(error => {console.error(error); process.exitCode = 1;});
