/* Real inventory drawer module and page markup; no inactivity timer. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {createDOM, createClock} = require('./helpers/page-fixture.cjs');

(async () => {
  const {createInventoryDrawer} = await import('../web/shared/ui/inventory-drawer.js');
  const source = fs.readFileSync('web/shared/ui/inventory-drawer.js', 'utf8');
  assert(!source.includes('setTimeout('), 'management never auto-collapses on inactivity');
  assert(!source.includes('inventoryHovered'), 'hover does not govern closure');
  const {document, get, storage} = createDOM();
  const clock = createClock();
  clock.install();
  try {
    const controller = createInventoryDrawer({documentRef: document, storage});
    const drawer = get('inventoryDrawer'), panel = get('inventoryPanel');
    const toggle = get('inventoryToggle'), slider = get('inventoryOpacity');
    const inside = document.createElement('input'), outside = document.createElement('div');
    panel.append(inside);
    const dialog = document.querySelector('dialog');
    const modalContent = document.createElement('input');
    dialog.append(modalContent);
    const press = target => document.fire('pointerdown', {target});
    const expanded = () => drawer.classList.contains('is-open');
    assert.equal(document.eventOptions.get('pointerdown')[0].capture, true,
      'outside presses are captured before other actions');
    assert.equal(expanded(), false);
    assert.equal(panel.inert, true);
    assert.equal(slider.value, '20');
    assert.equal(panel.css['--inventory-panel-opacity'], '0.8');
    await press(outside);
    assert.equal(expanded(), false);
    await toggle.click();
    assert.equal(expanded(), true);
    assert.equal(panel.inert, false);
    assert.equal(toggle.attrs['aria-expanded'], 'true');
    for (const target of [inside, panel, toggle]) await press(target);
    assert.equal(expanded(), true, 'controls, panel and handle are all inside');
    await panel.fire('input');
    await panel.fire('wheel');
    await drawer.fire('pointerleave');
    clock.advance(60000);
    assert.equal(expanded(), true, 'input, scroll, pointer leave and elapsed time never dismiss');
    assert.equal(clock.scheduled.length, 0, 'drawer creates no timer');
    await press(outside);
    assert.equal(expanded(), false);
    assert.equal(panel.inert, true);
    assert.equal(toggle.attrs['aria-expanded'], 'false');
    await toggle.click();
    dialog.showModal();
    await press(modalContent);
    assert.equal(expanded(), true, 'editing dialog protects ordinary outside presses');
    controller.collapse(true);
    assert.equal(expanded(), false, 'explicit projection collapse remains permitted');
    controller.expand();
    dialog.close();
    await press(outside);
    assert.equal(expanded(), false);
    await toggle.click();
    slider.value = '45';
    await slider.fire('input');
    assert.equal(get('inventoryOpacityValue').textContent, '45%');
    assert.equal(panel.css['--inventory-panel-opacity'], '0.55');
    assert.equal(storage.getItem('easyadb.inventory-transparency'), '45');
    for (const [raw, expected] of [['100', '60'], ['-12', '0'], ['23', '25'], ['oops', '20']]) {
      slider.value = raw;
      await slider.fire('input');
      assert.equal(slider.value, expected, 'transparency is bounded and quantized');
    }
    await toggle.click();
    assert.equal(expanded(), false);
    await toggle.click();
    document.fullscreenElement = {id: 'phone-stream'};
    await document.fire('fullscreenchange');
    assert(document.body.classList.contains('video-fullscreen-active'));
    assert.equal(toggle.disabled, true);
    assert.equal(expanded(), false);
    controller.expand();
    assert.equal(expanded(), false, 'fullscreen prevents opening');
    document.fullscreenElement = null;
    await document.fire('fullscreenchange');
    assert(!document.body.classList.contains('video-fullscreen-active'));
    assert.equal(toggle.disabled, false);
    assert.equal(expanded(), false, 'leaving fullscreen restores only the collapsed handle');
    await toggle.click();
    assert.equal(expanded(), true);
  } finally {
    clock.restore();
  }
  for (const initial of ['55', 'invalid']) {
    const {document, get, storage} = createDOM();
    storage.setItem('easyadb.inventory-transparency', initial);
    createInventoryDrawer({documentRef: document, storage});
    assert.equal(get('inventoryOpacity').value, initial === '55' ? '55' : '20');
  }
  {
    const {document, get} = createDOM();
    const storage = {getItem() {throw Error('blocked');}, setItem() {throw Error('blocked');}};
    createInventoryDrawer({documentRef: document, storage});
    assert.equal(get('inventoryOpacity').value, '20', 'storage denial leaves drawer controls usable');
  }
  console.log('Inventory drawer module: outside click, modal protection, no timer, fullscreen and opacity: OK');
})().catch(error => {console.error(error); process.exitCode = 1;});
