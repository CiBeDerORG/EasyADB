/* EasyADB M2 optional WebRTC receiver. Video and controls share the existing
 * authenticated per-device WS, but video bytes are DTLS-SRTP / ICE, not WS/MSE.
 * No local camera/mic permissions, WebCodecs, or implicit reconnect.
 */
(function(root){
'use strict';
class WebRTCPlayer {
 constructor(video,callbacks={}){
  this.video=video;
  this.onState=callbacks.onState||(()=>{});
  this.onError=callbacks.onError||(()=>{});
  this.pc=null;this.closed=false;this.session=null;
  this.bytesReceived=0;this.lastCount=0;
  this.framesDecoded=null;this.framesDropped=null;this.lastPacketAt=null;
  this._onPlaying=()=>{if(!this.closed)this.onState('playing');};
  video.addEventListener('playing',this._onPlaying);
 }
 async start(ws,session){
  if(this.closed||this.pc||!session)throw Error('WebRTC 会话状态无效');
  if(typeof RTCPeerConnection!=='function')throw Error('此浏览器未提供 WebRTC 接口');
  this.session=session;
  const pc=new RTCPeerConnection({iceServers:[]});this.pc=pc;
  pc.ontrack=e=>{
   if(this.closed||pc!==this.pc)return;
   this.video.srcObject=e.streams&&e.streams[0]?e.streams[0]:new MediaStream([e.track]);
   this.video.play().catch(()=>{if(!this.closed)this.onState('autoplay-blocked');});
  };
  pc.onconnectionstatechange=()=>{
   if(this.closed||pc!==this.pc)return;
   if(pc.connectionState==='failed')this.onError('WebRTC 连接失败，请检查 NAS ICE UDP 地址及 EasyTier 路由');
   if(pc.connectionState==='connected')this.onState('ready');
  };
  const transceiver=pc.addTransceiver('video',{direction:'recvonly'});
  const caps=RTCRtpReceiver.getCapabilities('video');
  const h264=caps&&caps.codecs.filter(c=>c.mimeType.toLowerCase()==='video/h264');
  if(!h264||!h264.length)throw Error('浏览器不支持 WebRTC H.264 解码');
  transceiver.setCodecPreferences(h264);
  const offer=await pc.createOffer();
  if(this.closed)return;
  await pc.setLocalDescription(offer);
  // aiortc answers with all ICE candidates embedded; wait for local gathering
  // to finish so non-trickle SDP contains browser candidates as well.
  if(pc.iceGatheringState!=='complete')await new Promise((resolve,reject)=>{
   const timer=root.setTimeout(()=>{pc.removeEventListener('icegatheringstatechange',changed);
    reject(Error('浏览器 ICE 收集超时'));},12000);
   const changed=()=>{if(pc.iceGatheringState==='complete'){
    root.clearTimeout(timer);pc.removeEventListener('icegatheringstatechange',changed);resolve();
   }};
   pc.addEventListener('icegatheringstatechange',changed);
   changed();
  });
  if(this.closed||ws.readyState!==WebSocket.OPEN)return;
  ws.send(JSON.stringify({type:'webrtc_offer',session_id:session,sdp:pc.localDescription.sdp}));
  this.onState('initializing');
 }
 async answer(sdp){
  if(this.closed||!this.pc||typeof sdp!=='string'||sdp.length>24000)
   throw Error('WebRTC Answer 无效');
  await this.pc.setRemoteDescription({type:'answer',sdp});
 }
 initialize(metadata){
  if(this.closed||metadata?.player!=='webrtc')throw Error('WebRTC 初始化信息无效');
  this.onState('ready');
 }
 async pollStats(recordBytes){
  if(!this.pc||this.closed)return;
  const pc=this.pc;
  try{
   const report=await pc.getStats();
   if(this.closed||pc!==this.pc)return;
   for(const stat of report.values()){
    if(stat.type!=='inbound-rtp'||(stat.kind!=='video'&&stat.mediaType!=='video'))continue;
    const total=Number(stat.bytesReceived);
    if(Number.isFinite(total)&&total>=0){
     const delta=Math.max(0,total-this.lastCount);
     this.lastCount=total;this.bytesReceived=total;
     if(delta)recordBytes(delta);
    }
    if(Number.isFinite(stat.framesDecoded))this.framesDecoded=stat.framesDecoded;
    if(Number.isFinite(stat.framesDropped))this.framesDropped=stat.framesDropped;
    if(Number.isFinite(stat.lastPacketReceivedTimestamp))
     this.lastPacketAt=stat.lastPacketReceivedTimestamp;
    break;
   }
  }catch{} // statistics must never interrupt an active media/control session
 }
 diagnostics(){
  const pc=this.pc,v=this.video;
  return {sourceState:pc?pc.connectionState:'未初始化',
   videoError:v.error?v.error.code:null,
   webrtcBytes:this.bytesReceived,webrtcFrames:this.framesDecoded,
   webrtcDrops:this.framesDropped};
 }
 resume(){if(!this.closed)this.video.play().catch(()=>this.onState('autoplay-blocked'));}
 destroy(){
  if(this.closed)return;this.closed=true;
  this.video.removeEventListener('playing',this._onPlaying);
  const pc=this.pc;this.pc=null;
  if(pc){
   pc.ontrack=null;pc.onconnectionstatechange=null;
   // Browser RTCPeerConnection.close() is synchronous and returns undefined,
   // not a Promise. A .catch() here interrupted MultiView.end(), leaving a
   // stale black card, disabled stop button and floating controls behind.
   try{pc.close();}catch{} // local DOM/WS cleanup must continue even on failure
  }
  try{this.video.pause();this.video.srcObject=null;}catch{}
 }
}
root.EasyADBWebRTC=Object.freeze({create:(video,callbacks)=>new WebRTCPlayer(video,callbacks),WebRTCPlayer});
})(window);
