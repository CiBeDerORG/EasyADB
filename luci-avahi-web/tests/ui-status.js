'use strict';
// LuCI simulation: responsive cards, explicit refresh only, actions refresh
// the view, package confirmation required, no page-initiated mDNS scan.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync('htdocs/luci-static/resources/view/avahi-web/overview.js', 'utf8');
assert.ok(!source.includes("'require poll'") && !source.includes('poll.add('),
    'The page must not schedule background status polling');
let scanCalls = 0, modal;
let running = { avahi: true, dbus: true, umdns: true };
let browseInstalled = false;
let packageOutput;
function inventory() {
    return [
        'avahi-dbus-daemon\tinstalled\t1.0',
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
    if (program.includes('luci-avahi-auth')) return Promise.resolve({code:0,stdout:'state=absent\n'});
    if (args[0] === 'status') return Promise.resolve({code:0,stdout:status()});
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
    walk(page,n=>{ if(n.props && typeof n.props.style === 'string' && n.props.style.includes('grid-template-columns')) cards.push(n); });
    assert.equal(cards.length,1,'Component cards should use a responsive grid');
    assert.equal(buttons(page,'补齐安装').length,1,'Partial Avahi install should be repairable');
    assert.ok(buttons(page,'补齐安装')[0].disabled,'Other active mDNS daemon should block an unsafe package operation');
    assert.equal(buttons(page,'手动刷新组件状态').length,1);
    assert.equal(scanCalls,0);
    // There is no timer. Explicit refresh must update displayed process state.
    const before=calls.length;
    running.umdns=false;
    await buttons(page,'手动刷新组件状态')[0].props.click();
    assert.equal(calls.length,before+2,'Explicit refresh should read status and packages only');
    assert.ok(!text(page).includes('可能存在 mDNS'),'Conflict warning must clear');
    assert.ok(!buttons(page,'补齐安装')[0].disabled,'Repair should become available after stopping conflicting mDNS daemon');
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
    await modalConfirm();
    assert.equal(browseInstalled,true);
    assert.ok(text(page).includes('安装完整'),'Card should refresh after installation');
    assert.equal(buttons(page,'补齐安装').length,0);
    assert.equal(scanCalls,0);
    console.log('Manual-only Chinese card interaction test passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
