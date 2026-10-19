'use strict';
// Standalone LuCI view smoke test: verify state-aware rendering, no NAS scan,
// and background polling of status without a physical OpenWrt router.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync('htdocs/luci-static/resources/view/avahi-web/overview.js', 'utf8');
let scanCalls = 0, pollFunction;
let running = { avahi: true, dbus: true, umdns: true };
function element(tag, attrs, children) {
    if (Array.isArray(attrs) || typeof attrs === 'string' || attrs == null) {
        children = attrs;
        attrs = {};
    }
    const node = { tag, props: attrs || {}, children: children == null ? [] :
        Array.isArray(children) ? children : [children], disabled: !!(attrs && attrs.disabled) };
    node.replaceChildren = function(...args) {
        assert.ok(args.every(x => !Array.isArray(x)), 'replaceChildren must receive DOM nodes, not an array argument');
        this.children = args;
    };
    node.appendChild = function(child) { this.children.push(child); };
    return node;
}
function walk(value, visit) {
    if (Array.isArray(value)) return value.forEach(x => walk(x, visit));
    if (value == null || typeof value !== 'object') return;
    if (value.tag) visit(value);
    walk(value.children, visit);
}
function text(value) {
    if (Array.isArray(value)) return value.map(text).join(' ');
    if (value == null) return '';
    if (typeof value !== 'object') return String(value);
    return text(value.children);
}
const packageOutput = [
    'avahi-dbus-daemon\tinstalled\t1.0',
    'avahi-utils\tabsent\t-',
    'dbus\tinstalled\t1.0',
    'umdns\tinstalled\t1.0'
].join('\n');
function statusOutput() {
    return [
        'installed=no', 'running=' + (running.avahi ? 'yes' : 'no'),
        'dbus=' + (running.dbus ? 'yes' : 'no'),
        'umdns=' + (running.umdns ? 'yes' : 'no'),
        'avahi-daemon-bin=yes', 'avahi-browse-bin=no',
        'dbus-bin=yes', 'umdns-bin=yes',
        'avahi-daemon-init=yes', 'dbus-init=yes', 'umdns-init=yes',
        'avahi-daemon-enabled=yes', 'dbus-enabled=yes', 'umdns-enabled=yes'
    ].join('\n');
}
const execCalls = [];
const rpc = { exec: function(program, args) {
    execCalls.push([program, args]);
    if (program.includes('luci-avahi-scan')) {
        if (args[0] === 'scan') scanCalls++;
        assert.equal(args[0], 'last', 'LuCI must never trigger NAS-owned scan');
        return Promise.resolve({ code: 1, stderr: 'No previous result' });
    }
    if (program.includes('luci-avahi-auth')) return Promise.resolve({ code: 0, stdout: 'state=absent\n' });
    if (args[0] === 'status') return Promise.resolve({ code: 0, stdout: statusOutput() });
    if (args[0] === 'package' && args[1] === 'list') return Promise.resolve({ code: 0, stdout: packageOutput });
    throw new Error('Unexpected command: ' + args.join(' '));
} };
const view = new Function('view','fs','ui','poll','E','_',source)(
    { extend: x => x },rpc,{ showModal() {}, hideModal() {} },
    { add(fn) { pollFunction = fn; } },element,x => x
);
(async function() {
    const data = await view.load();
    const page = view.render(data);
    const t = text(page);
    for (const needle of ['运行状态与服务控制','部分安装','avahi-utils','缺少运行文件','可能发生 mDNS','三大组件安装与管理','NAS 接口授权'])
        assert.ok(t.includes(needle), 'Missing rendered text: ' + needle);
    assert.ok(!t.includes('Only authenticated EasyADB requests'));
    assert.equal(scanCalls, 0);
    const buttons = [];
    walk(page, n => { if (n.tag === 'button') buttons.push(n); });
    assert.ok(buttons.some(b => text(b) === '补齐安装' && !b.disabled), 'Avahi must allow repairing partial install');
    assert.ok(buttons.some(b => text(b) === '停止' && !b.disabled), 'Running mDNS services must be stoppable');
    assert.ok(typeof pollFunction === 'function', 'State should refresh periodically');
    running.umdns = false;
    await pollFunction();
    assert.ok(!text(page).includes('可能发生 mDNS'), 'Conflict warning should clear on refreshed status');
    assert.equal(scanCalls, 0);
    console.log('LuCI Chinese runtime and partial-install render tests passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
