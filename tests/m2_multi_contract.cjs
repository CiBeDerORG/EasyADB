/* M2-06 regression: deliberately no actual video 'playing' event. Control must
 * become available as soon as scrcpy init/control is ready, independently on
 * each card. Startup is staggered on completed server init, never a timer.
 */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
class El{
 constructor(tag){this.tagName=tag;this.children=[];this.events={};this.style={};this.classList={add(){}};this.value='';this.disabled=false;this.textContent='';}
 addEventListener(name,fn){(this.events[name]??=[]).push(fn);}
 append(...items){this.children.push(...items);}
 replaceChildren(...items){this.children=[...items];}
 remove(){this.removed=true;}
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
 location:{protocol:'http:',host:'nas.local'},
 performance:{now:()=>{clock+=1000;return clock;}},
 EasyADBPlayers:{create:(_type,_video,cbs)=>({
   initialize(){cbs.onState('ready');},append(){},
   diagnostics(){return {queueBytes:0};},resume(){},destroy(){}
 })},
 EasyADBTouch:{create:()=>({enable(){},disable(){},destroy(){}})},
 EasyADBTraffic:{Meter:class{record(){} sample(){return{mbps:0,totalBytes:0};}},size:()=> '0 MiB'},
 EasyADBMetrics:{QualityMeter:class{recordBytes(){} sample(){return{};}},format:()=>'',fmt:()=> '—',advice:()=> ''}
};
root.window=root;
vm.runInNewContext(fs.readFileSync('web/m2-multi.js','utf8'),root,{filename:'m2-multi.js'});
const html=fs.readFileSync('web/index.html','utf8');
assert.match(html,/<select id="multiProfile"[\s\S]*?<option value="economy" selected>/);
const devices=[1,2,3,4,5].map(n=>({id:'id-'+n,name:'Phone '+n,status:'connected',
 selected_serial:'10.10.0.'+n+':5555',active_serial:'10.10.0.'+n+':5555'}));
const picker=new El('div'),grid=new El('div'),startButton=new El('button'),stopButton=new El('button'),info=new El('div');
let solo=false;
const multi=root.EasyADBMulti.create({picker,grid,startButton,stopButton,info,
 getDevices:()=>devices,getToken:()=> 'token-test',getQuality:()=>({profile:'economy'}),
 getSoloActive:()=>solo,onChange(){}});
function choose(n){for(let i=0;i<n;i++){const check=picker.children[i].children[0];check.checked=true;check.fire('change');}}
function init(ws,sid){
 ws.emit('init',{session_id:sid,width:720,height:1280,
  mime:'video/mp4; codecs="avc1.640028"',format:'fmp4',control_available:true,
  requested:{max_size:960,video_bit_rate:3000000,max_fps:24}});
}
assert.equal(root.EasyADBMulti.MAX_DEVICES,4);
assert.equal(sockets.length,0,'no implicit device connection');
choose(2);
assert.equal(startButton.disabled,false);
solo=true;multi.updatePicker();assert.equal(startButton.disabled,true,'solo prevents multiview');
solo=false;multi.updatePicker();startButton.fire('click');
assert.equal(sockets.length,1,'stagger concurrent scrcpy/FFmpeg starts');
const a=sockets[0];a.open();
assert.equal(JSON.parse(a.sent[0]).profile,'economy');
assert.equal(sockets.length,1,'await first completed init before opening next');
a.emit('starting',{session_id:'session-a'});
assert.equal(sockets.length,1,'starting alone must not launch another encoder');
init(a,'session-a');
assert.equal(sockets.length,2,'completed first init launches second device');
const b=sockets[1];b.open();b.emit('starting',{session_id:'session-b'});
assert.notEqual(a.url,b.url);
assert.equal(JSON.parse(a.sent[0]).selected_serial,devices[0].selected_serial);
assert.equal(JSON.parse(b.sent[0]).selected_serial,devices[1].selected_serial);
init(b,'session-b');
const ca=multi.cards.get('id-1'),cb=multi.cards.get('id-2');
assert.equal(ca.state,'ready');assert.equal(cb.state,'ready');
assert.equal(ca.toggle.disabled,false);
assert.equal(cb.toggle.disabled,false,'card B independent even without video playing');
a.emit('diagnostic',{session_id:'session-a',proc_cpu_pct:5,proc_rss_mib:20});
assert.equal(JSON.parse(a.sent.at(-1)).type,'heartbeat');
assert.equal(JSON.parse(a.sent.at(-1)).session_id,'session-a');
assert.equal(b.sent.length,1,'diagnostic receipt never pings card B');
ca.toggle.fire('click');
assert.equal(JSON.parse(a.sent.at(-1)).session_id,'session-a');
assert.equal(b.sent.length,1,'card A control never leaks to card B');
a.emit('control_enabled',{session_id:'session-a'});
assert.equal(ca.enabled,true);assert.equal(cb.enabled,false);
cb.toggle.fire('click');
assert.equal(JSON.parse(b.sent.at(-1)).type,'control_enable');
assert.equal(cb.pending,true);
b.emit('touch_error',{session_id:'session-b',message:'暂未就绪'});
assert.equal(cb.pending,false,'rejected control must reset pending latch');
assert.equal(cb.toggle.disabled,false,'retry must be available');
cb.toggle.fire('click');b.emit('control_enabled',{session_id:'session-b'});
assert.equal(cb.enabled,true);
ca.input.value='Hello';ca.box.children[5].fire('submit');
assert.equal(JSON.parse(a.sent.at(-1)).text,'Hello');
assert.equal(JSON.parse(a.sent.at(-1)).session_id,'session-a');
assert.equal(b.sent.filter(x=>x.includes('"text":"Hello"')).length,0);
a.emit('input_accepted',{session_id:'session-a',kind:'input_text'});
cb.nav[0].fire('click');
assert.equal(JSON.parse(b.sent.at(-1)).key,'back');
assert.equal(JSON.parse(b.sent.at(-1)).session_id,'session-b');
b.emit('input_accepted',{session_id:'session-b',kind:'nav_key'});
ca.stop.fire('click');assert.equal(a.sent.at(-1),'stop');
a.emit('ended',{session_id:'session-a',cleanup_complete:true});
assert.equal(multi.cards.has('id-1'),false);
assert.equal(multi.cards.has('id-2'),true);
multi.stopAll();assert.equal(b.sent.at(-1),'stop');
b.emit('ended',{session_id:'session-b',cleanup_complete:true});
assert.equal(multi.hasActive(),false);
assert.equal(sockets.length,2,'stopping never auto reconnects');
choose(4);
assert.equal(picker.children[4].children[0].disabled,true,'fifth choice unavailable');
startButton.fire('click');
const four=[];
for(let i=0;i<4;i++){
 assert.equal(sockets.length,3+i);
 const ws=sockets.at(-1);four.push(ws);ws.open();
 ws.emit('starting',{session_id:'four-'+i});
 assert.equal(sockets.length,3+i,'starting is not an init');
 init(ws,'four-'+i);
}
assert.equal(multi.cards.size,4);
four[0].emit('error',{session_id:'four-0',message:'encoder failed'});
assert.equal(multi.cards.size,3,'one-card failure must not stop others');
assert.equal(multi.cards.get('id-2').closed,false);
multi.closeAll();assert.equal(multi.cards.size,0);
assert.equal(sockets.length,6,'closed cards never restart');
// Cancelling an in-flight batch must not open the queued second phone.
choose(2);startButton.fire('click');assert.equal(sockets.length,7);
const pending=sockets.at(-1);pending.open();
multi.stopAll();pending.close();
assert.equal(sockets.length,7,'stop-all cancels not-yet-opened cards');
console.log('M2 multi ready/control/independent-session/staggered startup: OK');
