/* Test the actual browser WebRTC player in a completely local peer mock. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
class Video {
 constructor(){this.handlers=new Map();this.currentTime=0;this.playbackRate=1;this.paused=true;}
 addEventListener(t,fn){this.handlers.set(t,fn);}
 removeEventListener(t){this.handlers.delete(t);}
 play(){this.paused=false;this.handlers.get('playing')?.();return Promise.resolve();}
 pause(){this.paused=true;}
}
class Peer {
 constructor(config){assert.deepEqual([...config.iceServers],[]);this.iceGatheringState='complete';
  this.connectionState='new';this.sdp=null;this.handlers=new Map();Peer.last=this;}
 addTransceiver(kind,opts){assert.equal(kind,'video');assert.equal(opts.direction,'recvonly');
  return {setCodecPreferences:codecs=>{assert(codecs.every(x=>x.mimeType==='video/H264'));}};
 }
 async createOffer(){return {type:'offer',sdp:'v=0\\r\\nm=video 9 UDP/TLS/RTP/SAVPF 102\\r\\na=recvonly\\r\\n'};}
 async setLocalDescription(d){this.localDescription=d;}
 async setRemoteDescription(d){this.remoteDescription=d;}
 async getStats(){return new Map([['video',{type:'inbound-rtp',kind:'video',bytesReceived:1234,framesDecoded:8,framesDropped:1}]]);}
 // Match the browser API exactly: native close() is synchronous and returns undefined.
 close(){this.connectionState='closed';this.closeCount=(this.closeCount||0)+1;}
 addEventListener(t,fn){this.handlers.set(t,fn);}
 removeEventListener(t){this.handlers.delete(t);}
}
const win={setTimeout,clearTimeout};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../web/m2-webrtc.js'),'utf8'),{
 window:win,RTCPeerConnection:Peer,RTCRtpReceiver:{getCapabilities:()=>({codecs:[{mimeType:'video/VP8'},
 {mimeType:'video/H264',clockRate:90000}]})},WebSocket:{OPEN:1},MediaStream:class{},
});
(async()=>{
 const video=new Video(),states=[],errs=[];
 const p=win.EasyADBWebRTC.create(video,{onState:s=>states.push(s),onError:s=>errs.push(s)});
 const writes=[],ws={readyState:1,send:x=>writes.push(JSON.parse(x))};
 await p.start(ws,'session-1');
 assert.equal(writes.length,1);assert.equal(writes[0].type,'webrtc_offer');
 assert.equal(writes[0].session_id,'session-1');
 await p.answer('v=0\\r\\na=sendonly\\r\\n');
 assert.equal(Peer.last.remoteDescription.type,'answer');
 Peer.last.ontrack({streams:[{id:'remote'}],track:{}});
 assert.equal(video.srcObject.id,'remote');
 assert(states.includes('playing'));
 let rx=0;await p.pollStats(n=>rx+=n);
 assert.equal(rx,1234);assert.equal(p.diagnostics().webrtcFrames,8);
 await p.pollStats(n=>rx+=n);assert.equal(rx,1234,'stats must be deltas, not double-counted');
 // The mock close() returns undefined, exactly like native RTCPeerConnection.close().
 assert.doesNotThrow(()=>p.destroy(),'native synchronous close must never interrupt card cleanup');
 assert.equal(Peer.last.closeCount,1,'peer closed exactly once');
 assert.equal(Peer.last.ontrack,null);
 assert.equal(Peer.last.onconnectionstatechange,null);
 assert.equal(video.srcObject,null);
 assert.equal(video.handlers.has('playing'),false);
 assert.doesNotThrow(()=>p.destroy(),'destroy remains idempotent');
 assert.equal(Peer.last.closeCount,1,'repeat destroy must not close peer twice');
 assert.deepEqual(errs,[]);
 console.log('WebRTC player offer/answer, H264, stats and cleanup: OK');
})().catch(e=>{console.error(e);process.exitCode=1;});
