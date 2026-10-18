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
    this._onSourceOpen=null;
    this._onUpdateEnd=null;
    this._onSourceError=null;
    this._onPlaying=()=>{if(!this.closed)this.onState('playing');};
    this._onVideoError=()=>{if(!this.closed)this.onError('浏览器视频解码失败，请尝试基础档或更新浏览器。');};
    this.video.addEventListener('playing',this._onPlaying);
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
        this._onUpdateEnd=()=>{if(!this.closed){this._pump();this._play();}};
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
  _pump(){
    const sb=this.sourceBuffer, ms=this.mediaSource;
    if(this.closed||!sb||sb.updating||!ms||ms.readyState!=='open')return;
    if(this.queue.length){
      const next=this.queue.shift();
      this.pendingBytes-=next.byteLength;
      try{sb.appendBuffer(next);}
      catch(error){this.onError('视频片段追加失败：'+error.message);}
      return;
    }
    try{
      const ranges=sb.buffered;
      if(!ranges.length)return;
      const start=ranges.start(0), end=ranges.end(ranges.length-1);
      // Stay near the live edge, rather than playing a long stale buffer.
      if(end-this.video.currentTime>2.5 || this.video.currentTime<start){
        this.video.currentTime=Math.max(start,end-0.45);
      }
      const oldEnd=Math.min(end-8,this.video.currentTime-0.7);
      if(oldEnd>start && end-start>12)sb.remove(0,oldEnd);
    }catch(error){
      this.onError('无法更新实时播放位置：'+error.message);
    }
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
  if(kind==='webcodecs')throw Error('WebCodecs 播放器已预留接口，当前版本不能启用。');
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
