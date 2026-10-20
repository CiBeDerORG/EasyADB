/* Device-list connected-first order and successful batch selection contracts. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync('web/index.html','utf8');
const start=html.indexOf('function hasConnectedAdb(');
const end=html.indexOf('function select(id)',start);
assert(start>=0&&end>start,'shared ADB state helpers exist in the real page');
const helpers=vm.runInNewContext(html.slice(start,end)+
 '\n({hasConnectedAdb,connectedFirst,successfulBatchIds})');
const {hasConnectedAdb,connectedFirst,successfulBatchIds}=helpers;
const device=(id,props={})=>({
 id,name:id,selected_serial:'10.10.10.'+id+':5555',
 active_serial:'10.10.10.'+id+':5555',status:'connected',connect_failed:false,...props
});
const goodA=device('1'),goodB=device('2');
const disconnected=device('3',{status:'disconnected',active_serial:null,connect_failed:true});
const stale=device('4',{selected_serial:'10.10.10.4:5556'});
const noActive=device('5',{active_serial:null});
assert(hasConnectedAdb(goodA));
for(const d of [disconnected,stale,noActive])assert(!hasConnectedAdb(d));
const list=[disconnected,goodA,stale,goodB,noActive];
list.sort(connectedFirst);
assert.deepEqual(list.map(d=>d.id),['1','2','3','4','5'],
 'successes first, with original relative order preserved in both statuses');
const candidates=[goodA,disconnected,goodB,stale];
const results=[
 {status:'fulfilled',value:goodA},
 {status:'rejected',reason:new Error('offline')},
 {status:'fulfilled',value:goodB},
 {status:'fulfilled',value:stale}
];
const selected=successfulBatchIds(candidates,results);
assert.deepEqual([...selected],['1','2'],'only confirmed successful batch responses are selected');
assert(!selected.has('3')&&!selected.has('4'));
assert.deepEqual([...successfulBatchIds(candidates,[{status:'rejected'},{status:'rejected'},
 {status:'rejected'},{status:'rejected'}])],[],'failed batch clears selection');
const render=html.slice(html.indexOf('function render(){'),html.indexOf('async function load(',html.indexOf('function render(){')));
assert.match(render,/for\(const group of grouped\.values\(\)\)group\.items\.sort\(connectedFirst\)/,
 'sort each displayed group, rather than mutating shared device batch order');
assert.match(render,/const ac=grouped\.get\(a\)\.items\.some\(hasConnectedAdb\),bc=grouped\.get\(b\)\.items\.some\(hasConnectedAdb\)/,
 'groups containing live connections appear ahead of disconnected groups');
const handler=html.slice(html.indexOf("$('bulkConnect').addEventListener"),
 html.indexOf("$('bulkDelete').addEventListener"));
const progressive=html.slice(html.indexOf('async function connectProgressively('),
 html.indexOf('async function loadAndConnect('));
assert.match(handler,/await connectProgressively\(candidates,skipped,true,'批量连接',connectGeneration\)/,
 'bulk connect uses the same progressive per-device pipeline');
assert.match(progressive,/if\(selectSuccessful\)managementSelected\.clear\(\)/,
 'old selection cleared when a successful-only batch starts');
assert.match(progressive,/if\(selectSuccessful\)managementSelected\.add\(d\.id\)/,
 'only successful devices are selected as they finish');
assert.match(progressive,/connectingDevices\.delete\(d\.id\);[\s\S]*?applyConnectionResult\(d,result\);[\s\S]*?render\(\)/,
 'each completed device is independently unlocked and redrawn');
console.log('Connected-first group sorting and successful-only batch selection: OK');
