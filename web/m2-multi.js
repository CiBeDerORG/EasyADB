/* M2-06: one-page, multi-phone viewing. Every card owns its player, socket,
 * traffic, metrics, touch and current session. No cross-browser takeover,
 * background reconnect, global keyboard capture or automatic ADB connect.
 */
(function(root){
'use strict';
const MAX_DEVICES=4;
const KEYS=[['back','返回'],['home','主页'],['recents','最近任务'],['enter','回车'],['backspace','退格']];
const make=(tag,cls='',label)=>{
 const e=document.createElement(tag);
 if(cls)e.className=cls;
 if(label!==undefined)e.textContent=label;
 return e;
};
const fmt=v=>root.EasyADBMetrics.fmt(v);
class MultiView{
 constructor({picker,grid,startButton,stopButton,info,getDevices,getToken,getQuality,getSoloActive,onChange}){
  Object.assign(this,{picker,grid,startButton,stopButton,info,getDevices,getToken,getQuality,getSoloActive,onChange});
  this.selected=new Set();this.cards=new Map();this.opening=false;this.launchQueue=[];
  startButton.addEventListener('click',()=>this.start());
  stopButton.addEventListener('click',()=>this.stopAll());
  this.updatePicker();
 }
 status(msg,error=false){this.info.textContent=msg;this.info.className='status'+(error?' error':'');}
 updatePicker(){
  const devices=this.getDevices()||[];
  const ids=new Set(devices.filter(d=>d.status==='connected'&&d.active_serial===d.selected_serial).map(d=>d.id));
  for(const id of this.selected)if(!ids.has(id)&&!this.cards.has(id))this.selected.delete(id);
  this.picker.replaceChildren();
  for(const d of devices){
   const item=make('label','multi-choice');
   const check=make('input');check.type='checkbox';check.value=d.id;
   check.checked=this.selected.has(d.id);
   const active=this.cards.has(d.id);
   const connected=ids.has(d.id);
   check.disabled=active||(!connected&&!active)||this.opening||
    (!check.checked&&this.selected.size>=MAX_DEVICES)||Boolean(this.getSoloActive());
   check.addEventListener('change',()=>{
    if(check.checked)this.selected.add(d.id);else this.selected.delete(d.id);
    this.updatePicker();
   });
   const name=make('span','',d.name+' · '+(connected?d.selected_serial:'未手动连接'));
   item.append(check,name);
   if(!connected)item.classList.add('multi-unavailable');
   this.picker.append(item);
  }
  const available=[...this.selected].filter(id=>ids.has(id)&&!this.cards.has(id));
  this.startButton.disabled=this.opening||this.cards.size>0||this.getSoloActive()||
   available.length<2||available.length>MAX_DEVICES;
  this.stopButton.disabled=this.cards.size===0;
  this.startButton.textContent='开始同屏（'+available.length+' / '+MAX_DEVICES+'）';
 }
 hasActive(){return this.cards.size>0;}
 start(){
  if(this.opening||this.hasActive()||this.getSoloActive())return;
  const ds=this.getDevices()||[];
  const selected=[...this.selected].map(id=>ds.find(d=>d.id===id));
  if(selected.length<2||selected.length>MAX_DEVICES||
     selected.some(d=>!d||d.status!=='connected'||!d.selected_serial||
       d.active_serial!==d.selected_serial)){
   this.status('请先逐台手动连接，再勾选 2～4 台已连接设备。',true);this.updatePicker();return;
  }
  if(!this.getToken()){this.status('请先填写访问密钥并加载设备。',true);return;}
  const quality=this.getQuality();
  this.opening=true;
  // One explicit user request, staggered by authenticated server "init"
  // completion. Avoid pushing/initializing 2-4 scrcpy+FFmpeg pipelines
  // at the same instant; do not create timers or background reconnect jobs.
  this.launchQueue=selected.map(d=>({device:d,quality}));
  this.status('正在依次启动 '+selected.length+' 路独立投屏；每路控制仍需手动启用。');
  this._launchNext();
  this.updatePicker();this.onChange();
 }
 _launchNext(){
  if(!this.opening)return;
  const next=this.launchQueue.shift();
  if(!next){
   this.opening=false;this.updatePicker();this.onChange();return;
  }
  this.open(next.device,next.quality,()=>this._launchNext());
 }
 open(d,quality,nextLaunch){
  const card={id:d.id,serial:d.selected_serial,name:d.name,quality,ws:null,session:null,
   state:'connecting',closed:false,enabled:false,pending:false,ready:false,size:null,
   touch:null,player:null,video:null,meter:new root.EasyADBTraffic.Meter(performance.now()),
   metrics:new root.EasyADBMetrics.QualityMeter(performance.now()),lastInput:false,
   startSettled:false,nextLaunch};
  const box=make('article','multi-card'),header=make('div','heading');
  header.append(make('strong','',d.name),make('span','muted',d.selected_serial));
  const video=make('video','multi-video');video.autoplay=true;video.muted=true;
  video.playsInline=true;video.setAttribute('aria-label',d.name+' 实时画面');
  const state=make('div','status','正在建立本轮会话…');
  const stats=make('div','muted','等待浏览器诊断…');
  const buttons=make('div','buttons');
  const toggle=make('button','secondary','启用远程控制'),stop=make('button','danger','停止此路');
  toggle.type='button';stop.type='button';toggle.disabled=true;
  buttons.append(toggle,stop);
  const form=make('form','multi-text'),input=make('input'),submit=make('button','','发送文字');
  input.type='text';input.maxLength=300;input.autocomplete='off';input.placeholder='仅 ASCII，先启用此设备控制';
  submit.type='submit';input.disabled=true;submit.disabled=true;form.append(input,submit);
  const keys=make('div','buttons');
  const nav=[];
  for(const [key,label] of KEYS){
   const btn=make('button','secondary',label);btn.type='button';btn.disabled=true;
   btn.addEventListener('click',()=>this.sendInput(card,'nav_key',{key}));
   keys.append(btn);nav.push(btn);
  }
  const keyStatus=make('div','muted','默认只观看，不会全局捕获键盘。');
  box.append(header,video,state,stats,buttons,form,keys,keyStatus);
  this.grid.append(box);
  Object.assign(card,{box,video,stateEl:state,statsEl:stats,toggle,stop,input,submit,nav,keyStatus});
  this.cards.set(card.id,card);
  card.settleLaunch=()=>{
   if(card.startSettled)return;
   card.startSettled=true;
   if(this.opening&&card.nextLaunch)card.nextLaunch();
  };
  const mark=(msg,error=false)=>{
   state.textContent=msg;state.className='status'+(error?' error':'');
  };
  const refresh=()=>{
   // Control readiness belongs to scrcpy's control socket, not to the
   // browser decoder's "playing" event (which may be delayed/throttled).
   const canToggle=!card.closed&&card.ready&&
    (card.state==='ready'||card.state==='playing')&&!card.pending&&
    card.ws&&card.ws.readyState===WebSocket.OPEN&&Boolean(card.session);
   toggle.disabled=!canToggle;
   toggle.textContent=card.pending?'正在确认…':card.enabled?'关闭远程控制':'启用远程控制';
   const canInput=canToggle&&card.enabled&&!card.lastInput;
   input.disabled=!canInput;submit.disabled=!canInput;
   nav.forEach(b=>b.disabled=!canInput);
   stop.disabled=card.closed||card.state==='stopping';
  };
  card.refresh=refresh;
  try{
   card.player=root.EasyADBPlayers.create('mse',video,{
    lowOverhead:true,
    onState:stage=>{
     if(card.closed)return;
     if(stage==='ready'){if(card.state!=='stopping'){card.state='ready';mark('MSE 已就绪，控制通道可单独开启；等待首帧…');refresh();}}
     if(stage==='playing'&&card.state!=='stopping'){
      card.state='playing';mark('画面播放中（此路独立会话）');refresh();
     }
     if(stage==='autoplay-blocked')mark('点击本卡画面允许播放');
    },
    onError:reason=>{if(!card.closed){mark(reason,true);this.end(card,false);}}
   });
   const scheme=location.protocol==='https:'?'wss:':'ws:';
   const ws=new WebSocket(scheme+'//'+location.host+
    '/api/devices/'+encodeURIComponent(d.id)+'/m2/live');
   ws.binaryType='arraybuffer';card.ws=ws;
   ws.onopen=()=>{
    if(card.closed)return;
    const payload={token:this.getToken(),player:'mse',selected_serial:card.serial,
      profile:quality.profile};
    if(quality.quality)payload.quality=quality.quality;
    ws.send(JSON.stringify(payload));
   };
   ws.onmessage=ev=>{
    if(card.closed)return;
    if(typeof ev.data!=='string'){
     if(card.state==='stopping')return;
     const len=ev.data.byteLength;card.meter.record(len);card.metrics.recordBytes(len);
     try{card.player.append(new Uint8Array(ev.data));}
     catch(e){mark(e.message,true);this.end(card,false);}
     return;
    }
    let m;try{m=JSON.parse(ev.data);}catch{mark('服务端返回非法消息',true);this.end(card,false);return;}
    if(m.session_id&&card.session&&m.session_id!==card.session){
     mark('会话标识不匹配，已停止此路',true);this.end(card,false);return;
    }
    if(m.type==='starting'){
     card.session=m.session_id;mark('已启动，正在等待手机编码…');
    }else if(m.type==='diagnostic'){
     if(card.session&&m.session_id===card.session&&card.state!=='stopping'&&
        ws.readyState===WebSocket.OPEN){
      try{ws.send(JSON.stringify({type:'heartbeat',session_id:card.session}));}
      catch{mark('心跳发送失败，本路已停止',true);this.end(card,false);return;}
     }
     const traffic=card.meter.sample(performance.now());
     const pd=card.player.diagnostics();
     const stat=card.metrics.sample(video,performance.now(),{
      receiveMbps:traffic.mbps,queueBytes:pd.queueBytes
     });
     stats.textContent=root.EasyADBMetrics.format(stat)+'｜提示：'+root.EasyADBMetrics.advice(stat)+
       '｜本路累计 '+root.EasyADBTraffic.size(traffic.totalBytes)+
       '｜本路本地进程 CPU '+fmt(m.proc_cpu_pct)+'% / RSS '+
       fmt(m.proc_rss_mib)+' MiB（仅 FFmpeg/ADB shell）';
    }else if(m.type==='init'){
     card.ready=m.control_available===true;
     card.size={width:m.width,height:m.height};
     mark('编码 '+m.width+'×'+m.height+' · 请求上限 '+
      (m.requested?((m.requested.max_size||'原生')+' / '+
        m.requested.video_bit_rate/1000000+' Mbps / '+m.requested.max_fps+' FPS'):'—'));
     try{
      card.touch=root.EasyADBTouch.create(video,p=>{
       if(!card.closed&&card.enabled&&card.session&&
          (card.state==='ready'||card.state==='playing')&&
          ws.readyState===WebSocket.OPEN){
        ws.send(JSON.stringify({...p,session_id:card.session}));
       }
      });
      card.player.initialize(m);
      // Control remains independent of the playback "playing" event.
      if(card.state==='connecting')card.state='ready';
      refresh();
      card.settleLaunch(); // start next phone only after this pipeline initialized
     }catch(e){mark(e.message,true);this.end(card,false);}
    }else if(m.type==='control_enabled'){
     try{
      if(!card.ready||!card.touch||
         (card.state!=='ready'&&card.state!=='playing'))throw Error('控制通道未就绪');
      card.touch.enable(card.size);card.enabled=true;card.pending=false;
      keyStatus.textContent='已启用：此卡的鼠标、文字和导航仅作用于 '+card.name;refresh();
     }catch(e){mark(e.message,true);this.end(card,false);}
    }else if(m.type==='control_disabled'){
     card.enabled=false;card.pending=false;card.lastInput=false;
     if(card.touch)card.touch.disable();
     keyStatus.textContent='控制已关闭，此路仅观看';refresh();
    }else if(m.type==='input_accepted'){
     card.lastInput=false;
     if(m.kind==='input_text')input.value='';
     keyStatus.textContent='已写入本轮控制通道（手机是否接收由当前焦点决定）';refresh();
    }else if(m.type==='input_error'){
     card.lastInput=false;keyStatus.textContent=m.message||'输入失败';refresh();
     if(m.code==='adb_disconnected'){mark('ADB 已断开，请手动重新连接',true);this.end(card,false);}
    }else if(m.type==='touch_error'){
     // A rejected early control_enable must release the pending UI latch.
     // Otherwise this card's button stays disabled forever.
     card.pending=false;refresh();
     keyStatus.textContent=m.message||'触摸失败';
     if(m.code==='adb_disconnected'){mark('ADB 已断开，请手动重新连接',true);this.end(card,false);}
    }else if(m.type==='stopping'){
     card.state='stopping';mark('正在清理此路资源…');refresh();
    }else if(m.type==='ended'){
     if(m.cleanup_complete!==true){mark('服务端未确认完整清理',true);this.end(card,false);}
     else{mark('已停止，资源已释放');this.end(card,true);}
    }else if(m.type==='error'){
     mark(m.message||'本路视频异常',true);this.end(card,false);
    }
   };
   ws.onerror=()=>{if(!card.closed)mark('此路 WebSocket 发生网络错误',true);};
   ws.onclose=()=>{if(!card.closed){mark('连接已结束；若非主动停止，请检查清理状态',true);this.end(card,false);}};
  }catch(e){mark('本路启动失败：'+e.message,true);this.end(card,false);}
  video.addEventListener('click',()=>{if(!card.closed&&card.player)card.player.resume();});
  toggle.addEventListener('click',()=>{
   if(toggle.disabled||!card.session||card.closed)return;
   card.pending=true;
   try{
    if(card.enabled){
     if(card.touch)card.touch.disable();card.enabled=false;
     card.ws.send(JSON.stringify({type:'control_disable',session_id:card.session}));
    }else card.ws.send(JSON.stringify({type:'control_enable',session_id:card.session}));
    refresh();
   }catch(e){mark('控制请求发送失败：'+e.message,true);this.end(card,false);}
  });
  stop.addEventListener('click',()=>this.stop(card));
  form.addEventListener('submit',ev=>{
   ev.preventDefault();
   const value=input.value;
   if(!/^[\x20-\x7e]{1,300}$/.test(value)){
    keyStatus.textContent='仅支持 1～300 字节的 ASCII 可打印字符';return;
   }
   this.sendInput(card,'input_text',{text:value});
  });
  refresh();
 }
 sendInput(card,type,body){
  if(card.closed||!card.enabled||card.pending||card.lastInput||
     (card.state!=='ready'&&card.state!=='playing')||!card.session||!card.ws||
     card.ws.readyState!==WebSocket.OPEN)return;
  card.lastInput=true;card.refresh();
  try{card.ws.send(JSON.stringify({type,session_id:card.session,...body}));}
  catch(e){card.lastInput=false;card.keyStatus.textContent=e.message;this.end(card,false);}
 }
 stop(card){
  if(card.closed||card.state==='stopping')return;
  if(card.touch){card.touch.disable();}
  card.enabled=false;card.pending=false;card.lastInput=false;
  card.state='stopping';card.refresh();
  if(card.ws&&card.ws.readyState===WebSocket.OPEN){
   try{card.ws.send('stop');card.stateEl.textContent='正在请求服务端停止并清理…';}
   catch{this.end(card,false);}
  }else this.end(card,false);
 }
 stopFor(id){const card=this.cards.get(id);if(card)this.stop(card);}
 stopAll(){
  this.opening=false;this.launchQueue=[];
  for(const card of [...this.cards.values()])this.stop(card);
  this.updatePicker();
 }
 closeAll(){
  this.opening=false;this.launchQueue=[];
  for(const card of [...this.cards.values()])this.end(card,false);
  this.updatePicker();
 }
 end(card,clean){
  if(card.closed)return;
  card.closed=true;
  if(card.touch){card.touch.destroy();card.touch=null;}
  if(card.player){card.player.destroy();card.player=null;}
  if(card.ws){
   const ws=card.ws;ws.onmessage=null;ws.onerror=null;ws.onclose=null;
   try{if(ws.readyState===WebSocket.OPEN&&!clean)ws.send('stop');ws.close();}catch{}
   card.ws=null;
  }
  card.enabled=false;card.pending=false;card.lastInput=false;card.refresh();
  card.stop.disabled=true;
  const remove=make('button','secondary','移除已结束卡片');
  remove.type='button';remove.addEventListener('click',()=>card.box.remove());
  card.box.append(remove);
  this.cards.delete(card.id);this.selected.delete(card.id);
  card.settleLaunch(); // early failure: clean this card before launching next
  this.updatePicker();this.onChange();
 }
}
root.EasyADBMulti=Object.freeze({
 MAX_DEVICES,create:options=>new MultiView(options)
});
})(window);
