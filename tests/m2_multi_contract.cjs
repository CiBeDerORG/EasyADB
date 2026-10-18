/* M2-06 individual quality, diagnostics and 1–4 selected-device launch.
 * Mock-only: never opens network, ADB, MediaSource or GitHub runner.
 */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
class El{
 constructor(tag){this.tagName=tag;this.children=[];this.events={};this.style={};this.classList={add(){}};this.value='';this.disabled=false;this.textContent='';this.checked=false;this.open=false;}
 addEventListener(name,fn){(this.events[name]??=[]).push(fn);}
 append(...items){
  for(const item of items){
   if(item.parent){const siblings=item.parent.children;const i=siblings.indexOf(item);if(i!==-1)siblings.splice(i,1);}
   item.parent=this;this.children.push(item);
  }
 }
 replaceChildren(...items){for(const child of this.children)child.parent=null;this.children=[];this.append(...items);}
 remove(){
  this.removed=true;
  if(this.parent){const siblings=this.parent.children;const i=siblings.indexOf(this);if(i!==-1)siblings.splice(i,1);this.parent=null;}
 }
 setAttribute(name,value){this[name]=value;}
 fire(name,ev={}){for(const fn of this.events[name]||[])fn({preventDefault(){},...ev});}
}
const sockets=[];
class WS{
 static OPEN=1;
 constructor(url){this.url=url;this.readyState=0;this.sent=[];sockets.push(this);}
 open(){this.readyState=WS.OPEN;this.onopen();}
 send(value){this.sent.push(value);}
 emit(type,attrs={}){this.onmessage({data:JSON.stringify({type,...attrs})});}
 close(){this.readyState=3;this.onclose?.();}
}
let clock=0;
const root={
 document:{createElement:tag=>new El(tag)},WebSocket:WS,
 location:{protocol:'http:',host:'nas.local'},Date,
 performance:{now:()=>{clock+=1000;return clock;}},
 EasyADBPlayers:{create:(_type,_video,cbs)=>({
   initialize(){cbs.onState('ready');},append(){},
   diagnostics(){return {queueBytes:0,sourceState:'open',sourceRanges:1,
    rangeEnd:3,currentTime:2,queueChunks:0,appendCalls:4,completedUpdates:4,videoError:null};},
   resume(){},destroy(){}
 })},
 EasyADBTouch:{create:()=>({enable(){},disable(){},destroy(){}})},
 EasyADBTraffic:{Meter:class{
  totalBytes=0;record(n){this.totalBytes+=n;}sample(){return{mbps:1,totalBytes:this.totalBytes};}},
  size:x=>String(x)+'B'},
 EasyADBMetrics:{QualityMeter:class{
  samples=[];recordBytes(){} sample(){this.samples.push({});return{};}
  summary(profile,device){return{profile,device,avgFps:24,avgReceiveMbps:1,avgCpuPct:3,avgRssMib:8,totalBytes:128};}},
  format:()=>'',fmt:(v)=>Number.isFinite(v)?String(v):'—',advice:()=> ''}
};root.window=root;
vm.runInNewContext(fs.readFileSync('web/m2-multi.js','utf8'),root,{filename:'m2-multi.js'});
const page=fs.readFileSync('web/index.html','utf8');
assert.match(page,/勾选任意 1～4 台/);
assert.doesNotMatch(page,/id="legacySolo"/,'legacy screenshot player must be deleted');
assert.doesNotMatch(page,/id="previewTitle"|id="shotButton"|id="liveVideo"/);
assert.match(page,/class="workspace"/);
assert.match(page,/class="panel inventory-panel"/);
assert.match(page,/elem\('div','device-quality'\)/);
assert.match(page,/class="stage-view"/);
assert.doesNotMatch(page,/class="stage-main"|class="stage-settings"/);
assert.match(page,/id="multiPicker" hidden aria-hidden="true"/);
assert.match(page,/id="multiStart"[\s\S]*id="multiStop"[\s\S]*id="devices"/);
assert.match(page,/id="devices"[\s\S]*id="multiGrid"/);
assert.match(page,/qualityRows\.get\(d\.id\)/);
assert.match(page,/grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
assert.match(page,/runPreflight:async id/);
assert.match(page,/runVideoProbe:async\(id,profile\)/);
assert.doesNotMatch(page,/id="multiProfile"/,'no global multiview quality selector');
const devices=[1,2,3,4,5].map(n=>({id:'id-'+n,name:'Phone '+n,status:'connected',
 selected_serial:'10.10.0.'+n+':5555',active_serial:'10.10.0.'+n+':5555'}));
const picker=new El('div'),grid=new El('div'),startButton=new El('button'),stopButton=new El('button'),info=new El('div');
const calls=[];
const multi=root.EasyADBMulti.create({picker,grid,startButton,stopButton,info,
 getDevices:()=>devices,getToken:()=> 'token-test',
 onChange(){},
 runPreflight:async id=>{calls.push(['preflight',id]);return{selected_serial:'checked-'+id,model:'Test',android_sdk:35,cpu_abi:'arm64',display_size:'1080x2400'};},
 runVideoProbe:async(id,p)=>{calls.push(['probe',id,p]);return{codec:'H.264',encoded_width:720,
  encoded_height:1280,media_packets:3,key_frames:1,sample_bytes:1024,elapsed_ms:150};}
});
const checkbox=i=>picker.children[i].children[0].children[0];
const quality=i=>picker.children[i].children[1];
function select(i){const el=checkbox(i);el.checked=true;el.fire('change');}
function init(ws,sid){
 ws.emit('init',{session_id:sid,width:720,height:1280,
  mime:'video/mp4; codecs="avc1.640028"',format:'fmp4',control_available:true,
  requested:{max_size:960,video_bit_rate:3000000,max_fps:24}});
}
assert.equal(root.EasyADBMulti.MAX_DEVICES,4);
assert.equal(sockets.length,0);
assert.equal(startButton.disabled,true,'empty selection cannot start');
assert.equal(checkbox(0).disabled,false);
select(0);
assert.equal(startButton.disabled,false,'ONE selected device is enough');
assert.match(startButton.textContent,/已选 1/);
assert.equal(checkbox(1).checked,false);
assert.equal(quality(0).value,'economy');
assert.equal(quality(1).value,'economy');
// Editing one device never overwrites another.
quality(0).value='custom';quality(0).fire('change');
assert.equal(multi.getChoice('id-1').profile,'custom');
assert.equal(multi.getChoice('id-1').video_bit_rate,4000000,'custom default allowlisted');
assert.equal(multi.getChoice('id-2').profile,'economy');
let custom=picker.children[0].children[2];
const bitrate=custom.children[1].children[0];
bitrate.value='12000000';bitrate.fire('change');
assert.equal(multi.getChoice('id-1').video_bit_rate,12000000);
// one selected must create ONLY its own WS with exact per-device quality.
startButton.fire('click');assert.equal(sockets.length,1);
const a=sockets[0];a.open();const pa=JSON.parse(a.sent[0]);
assert.equal(pa.profile,'custom');assert.equal(pa.quality.video_bit_rate,12000000);
assert.equal(pa.selected_serial,devices[0].selected_serial);
assert.equal(multi.cards.size,1);
assert.equal(grid.children.length,1);
a.emit('starting',{session_id:'only-one'});
assert.equal(sockets.length,1);
init(a,'only-one');
const ca=multi.cards.get('id-1');
assert.equal(ca.toggle.disabled,false,'control independent of video playing');
assert.equal(ca.quality.profile,'custom');
assert.match(ca.box.children[1].textContent,/自定义/);
a.emit('diagnostic',{session_id:'only-one',adb_check_ms:23,stage:'streaming',phone_packets:9,
 mux_chunks:4,media_fragments:3,elapsed_ms:1500,proc_cpu_pct:5,proc_rss_mib:20,ws_video_bytes:1000});
assert.match(ca.diagnostic.textContent,/手机编码包 9/);
assert.match(ca.diagnostic.textContent,/完整分片 3/);
assert.equal(JSON.parse(a.sent.at(-1)).session_id,'only-one');
ca.toggle.fire('click');a.emit('control_enabled',{session_id:'only-one'});
assert.equal(ca.enabled,true);
ca.stop.fire('click');assert.equal(a.sent.at(-1),'stop');
a.emit('ended',{session_id:'only-one',cleanup_complete:true});
assert.equal(multi.hasActive(),false);
assert.equal(grid.children.length,0,'terminal session must REMOVE its old video DOM card');
assert.equal(multi.selected.has('id-1'),true,'explicit selection survives clean stop');
assert.match(ca.historyEl.textContent,/最近画质/);
// selection is available again, no automatic start and no all-selected rule.
assert.equal(sockets.length,1);
quality(1).value='baseline';quality(1).fire('change');
select(0);select(1);
assert.equal(startButton.disabled,false);
startButton.fire('click');assert.equal(sockets.length,2,'sequential first launch');
const b=sockets.at(-1);b.open();assert.equal(JSON.parse(b.sent[0]).profile,'custom');
b.emit('starting',{session_id:'second-a'});
assert.equal(sockets.length,2,'starting alone does not start next');
init(b,'second-a');
assert.equal(sockets.length,3);
const c=sockets.at(-1);c.open();assert.equal(JSON.parse(c.sent[0]).profile,'baseline');
c.emit('starting',{session_id:'second-b'});init(c,'second-b');
const cb=multi.cards.get('id-1'),cc=multi.cards.get('id-2');
assert.equal(cc.toggle.disabled,false);
cb.toggle.fire('click');b.emit('control_enabled',{session_id:'second-a'});
cc.toggle.fire('click');c.emit('touch_error',{session_id:'second-b',message:'not ready'});
assert.equal(cc.pending,false);assert.equal(cc.toggle.disabled,false);
cc.toggle.fire('click');c.emit('control_enabled',{session_id:'second-b'});
assert.equal(cc.enabled,true);
cb.input.value='Hello';cb.box.children[6].fire('submit');
assert.equal(JSON.parse(b.sent.at(-1)).text,'Hello');
assert.equal(c.sent.filter(x=>x.includes('"text":"Hello"')).length,0);
c.emit('diagnostic',{session_id:'second-b',phone_packets:5,mux_chunks:2,media_fragments:1,stage:'streaming'});
assert.equal(JSON.parse(c.sent.at(-1)).session_id,'second-b');
assert.equal(grid.children.length,2,'two selected devices create exactly two visible cards');
// BUG regression: stop all, wait for actual cleanup acknowledgments, then
// start the same selection again. No old window may remain behind.
multi.stopAll();
assert.equal(b.sent.at(-1),'stop');assert.equal(c.sent.at(-1),'stop');
b.emit('ended',{session_id:'second-a',cleanup_complete:true});
c.emit('ended',{session_id:'second-b',cleanup_complete:true});
assert.equal(grid.children.length,0,'stop-all must clear ALL old windows');
assert.equal(multi.cards.size,0);
assert.equal(multi.selected.size,2,'selection is retained but restart remains manual');
assert.equal(startButton.disabled,false);
startButton.fire('click');
assert.equal(grid.children.length,1,'restart adds only the first requested device');
assert.equal(sockets.length,4);
const d=sockets[3];d.open();d.emit('starting',{session_id:'restart-a'});init(d,'restart-a');
assert.equal(grid.children.length,2,'restart must show exactly two NEW video cards');
assert.equal(sockets.length,5);
const e=sockets[4];e.open();e.emit('starting',{session_id:'restart-b'});init(e,'restart-b');
assert.equal(grid.children.length,2,'no stale/duplicate windows after second init');
multi.stopAll();
d.emit('ended',{session_id:'restart-a',cleanup_complete:true});
e.emit('ended',{session_id:'restart-b',cleanup_complete:true});
assert.equal(grid.children.length,0);
assert.equal(multi.cards.size,0);
// preflight and probe on a chosen device are independent and explicit.
multi.closeAll();assert.equal(multi.cards.size,0);
const preButton=picker.children[1].children[2].children[0];
async function waitForCheck(id){
 // Each explicit check updates the picker asynchronously; don't test a stale
 // detached button while the previous request still has checking=true.
 for(let i=0;i<16&&multi.checking.has(id);i++)await Promise.resolve();
 assert.equal(multi.checking.has(id),false,'device check must settle before next click');
}
(async()=>{
 preButton.fire('click');
 await waitForCheck('id-2');
 assert.equal(calls[0][0],'preflight');
 assert.equal(calls[0][1],'id-2');
 assert.match(multi.probeResults.get('id-2'),/M2 能力预检/);
 // updatePicker() replaces the DOM; choose the button on the CURRENT card.
 const probeButton=picker.children[1].children[2].children[1];
 assert.equal(probeButton.disabled,false);
 probeButton.fire('click');
 await waitForCheck('id-2');
 assert.equal(calls[1][0],'probe');
 assert.equal(calls[1][1],'id-2');
 assert.match(multi.probeResults.get('id-2'),/视频实验/);
 assert.match(multi.probeResults.get('id-2'),/M2 能力预检/,'probe retains earlier log');
 assert.equal(multi.probeResults.has('id-1'),false,'device logs stay isolated');
 for(let i=0;i<4;i++)select(i);
 assert.equal(checkbox(4).disabled,true);
 assert.equal(startButton.disabled,false);
 console.log('M2 per-device quality/diagnostics and selected-only launch: OK');
})().catch(error=>{console.error(error);process.exitCode=1;});
