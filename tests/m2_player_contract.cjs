/* Exercise the actual browser player module in a mocked JS environment. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const script=fs.readFileSync(path.join(__dirname,'../web/m2-player.js'),'utf8');

class Emitter {
  constructor(){this.listeners=new Map();}
  addEventListener(name,callback){const list=this.listeners.get(name)||[];list.push(callback);this.listeners.set(name,list);}
  removeEventListener(name,callback){this.listeners.set(name,(this.listeners.get(name)||[]).filter(fn=>fn!==callback));}
  emit(name){for(const fn of this.listeners.get(name)||[])fn();}
}
class SourceBufferMock extends Emitter {
  constructor(){super();this.mode='segments';this.updating=false;this.received=[];this.buffered={length:0};}
  appendBuffer(data){this.received.push(Buffer.from(data));this.updating=false;this.emit('updateend');}
  abort(){}
  remove(){}
}
class MediaSourceMock extends Emitter{
  constructor(){super();this.readyState='closed';this.source=null;MediaSourceMock.last=this;}
  static isTypeSupported(mime){return mime==='video/mp4; codecs="avc1.640028"';}
  addSourceBuffer(mime){assert.equal(mime,'video/mp4; codecs="avc1.640028"');this.source=new SourceBufferMock();return this.source;}
  open(){this.readyState='open';this.emit('sourceopen');}
}
class VideoMock extends Emitter {
  constructor(){super();this.currentTime=0;this.paused=true;this.hidden=true;this.attrs=[];}
  play(){this.paused=false;this.emit('playing');return Promise.resolve();}
  pause(){this.paused=true;}
  removeAttribute(name){this.attrs.push(name);}
  load(){}
}
const urls=[];
const fakeWindow={isSecureContext:true,VideoDecoder:class{},};
vm.runInNewContext(script,{
  window:fakeWindow,MediaSource:MediaSourceMock,Uint8Array,Buffer,
  URL:{createObjectURL:()=>{urls.push('created');return 'blob:test';},
       revokeObjectURL:x=>{assert.equal(x,'blob:test');urls.push('revoked');}}
},{filename:'m2-player.js'});
const api=fakeWindow.EasyADBPlayers;
assert.equal(api.contractVersion,1);
assert.equal(api.active,'mse');
assert.equal(api.capabilities().mse,true);
assert.equal(api.capabilities().webcodecs.environmentReady,true);
assert.equal(api.capabilities().webcodecs.implemented,false);
assert.throws(()=>api.create('webcodecs',new VideoMock()),/尚未实现/);
assert.throws(()=>new api.WebCodecsPlayer(),/尚未实现/);
assert.throws(()=>api.create('unknown',new VideoMock()),/未知视频播放器/);

let states=[],errors=[];
const video=new VideoMock();
const player=api.create('mse',video,{onState:x=>states.push(x),onError:x=>errors.push(x)});
const mime='video/mp4; codecs="avc1.640028"';
assert.throws(()=>player.initialize({format:'h264',mime}),/仅接受 fMP4/);
player.initialize({format:'fmp4',mime});
assert.equal(states.at(-1),'initializing');
assert.equal(MediaSourceMock.last.readyState,'closed');
const chunk=new Uint8Array([0,1,2,3]);
player.append(chunk); // bytes may arrive before sourceopen; queue them safely
assert.equal(player.pendingBytes,4);
MediaSourceMock.last.open();
assert.equal(MediaSourceMock.last.source.received.length,1);
assert.deepEqual([...MediaSourceMock.last.source.received[0]],[0,1,2,3]);
assert.equal(player.pendingBytes,0);
assert(states.includes('ready'));
assert(states.includes('playing'));
assert.deepEqual(errors,[]);
player.destroy();
assert.equal(video.paused,true);
assert(urls.includes('revoked'));
player.append(chunk);
assert.equal(player.pendingBytes,0);
assert.throws(()=>player.initialize({format:'fmp4',mime}),/已经初始化或已结束/);
const unsupported=api.create('mse',new VideoMock());
assert.throws(()=>unsupported.initialize({format:'fmp4',mime:'video/mp4; codecs="avc1.DEAD00"'}),/不支持/);
unsupported.destroy();

// Sparse Android stream: when an idle display resumes after a long timestamp
// gap, seek into the LATEST playable range, not into the gap after range 0.
const idleVideo=new VideoMock();
const idlePlayer=api.create('mse',idleVideo,{onError:e=>errors.push(e)});
idlePlayer.initialize({format:'fmp4',mime});
MediaSourceMock.last.open();
const idleSB=MediaSourceMock.last.source;
const buffered=(ranges)=>({
  length:ranges.length,start:i=>ranges[i][0],end:i=>ranges[i][1]
});
idleSB.buffered=buffered([[0,0.95]]);
idleVideo.currentTime=0.55;
idlePlayer._pump();
assert.equal(idleVideo.currentTime,0.55); // legitimate static picture, do NOT seek constantly
idleVideo.currentTime=0.94;
idleVideo.emit('waiting');
assert.equal(idlePlayer._waitingAtEdge,true);
idleSB.buffered=buffered([[0,0.95],[8,8.18]]);
idleSB.emit('updateend');
assert(idleVideo.currentTime>=8&&idleVideo.currentTime<8.18,
  'must jump INSIDE latest range after a timestamp discontinuity');
assert.equal(idlePlayer._waitingAtEdge,false);
// When playback waits at the tail, another packet unblocks it without reconnecting.
idleVideo.currentTime=8.16;
idleVideo.emit('waiting');
idleSB.buffered=buffered([[0,0.95],[8,8.34]]);
idleSB.emit('updateend');
assert(idleVideo.currentTime>=8.2&&idleVideo.currentTime<8.34,
  'resume slightly behind the new live edge after waiting');
idlePlayer.destroy();
assert.equal(idleVideo.listeners.get('waiting').length,0);
assert.equal(idleVideo.listeners.get('stalled').length,0);
assert.deepEqual(errors,[]);


// Regression: source buffer append proceeds while chunks continue arriving.
// The live-edge maintenance MUST run even with a non-empty queue; the old
// early-return layout would leave a stalled playhead behind indefinitely.
const streamVideo=new VideoMock();
const streamPlayer=api.create('mse',streamVideo,{onError:e=>errors.push(e)});
streamPlayer.initialize({format:'fmp4',mime});
MediaSourceMock.last.open();
const streamSB=MediaSourceMock.last.source;
streamSB.appendBuffer=function(data){
  this.received.push(Buffer.from(data));
  this.updating=true; // mimic the asynchronous real SourceBuffer.
};
streamVideo.currentTime=0.1;
streamSB.buffered=buffered([[0,22]]);
streamPlayer.append(chunk);
streamPlayer.append(chunk);
assert.equal(streamSB.received.length,1);
assert.equal(streamPlayer.queue.length,1);
streamSB.updating=false;
streamSB.emit('updateend');
assert(streamVideo.currentTime>21.7,'the playhead must catch up even while another chunk is queued');
assert.equal(streamSB.received.length,2);
assert.equal(streamPlayer.queue.length,0);
// Do not discard scrcpy's default ~10s keyframe dependency with an 8s window.
// Async trim must complete before the pending chunk is appended.
streamSB.buffered=buffered([[0,32]]);
streamVideo.currentTime=31.7;
streamSB.updating=false;
let trimmedTo=null;
streamSB.remove=function(begin,end){
  trimmedTo=end;
  this.updating=true;
};
streamPlayer.append(chunk);
streamPlayer.append(chunk);
streamSB.updating=false;
streamSB.emit('updateend');
assert(trimmedTo>15&&trimmedTo<=16,
  'retain 16s of the video timeline, including a previous random access frame');
assert.equal(streamPlayer.queue.length,1,'do not append while buffer removal is active');
streamSB.buffered=buffered([[trimmedTo,32]]);
streamSB.updating=false;
streamSB.emit('updateend');
assert.equal(streamPlayer.queue.length,0,'resume queued append after async trim');
const streamDiag=streamPlayer.diagnostics();
assert.equal(streamDiag.sourceRanges,1);
assert(streamDiag.appendCalls>=4);
assert(streamDiag.completedUpdates>=3);
assert(streamDiag.rangeEnd===32);
assert.deepEqual(errors,[]);
streamPlayer.destroy();

console.log('MSE adapter contract and reserved WebCodecs stub: OK');
