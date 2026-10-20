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
   if(this.lastDrops!==null&&drops!==null){
    // getVideoPlaybackQuality.totalVideoFrames INCLUDES dropped frames.
    const delta=Math.max(0,drops-this.lastDrops);
    fps=Math.max(0,frames-delta)/duration;
    dropPct=frames>0?100*delta/frames:0;
   }else fps=frames/duration;
  }
  const value={
   fps,dropPct,renderedFrames:total,droppedFrames:drops,
   playbackAgeMs:Number.isFinite(extra.frameAgeMs)?extra.frameAgeMs:null,
   receiveMbps:Number.isFinite(extra.receiveMbps)?extra.receiveMbps:null,
   procCpuPct:Number.isFinite(extra.procCpuPct)?extra.procCpuPct:null,
   procRssMib:Number.isFinite(extra.procRssMib)?extra.procRssMib:null,
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
   avgReceiveMbps:avg('receiveMbps'),
   avgCpuPct:avg('procCpuPct'),avgRssMib:avg('procRssMib')};
 }
}
function fmt(value,digits=1){return Number.isFinite(value)?value.toFixed(digits):'—';}
function advice(s){
 // Data-derived suggestion only. Static Android screens can have 0 FPS and
 // low received bitrate without any stream failure: never infer from those.
 if(Number.isFinite(s.dropPct)&&s.dropPct>=5)
  return '近期掉帧偏高；可在停止后尝试降低分辨率或最高帧率';
 return '暂未发现明确的画质降档信号（不会自动调整）';
}
function format(s){
 return '实测播放帧率 '+fmt(s.fps)+' FPS / 窗口掉帧率 '+fmt(s.dropPct)+'%'+
  '｜最新画面距今 '+fmt(s.playbackAgeMs,0)+'ms'+
  '｜WebRTC 接收速度 '+fmt(s.receiveMbps,2)+' Mbps'+
  '（均为浏览器侧测量，不代表手机到屏幕的端到端延迟）';
}
root.EasyADBMetrics=Object.freeze({QualityMeter,fmt,format,advice});
})(window);
