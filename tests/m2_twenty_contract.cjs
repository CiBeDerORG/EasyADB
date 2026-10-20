/* Production (not test-overridden) 20-session browser capacity contract. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
class El{
 constructor(tag){this.tagName=tag;this.children=[];this.handlers={};this.value='';this.checked=false;this.disabled=false;this.textContent='';this.style={};this.open=false;}
 addEventListener(name,fn){(this.handlers[name]??=[]).push(fn);}
 append(...nodes){this.children.push(...nodes);}
 replaceChildren(...nodes){this.children=[];this.append(...nodes);}
 setAttribute(key,value){this[key]=value;}
 fire(event){for(const handler of this.handlers[event]||[])handler({preventDefault(){}});}
}
const root={document:{createElement:tag=>new El(tag)},EasyADBMetrics:{fmt:v=>String(v)}};
root.window=root;
const source=fs.readFileSync('web/m2-multi.js','utf8');
vm.runInNewContext(source,root,{filename:'m2-multi.js'});
assert.equal(root.EasyADBMulti.MAX_DEVICES,20,'browser production maximum is twenty');
const server=fs.readFileSync('server/m2_live.py','utf8');
assert.match(server,/MAX_LIVE_SESSIONS = 20/,'server authoritative maximum matches UI');
const devices=Array.from({length:21},(_,index)=>{
 const n=index+1;
 return{id:'phone-'+n,name:'Phone '+n,status:'connected',port:5555,
 selected_serial:'10.10.10.'+n+':5555',active_serial:'10.10.10.'+n+':5555',connect_failed:false};
});
const selected=new Set(devices.map(d=>d.id)),launches=[];
const picker=new El('div'),grid=new El('div'),startButton=new El('button'),
 stopButton=new El('button'),info=new El('div');
const view=root.EasyADBMulti.create({picker,grid,startButton,stopButton,info,
 getDevices:()=>devices,getToken:()=> 'test-token',getManagementBusy:()=>false,
 getBatchSelection:()=>selected,onBatchSelectionRemove:id=>selected.delete(id),
 onChange:()=>{}});
// Isolate the quota scheduler from video codec and mock-WebSocket transport.
// Every open call reserves a unique card as the real open() does before init.
view.open=function(device){assert(!this.cards.has(device.id));launches.push(device.id);
 this.cards.set(device.id,{id:device.id,state:'connecting'});};
assert.equal(startButton.disabled,true,'21 selected devices cannot exceed remaining 20');
selected.delete('phone-21');view.updatePicker();
assert.equal(startButton.disabled,false,'any subset up to twenty can start');
assert.match(startButton.textContent,/待新增 20 台 \/ 剩余 20 路/);
startButton.fire('click');
assert.equal(view.cards.size,20);
assert.equal(launches.length,20);
assert.equal(new Set(launches).size,20,'each control session is uniquely reserved');
assert.equal(startButton.disabled,true,'full pool cannot append');
assert.equal(view.projectionButton(devices[20]).disabled,true,'21st port also blocks');
selected.clear();selected.add('phone-21');view.updatePicker();
assert.equal(startButton.disabled,true,'a newly selected 21st device cannot start');
view.cards.get('phone-1').state='stopping';view.updatePicker();
assert.equal(startButton.disabled,true,'stopping session retains its slot');
// Simulate only server-confirmed cleanup deleting a card, not merely clicking stop.
view.cards.delete('phone-1');view.updatePicker();
assert.equal(startButton.disabled,false,'one confirmed cleanup releases one capacity slot');
assert.match(startButton.textContent,/待新增 1 台 \/ 剩余 1 路/);
startButton.fire('click');
assert.equal(view.cards.size,20);
assert.equal(launches.at(-1),'phone-21');
assert.equal(launches.length,21,'exactly one new session added; no bulk recreation');
assert(!view.cards.has('phone-1'),'stopped session not implicitly restarted');
console.log('Production multiview: 1..20 supported, 21st blocked, cleanup frees one slot: OK');
