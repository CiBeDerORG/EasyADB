/* Execute the production toast module against the real page host. */
'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const {createDOM, createClock} = require('./helpers/page-fixture.cjs');

(async () => {
  const {createToastController} = await import('../web/shared/ui/toast.js');
  const {document, window, get, html} = createDOM();
  const css = fs.readFileSync('web/assets/legacy-page.css', 'utf8');
  const discovery = fs.readFileSync('web/features/devices/group-dialog-controller.js', 'utf8');
  assert(!html.includes('id="message"'));
  assert(html.indexOf('id="toastHost"') > html.indexOf('</main>'),
    'toast host remains outside the transparent management drawer');
  assert(css.includes('.toast-host{position:fixed;'));
  assert(!discovery.includes('/discovery/last'), 'history is never replayed as a fresh notification');
  const clock = createClock();
  clock.install();
  const host = get('toastHost');
  const toast = createToastController({host, documentRef: document, windowRef: window});
  const message = (text, kind = '') => toast.showToast(text, {kind});
  try {
    message('批量连接中', 'ok');
    assert.equal(host.children.length, 1);
    const first = host.children[0];
    assert.equal(first.attrs.role, 'status');
    assert.equal(first.children[0].textContent, '批量连接中');
    assert.equal(clock.timers.size, 1);
    clock.advance(4000);
    await first.fire('pointerenter');
    assert.equal(clock.timers.size, 0);
    clock.advance(30000);
    assert.equal(host.children.length, 1, 'hover holds a toast past ten seconds');
    await first.fire('pointerleave');
    clock.advance(5999);
    assert.equal(host.children.length, 1);
    clock.advance(1);
    assert.equal(host.children.length, 0, 'resume retains the original six remaining seconds');

    message('进行中');
    const replaced = host.children[0];
    message('连接完成', 'ok');
    assert.equal(host.children.length, 1, 'progress replaces its existing status notification');
    assert.equal(host.children[0].children[0].textContent, '连接完成');
    await replaced.children[1].fire('click');
    await replaced.fire('pointerleave');
    assert.equal(host.children.length, 1, 'old close and pointer callbacks cannot dismiss a replacement');

    const rich = document.createElement('div');
    rich.className = 'group-discovery-status';
    const row = document.createElement('div');
    row.className = 'discovery-endpoint skipped';
    rich.append(row);
    const scan = toast.showToast(rich, {key: 'discovery:上海', kind: 'ok'});
    assert.equal(host.children.length, 2, 'status and independent discovery details coexist');
    assert.equal(scan.children[0].children[0], rich);
    assert.equal(rich.children[0].className, 'discovery-endpoint skipped');
    await scan.fire('pointerenter');
    window.selection = {isCollapsed: false, anchorNode: row, focusNode: row};
    await document.fire('selectionchange');
    await scan.fire('pointerleave');
    clock.advance(25000);
    assert(host.children.includes(scan), 'selected result text remains after the pointer leaves');
    window.selection = {isCollapsed: true};
    await document.fire('selectionchange');
    clock.advance(10000);
    assert(!host.children.includes(scan), 'clearing selection resumes the remaining lifetime');

    const focused = message('可聚焦提示');
    await focused.fire('focusin');
    clock.advance(12000);
    assert(host.children.includes(focused), 'keyboard focus pauses expiry');
    await focused.fire('pointerenter');
    await focused.fire('focusout');
    clock.advance(12000);
    assert(host.children.includes(focused), 'hover continues to hold after focus leaves');
    await focused.fire('pointerleave');
    clock.advance(10000);
    assert(!host.children.includes(focused));

    const failed = toast.showToast('发现失败', {key: 'discovery:上海', kind: 'error'});
    assert.equal(failed.attrs.role, 'alert');
    await failed.children[1].fire('click');
    assert(!host.children.includes(failed), 'manual dismissal is immediate');
    message('最后一条');
    toast.dismissToast('status');
    assert.equal(host.children.length, 0);
    assert.equal(clock.timers.size, 0);
    message('清理');
    toast.dispose();
    assert.equal(host.children.length, 0);
    assert.equal(clock.timers.size, 0);
    assert.equal(document.events.has('selectionchange'), false);
  } finally {
    toast.dispose();
    clock.restore();
  }
  console.log('Global toast module: lifetime, hover/focus/selection, replacement, rich results and cleanup: OK');
})().catch(error => {console.error(error); process.exitCode = 1;});
