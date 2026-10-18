/* Contract tests use a DOM/WS/MSE-free sandbox and never contact devices. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
class El{
 constructor(tag){this.tagName=tag;this.children=[];this.events={};this.style={};this.classList={add(){}};this.value='';this.disabled=false;this.readyState=0;this.textContent='';}
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
   initialize(){cbs.onState('playing');},append(){},
   diagnostics(){return {queueBytes:0};},resume(){},destroy(){}
 })},
 EasyADBTouch:{create:()=>({enable(){},disable(){},destroy(){}})},
 EasyADBTraffic:{Meter:class{record(){} sample(){return{mbps:0,totalBytes:0};}},size:()=> '0 MiB'},
 EasyADBMetrics:{QualityMeter:class{recordBytes(){} sample(){return{};}},format:()=>'',fmt:()=> '—'}
};
root.window=root;
vm.runInNewContext(fs.readFileSync('web/m2-multi.js','utf8'),root,{filename:'m2-multi.js'});
const devices=[1,2,3,4,5].map(n=>({id:'id-'+n,name:'Phone '+n,status:'connected',
 selected_serial:'10.10.0.'+n+':5555',active_serial:'10.10.0.'+n+':5555'}));
const picker=new El('div'),grid=new El('div'),startButton=new El('button'),stopButton=new El('button'),info=new El('div');
let solo=false;
const multi=root.EasyADBMulti.create({picker,grid,startButton,stopButton,info,
 getDevices:()=>devices,getToken:()=> 'token-test',getQuality:()=>({profile:'baseline'}),
 getSoloActive:()=>solo,onChange(){}});
assert.equal(root.EasyADBMulti.MAX_DEVICES,4);
assert.equal(sockets.length,0,'no implicit streaming');
assert.equal(startButton.disabled,true);
picker.children[0].children[0].checked=true;picker.children[0].children[0].fire('change');
picker.children[1].children[0].checked=true;picker.children[1].children[0].fire('change');
assert.equal(startButton.disabled,false);
solo=true;multi.updatePicker();assert.equal(startButton.disabled,true,'solo prevents multiview');
solo=false;multi.updatePicker();startButton.fire('click');
assert.equal(sockets.length,2);assert.equal(multi.hasActive(),true);
const [a,b]=sockets;assert.notEqual(a.url,b.url);
a.open();b.open();
const pa=JSON.parse(a.sent[0]),pb=JSON.parse(b.sent[0]);
assert.equal(pa.selected_serial,devices[0].selected_serial);
assert.equal(pb.selected_serial,devices[1].selected_serial);
a.emit('starting',{session_id:'session-a'});b.emit('starting',{session_id:'session-b'});
a.emit('init',{session_id:'session-a',width:720,height:1280,mime:'video/mp4; codecs="avc1.640028"',
 format:'fmp4',control_available:true,requested:{max_size:1600,video_bit_rate:8000000,max_fps:30}});
b.emit('init',{session_id:'session-b',width:720,height:1280,mime:'video/mp4; codecs="avc1.640028"',
 format:'fmp4',control_available:true,requested:{max_size:1600,video_bit_rate:8000000,max_fps:30}});
const ca=multi.cards.get('id-1'),cb=multi.cards.get('id-2');
assert.equal(ca.state,'playing');assert.equal(cb.state,'playing');
ca.toggle.fire('click');assert.equal(JSON.parse(a.sent.at(-1)).session_id,'session-a');
assert.equal(b.sent.length,1,'card A control must not leak to card B');
a.emit('control_enabled',{session_id:'session-a'});assert.equal(ca.enabled,true);assert.equal(cb.enabled,false);
ca.input.value='Hello';ca.input.fire('input');ca.box.children[5].fire('submit'); // form child
assert.equal(JSON.parse(a.sent.at(-1)).text,'Hello');
assert.equal(b.sent.length,1);
a.emit('input_accepted',{session_id:'session-a',kind:'input_text'});
ca.stop.fire('click');assert.equal(a.sent.at(-1),'stop');
a.emit('ended',{session_id:'session-a',cleanup_complete:true});
assert.equal(multi.cards.has('id-1'),false);
assert.equal(multi.cards.has('id-2'),true);
multi.stopAll();assert.equal(b.sent.at(-1),'stop');
b.emit('ended',{session_id:'session-b',cleanup_complete:true});
assert.equal(multi.hasActive(),false);
assert.equal(sockets.length,2,'stop never auto-starts/reconnects');
console.log('M2 multi contract passed');
