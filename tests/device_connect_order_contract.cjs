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
// Execute the actual render projection, both before and after module injection.
// Sorting belongs to the model now; its location inside render is not a contract.
async function verifyRenderProjection(){
 const deviceList=await import('../web/features/devices/device-list-model.js');
 const devices=Object.freeze([
  Object.freeze(device('3',{group_name:'Zulu',status:'disconnected',active_serial:null})),
  Object.freeze(device('1',{group_name:'Zulu'})),
  Object.freeze(device('4',{group_name:'Alpha',selected_serial:'10.10.10.4:5556'})),
  Object.freeze(device('2',{group_name:'Zulu'})),
  Object.freeze(device('5',{group_name:null,status:'idle',active_serial:null})),
  Object.freeze(device('6',{group_name:'Zulu',status:'error',active_serial:null})),
 ]);
 const groups=Object.freeze([
  Object.freeze({name:'Alpha',ip_prefix:'10.0.1.*',discovery_configured:true}),
  Object.freeze({name:'Zulu',ip_prefix:'10.0.0.*',discovery_needs_password:true}),
  Object.freeze({name:'Empty',ip_prefix:null}),
 ]);
 const before=JSON.stringify({devices,groups});
 const countAt=render.indexOf(" $('count').textContent");
 assert(countAt>0,'render computes groups before publishing the device count');
 const projection=render.slice(0,countAt)+'\n return {grouped,keys};\n}';
 let moduleCalls=0;
 for(const injected of [false,true]){
  let cleared=0;
  const context={devices,groups,multiView:null,
   frontendModules:injected?{deviceList:{buildDeviceGroups(...args){
    moduleCalls++;return deviceList.buildDeviceGroups(...args);
   }}}:null,
   $(id){assert.equal(id,'devices');return {replaceChildren(){cleared++;}};}
  };
  const {grouped,keys}=vm.runInNewContext(html.slice(start,end)+'\n'+projection+'\nrender()',context);
  assert.equal(cleared,1);
  assert.deepEqual([...keys],['named:Zulu','named:Alpha','named:Empty','ungrouped'],
   'connected groups first; empty named groups and ungrouped devices remain visible');
  assert.deepEqual(Array.from(grouped.get('named:Zulu').items,d=>d.id),['1','2','3','6'],
   'connected devices first, preserving relative order within each state');
  assert.equal(grouped.get('named:Alpha').discovery_configured,true);
  assert.equal(grouped.get('named:Zulu').discovery_needs_password,true);
  assert.equal(grouped.get('named:Empty').items.length,0);
  assert.equal(grouped.get('ungrouped').title,'未分组');
  assert.equal(JSON.stringify({devices,groups}),before,'display sorting cannot mutate batch inputs');
 }
 assert.equal(moduleCalls,1,'render must use the injected production model after bootstrap');
}
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
verifyRenderProjection().then(()=>{
 console.log('Connected-first group sorting, injected/legacy parity and successful-only batch selection: OK');
}).catch(error=>{console.error(error);process.exitCode=1;});
