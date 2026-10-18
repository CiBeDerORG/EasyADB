/* M2-05: client-side performance samples for one explicitly started session.
 * No ADB polling, independent timers, network calls or persistent storage.
 * A buffered edge is NOT an end-to-end device-to-screen latency estimate.
 */
(function(root){
'use strict';
class QualityMeter{
 constructor(now=0){
  this.started=now;this.lastAt=now;this.lastFrames=null;this.lastDrops=null;
  this.samples=[];this.totalBytes=0;this.lastFps=null;this.dropped=null;
 }
 recordBytes(n){if(Number.isSafeInteger(n)&&n>=0)this.totalBytes+=n;}
 sample(video,now,extra={}){
  const duration=(now-this.lastAt)/1000;
  let total=null,drops=null;
  if(video&&typeof video.getVideoPlaybackQuality==='function'){
   try{
    const q=video.getVideoPlaybackQuality();
    if(Number.isFinite(q.totalVideoFrames))total=q.totalVideoFrames;
    if(Number.isFinite(q.droppedVideoFrames))drops=q.droppedVideoFrames;
   }catch{}
  }
  if(total===null&&Number.isFinite(extra.renderedFrames))total=extra.renderedFrames;
  let fps=null,dropPct=null;
  if(duration>=0.25&&this.lastFrames!==null&&total!==null){
   const frames=Math.max(0,total-this.lastFrames);
   fps=frames/duration;
   if(this.lastDrops!==null&&drops!==null){
    const delta=Math.max(0,drops-this.lastDrops);
    dropPct=frames+delta>0?100*delta/(frames+delta):0;
   }
  }
  let bufferAhead=null;
  try{
   if(video&&video.buffered&&video.buffered.length){
    bufferAhead=Math.max(0,video.buffered.end(video.buffered.length-1)-video.currentTime);
   }
  }catch{}
  const value={
   fps,dropPct,bufferAhead,renderedFrames:total,droppedFrames:drops,
   playbackAgeMs:Number.isFinite(extra.frameAgeMs)?extra.frameAgeMs:null,
   receiveMbps:Number.isFinite(extra.receiveMbps)?extra.receiveMbps:null,
   queueBytes:Number.isFinite(extra.queueBytes)?extra.queueBytes:null,
   elapsedSeconds:Math.max(0,(now-this.started)/1000),totalBytes:this.totalBytes
  };
  if(duration>=0.25){
   this.lastAt=now;this.lastFrames=total;this.lastDrops=drops;
  }
  if(fps!==null)this.lastFps=fps;
  if(drops!==null)this.dropped=drops;
  if(this.samples.length>=3600)this.samples.shift();
  this.samples.push(value);
  return value;
 }
 summary(profile,device){
  const avg=(key)=>{const xs=this.samples.map(x=>x[key]).filter(Number.isFinite);return xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;};
  return {profile,device,seconds:Math.max(0,(this.lastAt-this.started)/1000),
   totalBytes:this.totalBytes,avgFps:avg('fps'),avgDropPct:avg('dropPct'),
   avgReceiveMbps:avg('receiveMbps'),avgBufferSeconds:avg('bufferAhead'),
   maxQueueBytes:Math.max(0,...this.samples.map(x=>x.queueBytes||0))};
 }
}
function fmt(value,digits=1){return Number.isFinite(value)?value.toFixed(digits):'—';}
function format(s){
 return '实测播放帧率 '+fmt(s.fps)+' FPS / 窗口掉帧率 '+fmt(s.dropPct)+'%'+
  '｜缓冲余量 '+fmt(s.bufferAhead,2)+'s / 最新画面距今 '+fmt(s.playbackAgeMs,0)+'ms'+
  '｜载荷速度 '+fmt(s.receiveMbps,2)+' Mbps / 待追加 '+(s.queueBytes??'—')+' B'+
  '（均为浏览器侧测量，不代表手机到屏幕的端到端延迟）';
}
root.EasyADBMetrics=Object.freeze({QualityMeter,fmt,format});
})(window);
