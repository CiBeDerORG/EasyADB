/* M1 trusted-network mapping viewer. No admin token or management API. */
(()=>{
'use strict';
const $=id=>document.getElementById(id);
const mappingId=location.pathname.match(/^\/m\/([A-Za-z0-9_-]{12,80})$/)?.[1];
const status=$('status'),screen=$('screen'),video=$('video'),fab=$('fab'),panel=$('panel');
let socket=null,player=null,touch=null,session=null,size=null,ready=false,enabled=false,pending=false,closed=false;
let lastInput=false,menuOpen=false;
const setStatus=message=>{status.textContent=message;};
function refresh(){
 const connected=!closed&&socket&&socket.readyState===WebSocket.OPEN&&session&&ready;
 $('toggle').disabled=!connected||pending;
 $('toggle').textContent=enabled?'⏻ 开':'⏻';
 $('toggle').title=enabled?'关闭远控':'启用远控';
 $('textButton').disabled=!connected||!enabled;
 for(const name of ['back','home','recents','enter','backspace'])$(name).disabled=!connected||!enabled||lastInput;
 $('wake').disabled=!connected;
}
function send(type,extra={}){
 if(closed||!socket||socket.readyState!==WebSocket.OPEN||!session)return;
 socket.send(JSON.stringify({type,session_id:session,...extra}));
}
function collapse(){menuOpen=false;fab.classList.remove('open');$('menu').setAttribute('aria-expanded','false');panel.hidden=true;}
function end(message){
 if(closed)return;closed=true;ready=false;enabled=false;pending=false;
 if(touch){touch.destroy();touch=null;}
 if(player){player.destroy();player=null;}
 if(socket){const ws=socket;socket=null;ws.onmessage=null;ws.onclose=null;ws.onerror=null;try{ws.close();}catch{}}
 collapse();refresh();setStatus(message||'映射连接已结束');$('detail').textContent='返回管理员页面重新开启或检查源设备实时画面。';
}
if(!mappingId){end('映射地址无效');return;}
$('menu').addEventListener('click',()=>{if(closed)return;menuOpen=!menuOpen;fab.classList.toggle('open',menuOpen);$('menu').setAttribute('aria-expanded',String(menuOpen));if(!menuOpen)panel.hidden=true;});
$('toggle').addEventListener('click',()=>{if($('toggle').disabled)return;pending=true;
 if(enabled){enabled=false;touch?.disable();send('control_disable');}else send('control_enable');
 refresh();
});
$('wake').addEventListener('click',()=>send('wake'));
$('textButton').addEventListener('click',()=>{if(!enabled)return;panel.hidden=!panel.hidden;if(!panel.hidden)$('input').focus();});
$('closePanel').addEventListener('click',()=>panel.hidden=true);
$('fullscreen').addEventListener('click',()=>{const action=document.fullscreenElement?document.exitFullscreen():screen.requestFullscreen();Promise.resolve(action).catch(()=>setStatus('浏览器未允许全屏'));});
document.addEventListener('fullscreenchange',()=>{$('fullscreen').textContent=document.fullscreenElement?'↙':'⛶';});
function key(name){if(!enabled||lastInput)return;lastInput=true;send('nav_key',{key:name});refresh();}
for(const name of ['back','home','recents','enter','backspace'])$(name).addEventListener('click',()=>key(name));
panel.addEventListener('submit',event=>{event.preventDefault();if(!enabled||lastInput)return;
 const value=$('input').value;
 if(!/^[\x20-\x7e]{1,300}$/.test(value)){setStatus('仅支持 1～300 字符的 ASCII 可打印文本');return;}
 lastInput=true;send('input_text',{text:value});refresh();
});
video.addEventListener('click',()=>player?.resume());
try{
 player=EasyADBWebRTC.create(video,{onState:stage=>{
  if(stage==='playing')setStatus('映射画面播放中');
  if(stage==='autoplay-blocked')setStatus('请点击画面允许播放');
 },onError:reason=>end(reason)});
 const scheme=location.protocol==='https:'?'wss:':'ws:';
 socket=new WebSocket(scheme+'//'+location.host+'/ws/'+encodeURIComponent(mappingId));
 socket.onopen=()=>setStatus('正在协商 WebRTC 媒体连接…');
 socket.onmessage=event=>{
  if(closed||typeof event.data!=='string')return;
  let msg;try{msg=JSON.parse(event.data);}catch{end('映射消息格式无效');return;}
  if(session&&msg.session_id&&session!==msg.session_id){end('映射会话已变更');return;}
  if(msg.type==='starting'){
   session=msg.session_id;
   player.start(socket,session).catch(error=>end('WebRTC 建立失败：'+error.message));
  }else if(msg.type==='webrtc_answer'){
   player.answer(msg.sdp).catch(error=>end('WebRTC Answer 失败：'+error.message));
  }else if(msg.type==='init'){
   if(!Number.isInteger(msg.width)||!Number.isInteger(msg.height)||msg.width<1||msg.height<1){end('视频尺寸无效');return;}
   size={width:msg.width,height:msg.height};
   screen.style.aspectRatio=msg.width+' / '+msg.height;
   screen.style.width='min(100%, '+msg.width+'px)';
   try{player.initialize(msg);}catch(error){end(error.message);return;}
   touch=EasyADBTouch.create(video,p=>{if(enabled&&ready)send(p.type,p);});
   ready=msg.control_available===true;
   setStatus('映射已就绪 · '+msg.width+' × '+msg.height);refresh();
  }else if(msg.type==='control_enabled'){
   pending=false;
   try{touch.enable(size);enabled=true;}catch(error){setStatus(error.message);}
   refresh();
  }else if(msg.type==='control_disabled'){
   pending=false;enabled=false;touch?.disable();refresh();
  }else if(msg.type==='input_accepted'){
   lastInput=false;if(msg.kind==='input_text')$('input').value='';refresh();
  }else if(msg.type==='input_error'||msg.type==='touch_error'||msg.type==='wake_error'){
   lastInput=false;pending=false;setStatus(msg.message||'操作失败');refresh();
  }else if(msg.type==='wake_accepted'){setStatus('已发送唤醒指令');}
  else if(msg.type==='error'){end(msg.message||'映射连接失败');}
 };
 socket.onclose=()=>end('映射已关闭或当前观看连接已断开');
 socket.onerror=()=>setStatus('映射连接发生网络错误');
}catch(error){end('无法连接映射页面：'+error.message);}
window.addEventListener('pagehide',()=>end('页面已关闭'));
})();
