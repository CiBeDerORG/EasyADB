'use strict';
// LuCI simulation: responsive cards, explicit refresh only, actions refresh
// the view, package confirmation required, no page-initiated mDNS scan.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync('htdocs/luci-static/resources/view/avahi-web/overview.js', 'utf8');
assert.ok(!source.includes("'require poll'") && !source.includes('poll.add('),
    'The page must not schedule background status polling');
let scanCalls = 0, modal, applyCalls = 0, authCalls = 0, failStatusOnce = false;
let running = { avahi: true, dbus: true, umdns: true };
let browseInstalled = false;
let packageOutput;
function inventory() {
    return [
        'avahi-dbus-daemon\tinstalled\tAvahi is an mDNS/DNS-SD implementation (verbose DESCRIPTION, not a version)',
        'avahi-utils\t' + (browseInstalled ? 'installed\t1.0' : 'absent\t-'),
        'dbus\tinstalled\t1.0',
        'umdns\tinstalled\t1.0'
    ].join('\n');
}
function element(tag, attrs, children) {
    if (Array.isArray(attrs) || typeof attrs === 'string' || attrs == null) {
        children = attrs;
        attrs = {};
    }
    const node = { tag, props: attrs || {}, children: children == null ? [] :
        Array.isArray(children) ? children : [children], disabled: !!(attrs && attrs.disabled) };
    node.replaceChildren = function(...args) {
        assert.ok(args.every(x => !Array.isArray(x)), 'replaceChildren expects individual DOM children');
        this.children = args;
    };
    node.appendChild = function(child) { this.children.push(child); };
    return node;
}
function walk(value, visit) {
    if (Array.isArray(value)) return value.forEach(x => walk(x,visit));
    if (value == null || typeof value !== 'object') return;
    if (value.tag) visit(value);
    walk(value.children,visit);
}
function text(value) {
    if (Array.isArray(value)) return value.map(text).join(' ');
    if (value == null) return '';
    if (typeof value !== 'object') return String(value);
    return text(value.children);
}
function buttons(page, label) {
    const found = [];
    walk(page, n => { if (n.tag === 'button' && text(n) === label) found.push(n); });
    return found;
}
function status() {
    return [
        'installed=' + (browseInstalled ? 'yes' : 'no'),
        'running=' + (running.avahi ? 'yes' : 'no'),
        'dbus=' + (running.dbus ? 'yes' : 'no'),
        'umdns=' + (running.umdns ? 'yes' : 'no'),
        'avahi-daemon-bin=yes',
        'avahi-browse-bin=' + (browseInstalled ? 'yes' : 'no'),
        'dbus-bin=yes','umdns-bin=yes',
        'avahi-daemon-init=yes','dbus-init=yes','umdns-init=yes',
        'avahi-daemon-enabled=yes','dbus-enabled=yes','umdns-enabled=yes'
    ].join('\n');
}
const calls = [];
const rpc = { exec: function(program,args) {
    calls.push([program,args]);
    if (program.includes('luci-avahi-scan')) {
        if (args[0] === 'scan') scanCalls++;
        assert.equal(args[0],'last','Only NAS should trigger scans');
        return Promise.resolve({code:1,stderr:'No previous result'});
    }
    if (program.includes('luci-avahi-auth')) {
        if (args[0] === 'status') return Promise.resolve({code:0,stdout:'state=absent\n'});
        authCalls++;
        return Promise.resolve({code:1,stderr:'Refused by mock'});
    }
    if (args[0] === 'status') {
        if (failStatusOnce) {
            failStatusOnce = false;
            return Promise.resolve({code:1,stderr:'模拟状态读取失败'});
        }
        return Promise.resolve({code:0,stdout:status()});
    }
    if (args[0] === 'service') {
        if (args[1] === 'umdns-stop') running.umdns=false;
        else if (args[1] === 'stop') running.avahi=false;
        else throw new Error('Unexpected service action ' + args[1]);
        return Promise.resolve({code:0,stdout:'ok'});
    }
    if (args[0] === 'package') {
        if (args[1] === 'list') return Promise.resolve({code:0,stdout:inventory()});
        if (args[1] === 'plan') return Promise.resolve({code:0,stdout:'SIMULATED: install avahi-utils'});
        if (args[1] === 'apply' && args[2] === 'install' && args[3] === 'avahi') {
            applyCalls++;
            browseInstalled = true;
            return Promise.resolve({code:0,stdout:'Installed avahi-utils'});
        }
    }
    throw new Error('Unexpected invocation ' + args.join(' '));
} };
const view = new Function('view','fs','ui','E','_',source)(
    {extend:x=>x},rpc,{
        showModal(title,children) { modal = element('modal', {title},children); },
        hideModal() { modal=undefined; }
    },element,x=>x
);
function modalConfirm() {
    assert.ok(modal, 'Action should require confirmation');
    const confirm = buttons(modal, '确认操作').concat(buttons(modal,'确认执行'));
    assert.equal(confirm.length,1);
    return confirm[0].props.click();
}
(async function() {
    const data = await view.load();
    assert.equal(calls.length,4,'Page load should only query fixed initial state');
    const page = view.render(data);
    for(const needle of ['组件与服务管理','部分安装','avahi-utils','缺少软件包','可能存在 mDNS','NAS 接口授权','最近一次 NAS 扫描'])
        assert.ok(text(page).includes(needle), 'Missing UI text '+needle);
    const cards = [];
    walk(page,n=>{ if(n.props && typeof n.props.style === 'string' && n.props.style.includes('grid-template-columns:repeat(auto-fit,')) cards.push(n); });
    assert.equal(cards.length,1,'Component cards should use a responsive grid');
    const componentCards = [];
    walk(page,n=>{ if (String(n.props?.class || '').includes('avahi-component-card')) componentCards.push(n); });
    assert.equal(componentCards.length,3,'All three packages must occupy sibling responsive cards');
    assert.ok(componentCards.every(c=>!String(c.props.class).includes('cbi-section')),
        'Avoid LuCI cbi-section CSS that changes the card layout');
    assert.ok(!text(page).includes('verbose DESCRIPTION'), 'Never render apk verbose descriptions as installed versions');
    assert.ok(text(page).includes('版本未知'), 'Malformed version should degrade to a short neutral value');
    assert.ok(!String(cards[0].props.style).includes('minmax(min(100%,320px)'),
        'The responsive layout must be bounded by compact cards');
    assert.equal(buttons(page,'补齐安装').length,1,'Partial Avahi install should be repairable');
    assert.ok(!buttons(page,'补齐安装')[0].disabled,'Installing only the missing avahi-utils must not require stopping umdns');
    assert.equal(buttons(page,'手动刷新组件状态').length,1);
    assert.equal(scanCalls,0);
    assert.ok(text(page).includes('另一项 mDNS 服务已启用开机自启'),
        'Conflicting boot enables must be explained rather than silently accepted');
    // A failed explicit refresh must report its error and release the UI lock.
    failStatusOnce = true;
    await buttons(page,'手动刷新组件状态')[0].props.click();
    assert.ok(text(page).includes('状态刷新失败：模拟状态读取失败'));
    assert.ok(!buttons(page,'手动刷新组件状态')[0].disabled);
    // There is no timer. Explicit refresh must update displayed process state.
    const before=calls.length;
    running.umdns=false;
    await buttons(page,'手动刷新组件状态')[0].props.click();
    assert.equal(calls.length,before+2,'Explicit refresh should read status and packages only');
    assert.ok(!text(page).includes('可能存在 mDNS'),'Conflict warning must clear');
    assert.ok(!buttons(page,'补齐安装')[0].disabled,'Repair must remain available after umdns stops');
    // Stopping Avahi should be confirmed and followed by status refresh.
    const stop=buttons(page,'停止').find(b=>!b.disabled);
    assert.ok(stop,'Running Avahi can be stopped');
    stop.props.click();
    assert.ok(running.avahi,'Stop must wait for confirmation');
    await modalConfirm();
    assert.equal(running.avahi,false);
    assert.ok(text(page).includes('○ 已停止'));
    // Installing Avahi's missing utility requires simulation and explicit approval.
    const repair=buttons(page,'补齐安装')[0];
    assert.ok(!repair.disabled);
    await repair.props.click();
    assert.equal(browseInstalled,false,'Preview must not apply installation');
    // LuCI modal can be dismissed via Escape/close, not just the Cancel button.
    modal = undefined;
    assert.ok(!buttons(page,'补齐安装')[0].disabled,'Dismissed preview must never leave a stale busy state');
    await buttons(page,'补齐安装')[0].props.click();
    const confirm = buttons(modal,'确认执行')[0];
    const applied = confirm.props.click();
    const repeated = confirm.props.click();
    await Promise.all([applied,repeated]);
    assert.equal(applyCalls,1,'One modal may only submit once');
    assert.equal(browseInstalled,true);
    assert.ok(text(page).includes('安装完整'),'Card should refresh after installation');
    assert.equal(buttons(page,'补齐安装').length,0);
    assert.equal(scanCalls,0);
    // Failed authorization action must not leave account controls locked.
    buttons(page,'创建专用账号')[0].props.click();
    await modalConfirm();
    assert.equal(authCalls,1);
    assert.ok(!buttons(page,'创建专用账号')[0].disabled,'Failed account request should release its lock');
    console.log('Manual-only Chinese card interaction test passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
