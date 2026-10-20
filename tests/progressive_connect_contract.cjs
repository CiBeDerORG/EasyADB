/* Real progressive controller: one device becoming ready cannot wait for slow peers. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync('web/index.html','utf8');
const worker=html.slice(html.indexOf('async function runDeviceBatch('),html.indexOf('function select(id)',html.indexOf('async function runDeviceBatch(')));
const connect=html.slice(html.indexOf('async function connectProgressively('),html.indexOf('async function loadAndConnect('));
assert.match(connect,/await runDeviceBatch\(candidates,async d=>/);
assert.match(connect,/connectingDevices\.delete\(d\.id\)/);
assert.match(connect,/applyConnectionResult\(d,result\)/);
assert.doesNotMatch(connect,/loading=true/);
const serial=id=>'10.10.12.'+id+':5555';
const devices=Array.from({length:5},(_,i)=>{
 const id=String(i+1);return {id,name:'Phone '+id,selected_serial:serial(id),
  active_serial:null,status:'idle',connect_failed:false};
});
const pending=new Map(),requested=[],rendered=[],messages=[];
const sandbox={Promise,Array,Set,Map,Math,AbortController,URL,encodeURIComponent,
 api(path,opts){
  const id=decodeURIComponent(path.split('/')[3]);
  requested.push(id);
  return new Promise((resolve,reject)=>{
   const entry={resolve:state=>resolve({json:async()=>({...devices.find(d=>d.id===id),
    status:state,active_serial:state==='connected'?serial(id):null,
    connect_failed:state!=='connected'})}),reject};
   pending.set(id,entry);
   opts.signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});
  });
 },
 render(){rendered.push({
  ready:sandbox.__state().devices.filter(d=>d.status==='connected').map(d=>d.id),
  pending:[...sandbox.__state().connectingDevices],
  selection:[...sandbox.__state().managementSelected],
  loading:sandbox.__state().loading
 });},
 message:x=>messages.push(x),
 load:async()=>true
};
const setup=`
let devices=INITIAL_DEVICES.map(d=>({...d})),loading=false;
const managementSelected=new Set(),connectingDevices=new Set(),connectSnapshots=new Map();
let connectionBatchBusy=true,connectGeneration=0,connectProgressRevision=0,connectController=null;
const multiView={isBusyFor:()=>false};
function applyConnectionResult(d,r){
 const existing=devices.find(x=>x.id===d.id);
 const fresh=r.status==='fulfilled'?r.value:{...existing,status:'error',connect_failed:true};
 ++connectProgressRevision;
 connectSnapshots.set(d.id,{revision:connectProgressRevision,device:fresh});
 devices=devices.map(x=>x.id===d.id?fresh:x);
 return hasConnectedAdb(fresh);
}
function deviceLocked(id){return loading||connectingDevices.has(id);}
`+worker+'\n'+connect+`
globalThis.__state=()=>({devices,loading,connectingDevices,managementSelected,connectionBatchBusy});
globalThis.__run=(select=false)=>connectProgressively(devices.slice(),0,select,'测试连接',connectGeneration);
globalThis.__reset=()=>{
 devices=INITIAL_DEVICES.map(d=>({...d}));managementSelected.clear();
 connectingDevices.clear();connectSnapshots.clear();
 connectionBatchBusy=true;
};
`;
sandbox.INITIAL_DEVICES=devices;
vm.runInNewContext(setup,sandbox,{filename:'progressive-connect.js'});
const tick=()=>new Promise(r=>setImmediate(r));
async function settle(id,status){pending.get(id).resolve(status);await tick();await tick();}
(async()=>{
 let task=sandbox.__run();
 assert.deepEqual(requested,['1','2','3','4'],'4 ADB requests launch at once');
 assert.deepEqual([...sandbox.__state().connectingDevices],['1','2','3','4','5']);
 assert.equal(sandbox.__state().loading,false,'no global loading lock while connecting');
 await settle('2','connected');
 assert(requested.includes('5'),'a fifth device launches when B finishes while A is pending');
 assert(!sandbox.__state().connectingDevices.has('2'));
 assert(sandbox.__state().connectingDevices.has('1'));
 assert.equal(sandbox.__state().devices.find(d=>d.id==='2').status,'connected');
 assert.equal(rendered.at(-1).loading,false);
 assert.deepEqual(rendered.at(-1).ready,['2']);
 assert.equal(rendered.at(-1).pending.includes('1'),true);
 await settle('3','disconnected');
 assert.equal(sandbox.__state().devices.find(d=>d.id==='3').connect_failed,true);
 await Promise.all(['1','4','5'].map(id=>settle(id,'connected')));
 await task;
 assert.equal(sandbox.__state().connectionBatchBusy,false);
 assert.equal(sandbox.__state().connectingDevices.size,0);
 assert.equal(sandbox.__state().devices.filter(d=>d.status==='connected').length,4);
 assert.equal(sandbox.__state().managementSelected.size,0,'first-load does not alter manual selection');
 assert(messages.some(x=>x.includes('已完成设备可立即操作')));
 // Bulk connection only checks successes progressively; failure stays unchecked.
 requested.length=0;pending.clear();rendered.length=0;sandbox.__reset();
 sandbox.__state().managementSelected.add('1');
 sandbox.__state().managementSelected.add('2');
 task=sandbox.__run(true);
 assert.equal(sandbox.__state().managementSelected.size,0,'old selection cleared at batch start');
 await settle('4','connected');
 assert.deepEqual([...sandbox.__state().managementSelected],['4']);
 assert.equal(sandbox.__state().devices.find(d=>d.id==='4').status,'connected');
 await settle('2','disconnected');
 assert.deepEqual([...sandbox.__state().managementSelected],['4']);
 await Promise.all(['1','3','5'].map(id=>settle(id,'connected')));
 await task;
 assert.deepEqual([...sandbox.__state().managementSelected].sort(),['1','3','4','5']);
 console.log('Progressive initial/bulk connect releases each completed phone immediately: OK');
})().catch(error=>{console.error(error);process.exitCode=1;});
