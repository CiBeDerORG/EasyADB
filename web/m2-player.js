/* EasyADB M2 video player boundary.
 * v1 implementation: MSE consumes H.264 fragmented MP4 (fMP4).
 * Reserved WebCodecs contract: a future raw H.264 framing/decoder path.
 * Do not make WebCodecs selectable until BOTH ends implement that protocol.
 */
(function(root){
'use strict';
const MAX_PENDING_BYTES = 12 * 1024 * 1024;

class MSEPlayer {
  constructor(video, callbacks={}){
    this.video=video;
    this.onState=callbacks.onState||(()=>{});
    this.onError=callbacks.onError||(()=>{});
    this.mediaSource=null;
    this.sourceBuffer=null;
    this.objectUrl=null;
    this.queue=[];
    this.pendingBytes=0;
    this.closed=false;
    this._lastBufferedEnd=0;
    this._waitingAtEdge=false;
    this._appendCalls=0;
    this._completedUpdates=0;
    this._lastUpdateAt=null;
    this._onSourceOpen=null;
    this._onUpdateEnd=null;
    this._onSourceError=null;
    this._onPlaying=()=>{if(!this.closed){this._waitingAtEdge=false;this.onState('playing');}};
    this._onVideoError=()=>{if(!this.closed)this.onError('浏览器视频解码失败，请尝试基础档或更新浏览器。');};
    // A still Android screen may provide fewer frames than moving content.
    // A video at the buffered edge is allowed to wait: recover only AFTER a
    // newer fragment arrives; never inject touches or restart ADB.
    this._onWaiting=()=>{
      if(this.closed)return;
      const sb=this.sourceBuffer;
      try{
        const ranges=sb&&sb.buffered;
        this._waitingAtEdge=!ranges||!ranges.length||
          this.video.currentTime>=ranges.end(ranges.length-1)-0.15;
      }catch{this._waitingAtEdge=true;}
    };
    this.video.addEventListener('playing',this._onPlaying);
    this.video.addEventListener('waiting',this._onWaiting);
    this.video.addEventListener('stalled',this._onWaiting);
    this.video.addEventListener('error',this._onVideoError);
  }
  initialize(metadata){
    if(this.closed||this.mediaSource)throw Error('播放器已经初始化或已结束');
    const {format,mime}=metadata||{};
    if(format!=='fmp4'||typeof mime!=='string'||!mime.startsWith('video/mp4;')){
      throw Error('MSE 播放器仅接受 fMP4/H.264 视频格式');
    }
    if(typeof MediaSource==='undefined'||!MediaSource.isTypeSupported(mime)){
      throw Error('当前浏览器不支持 '+mime+' 的 MSE 播放。请尝试新版 Chrome/Edge。');
    }
    const ms=new MediaSource();
    this.mediaSource=ms;
    this.objectUrl=URL.createObjectURL(ms);
    this.video.muted=true;
    this.video.playsInline=true;
    this.video.src=this.objectUrl;
    this._onSourceOpen=()=>{
      if(this.closed||this.mediaSource!==ms||ms.readyState!=='open')return;
      try{
        const sb=ms.addSourceBuffer(mime);
        sb.mode='segments';
        this.sourceBuffer=sb;
        this._onUpdateEnd=()=>{
          if(this.closed)return;
          this._completedUpdates++;
          this._lastUpdateAt=Date.now();
          this._pump();
          this._play();
        };
        this._onSourceError=()=>{if(!this.closed)this.onError('浏览器 MSE 视频解码缓冲区发生错误。');};
        sb.addEventListener('updateend',this._onUpdateEnd);
        sb.addEventListener('error',this._onSourceError);
        this.onState('ready');
        this._pump();
      }catch(error){
        this.onError('无法初始化 MSE 视频缓冲区：'+error.message);
      }
    };
    ms.addEventListener('sourceopen',this._onSourceOpen,{once:true});
    this.onState('initializing');
  }
  append(chunk){
    if(this.closed)return;
    if(!this.mediaSource)throw Error('MSE 初始化消息尚未到达');
    if(!(chunk instanceof Uint8Array)||!chunk.byteLength)return;
    this.pendingBytes+=chunk.byteLength;
    if(this.pendingBytes>MAX_PENDING_BYTES){
      this.onError('实时画面缓存积压超过 12 MiB，已停止本轮会话。');
      return;
    }
    this.queue.push(chunk);
    this._pump();
  }
  _maintainLivePosition(){
    const sb=this.sourceBuffer;
    if(!sb||sb.updating)return false;
    try{
      const ranges=sb.buffered;
      if(!ranges.length)return false;
      const start=ranges.start(0), latest=ranges.length-1;
      const latestStart=ranges.start(latest), end=ranges.end(latest);
      const position=this.video.currentTime;
      const newer=end>this._lastBufferedEnd+0.015;
      // Recheck on EVERY completed append, even when another network chunk
      // is already queued. The former implementation returned immediately
      // whenever queue.length > 0, starving live-edge recovery and trimming
      // throughout a continuous stream.
      const outsideLatest=position<latestStart-0.03||
        (newer&&position>end+0.03);
      const fallingBehind=end-position>2.5;
      const recovering=this._waitingAtEdge&&newer&&
        position>=this._lastBufferedEnd-0.15;
      if(outsideLatest||fallingBehind||recovering){
        const target=Math.max(latestStart,end-(recovering?0.08:0.15));
        if(Math.abs(target-position)>0.02)this.video.currentTime=target;
        this._waitingAtEdge=false;
      }
      this._lastBufferedEnd=end;
      // scrcpy defaults to approximately 10 seconds between keyframes.
      // Preserve >=16s of the *media timeline* instead of pruning to 8s:
      // overly aggressive eviction may discard the last random-access frame.
      const oldEnd=Math.min(end-16,this.video.currentTime-0.7);
      if(end-start>24&&oldEnd>start){
        sb.remove(0,oldEnd);
        return true; // remove() is async; next updateend resumes appending.
      }
    }catch(error){
      this.onError('无法维护 MSE 实时缓冲区：'+error.message);
      return true;
    }
    return false;
  }
  _pump(){
    const sb=this.sourceBuffer,ms=this.mediaSource;
    if(this.closed||!sb||sb.updating||!ms||ms.readyState!=='open')return;
    if(this._maintainLivePosition())return;
    if(this.closed||sb.updating)return;
    if(this.queue.length){
      const next=this.queue.shift();
      this.pendingBytes-=next.byteLength;
      try{
        sb.appendBuffer(next);
        this._appendCalls++;
      }catch(error){this.onError('视频片段追加失败：'+error.message);}
    }
  }
  diagnostics(){
    const sb=this.sourceBuffer,ms=this.mediaSource,v=this.video;
    const ranges=sb&&sb.buffered;
    const data={
      sourceState:ms?ms.readyState:'未初始化',
      sourceBufferReady:Boolean(sb),
      updating:Boolean(sb&&sb.updating),
      queueChunks:this.queue.length,
      queueBytes:this.pendingBytes,
      appendCalls:this._appendCalls,
      completedUpdates:this._completedUpdates,
      updateIdleMs:this._lastUpdateAt===null?null:Math.max(0,Date.now()-this._lastUpdateAt),
      sourceRanges:0,rangeStart:null,latestStart:null,rangeEnd:null,
      currentTime:v.currentTime,paused:v.paused,seeking:Boolean(v.seeking),
      videoError:v.error?v.error.code:null
    };
    try{
      if(ranges&&ranges.length){
        data.sourceRanges=ranges.length;
        data.rangeStart=ranges.start(0);
        data.latestStart=ranges.start(ranges.length-1);
        data.rangeEnd=ranges.end(ranges.length-1);
      }
    }catch{}
    return data;
  }
  _play(){
    if(this.closed||!this.sourceBuffer)return;
    const result=this.video.play();
    if(result&&typeof result.catch==='function'){
      result.catch(()=>{if(!this.closed)this.onState('autoplay-blocked');});
    }
  }
  resume(){if(!this.closed)this._play();}
  destroy(){
    if(this.closed)return;
    this.closed=true;
    this.video.removeEventListener('playing',this._onPlaying);
    this.video.removeEventListener('waiting',this._onWaiting);
    this.video.removeEventListener('stalled',this._onWaiting);
    this.video.removeEventListener('error',this._onVideoError);
    const ms=this.mediaSource,sb=this.sourceBuffer;
    if(ms&&this._onSourceOpen)ms.removeEventListener('sourceopen',this._onSourceOpen);
    if(sb){
      if(this._onUpdateEnd)sb.removeEventListener('updateend',this._onUpdateEnd);
      if(this._onSourceError)sb.removeEventListener('error',this._onSourceError);
      try{if(sb.updating)sb.abort();}catch{}
    }
    this.queue=[];this.pendingBytes=0;
    try{this.video.pause();this.video.removeAttribute('src');this.video.load();}catch{}
    if(this.objectUrl)URL.revokeObjectURL(this.objectUrl);
    this.mediaSource=null;this.sourceBuffer=null;this.objectUrl=null;
  }
}

// Reserved API only. Future implementation must decode *raw framed H.264*,
// not the current server's fMP4 byte stream. Keep capability=false for now.
class WebCodecsPlayer {
  static get implemented(){return false;}
  constructor(){throw Error('WebCodecs 播放器尚未实现，请继续使用 MSE。');}
  initialize(){throw Error('WebCodecs 未实现');}
  append(){throw Error('WebCodecs 未实现');}
  resume(){}
  destroy(){}
}

const CONTRACT_VERSION=1;
const capabilities=()=>({
  contractVersion:CONTRACT_VERSION,
  mse:typeof MediaSource!=='undefined',
  webcodecs:{
    environmentReady:Boolean(root.isSecureContext&&typeof root.VideoDecoder!=='undefined'),
    implemented:WebCodecsPlayer.implemented
  }
});
const create=(kind,video,callbacks)=>{
  if(kind==='mse')return new MSEPlayer(video,callbacks);
  if(kind==='webcodecs')throw Error('WebCodecs 播放器接口已预留但尚未实现，当前版本不能启用。');
  throw Error('未知视频播放器：'+kind);
};
root.EasyADBPlayers=Object.freeze({
  contractVersion:CONTRACT_VERSION,
  active:'mse',
  capabilities,
  create,
  MSEPlayer,
  WebCodecsPlayer
});
})(window);
