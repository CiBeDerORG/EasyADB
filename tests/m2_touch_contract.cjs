'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const text=fs.readFileSync(path.join(__dirname,'../web/m2-touch.js'),'utf8');
class Emitter{
  constructor(){this.handlers={};}
  addEventListener(n,fn){(this.handlers[n]||=[]).push(fn);}
  removeEventListener(n,fn){this.handlers[n]=(this.handlers[n]||[]).filter(x=>x!==fn);}
  emit(n,props={}){const ev={isPrimary:true,button:0,pointerId:1,timeStamp:100,
    clientX:260,clientY:270,preventDefault(){this.prevented=true;},...props};
    for(const fn of [...(this.handlers[n]||[])])fn(ev);return ev;}
}
const win=new Emitter(),video=new Emitter();
video.videoWidth=100;video.videoHeight=200;
video.style={touchAction:'auto',cursor:'default'};
video.getBoundingClientRect=()=>({left:10,top:20,width:500,height:500});
video.setPointerCapture=id=>{video.captured=id;};
video.releasePointerCapture=id=>{video.released=id;};
vm.runInNewContext(text,{window:win,Error,Number,Math},{filename:'m2-touch.js'});
const {mapPoint,create}=win.EasyADBTouch;
const size={width:100,height:200};
let mapped=mapPoint(video,size,260,270);
assert.equal(mapped.x,50);assert.equal(mapped.y,100);
assert.equal(mapPoint(video,size,20,270),null); // side letterbox
assert.equal(mapPoint(video,size,260,10),null); // outside video
assert.equal(mapPoint(video,{width:200,height:100},260,270),null); // stale dimensions
assert.equal(mapPoint(video,size,20,270,true).x,0);
const sent=[];
const ctrl=create(video,msg=>sent.push(msg));
video.emit('pointerdown');assert.equal(sent.length,0); // explicitly disabled default
ctrl.enable(size);
assert.equal(video.style.touchAction,'none');
video.emit('pointerdown',{clientX:20});assert.equal(sent.length,0); // black bar
video.emit('pointerdown',{pointerId:4,clientX:260,clientY:270});
assert.equal(sent.length,1);assert.equal(sent[0].action,'down');
assert.equal(sent[0].x,50);assert.equal(sent[0].y,100);
video.emit('pointerdown',{pointerId:5});assert.equal(sent.length,1); // no multitouch
video.emit('pointermove',{pointerId:4,timeStamp:120,clientX:600,clientY:270});
assert.equal(sent.at(-1).action,'move');assert.equal(sent.at(-1).x,99);
video.emit('pointermove',{pointerId:4,timeStamp:125});assert.equal(sent.length,2); // throttle
video.emit('pointerup',{pointerId:4,clientX:260,clientY:270});
assert.equal(sent.at(-1).action,'up');assert.equal(sent.length,3);
video.emit('lostpointercapture',{pointerId:4});assert.equal(sent.length,3); // no double release
video.emit('pointerdown',{pointerId:4});assert.equal(sent.at(-1).action,'down');
win.emit('blur');assert.equal(sent.at(-1).action,'cancel');assert.equal(ctrl.activeId,null);
video.emit('pointerdown',{pointerId:9});
ctrl.disable();assert.equal(sent.at(-1).action,'cancel');
assert.equal(video.style.touchAction,'auto');assert.equal(video.style.cursor,'default');
video.emit('pointerdown',{pointerId:10});assert.equal(sent.at(-1).action,'cancel');
ctrl.destroy();
assert.equal(video.handlers.pointerdown.length,0);assert.equal(win.handlers.blur.length,0);
console.log('M2-02 black bars, scaling, opt-in, drag/up/cancel and teardown: OK');
