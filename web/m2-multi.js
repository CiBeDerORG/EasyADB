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
const CHOICES=[
 ['economy','省流 · 960 / 3 Mbps / 24 FPS'],
 ['baseline','基础 · 1600 / 8 Mbps / 30 FPS'],
 ['native','原生 · 不限制尺寸 / 16 Mbps / 30 FPS'],
 ['custom','自定义']
];
const CUSTOM={
 max_size:[['960','960'],['1280','1280'],['1600','1600'],['0','原生']],
 video_bit_rate:[['2000000','2 Mbps'],['4000000','4 Mbps'],['8000000','8 Mbps'],['12000000','12 Mbps'],['16000000','16 Mbps']],
 max_fps:[['15','15 FPS'],['24','24 FPS'],['30','30 FPS']]
};
const choice=(options,value)=>{
 const select=make('select','multi-quality');
 for(const [id,label] of options){const opt=make('option','',label);opt.value=id;opt.selected=id===String(value);select.append(opt);}
 select.value=String(value);return select;
};
const defaults=()=>({profile:'economy',max_size:960,video_bit_rate:4000000,max_fps:24,
 low_latency:false});
const qualityPayload=v=>v.profile==='custom'
 ?{profile:'custom',quality:{max_size:v.max_size,video_bit_rate:v.video_bit_rate,max_fps:v.max_fps}}
 :{profile:v.profile};
const briefQuality=v=>v.profile==='custom'
 ?'自定义 · '+(v.max_size||'原生')+' / '+(v.video_bit_rate/1000000)+' Mbps / '+v.max_fps+' FPS'
 :(CHOICES.find(x=>x[0]===v.profile)||CHOICES[0])[1];
class MultiView{
 constructor({picker,grid,startButton,stopButton,info,getDevices,getToken,onChange,runPreflight,runVideoProbe,onDeviceDisconnected}){
  Object.assign(this,{picker,grid,startButton,stopButton,info,getDevices,getToken,onChange,runPreflight,runVideoProbe,onDeviceDisconnected});
  this.selected=new Set();this.cards=new Map();this.opening=false;this.launchQueue=[];
  this.qualityChoices=new Map();this.probeResults=new Map();this.qualityHistory=new Map();
  this.checking=new Set();
  startButton.addEventListener('click',()=>this.start());
  stopButton.addEventListener('click',()=>this.stopAll());
  this.updatePicker(false);
 }
 status(msg,error=false){this.info.textContent=msg;this.info.className='status'+(error?' error':'');}
 getChoice(id){
  if(!this.qualityChoices.has(id))this.qualityChoices.set(id,defaults());
  return this.qualityChoices.get(id);
 }
 setChoice(id,part){this.qualityChoices.set(id,{...this.getChoice(id),...part});this.updatePicker();}
 recordCheck(id,text){
  const previous=(this.probeResults.get(id)||'').split('\n').filter(x=>x&&!x.includes('正在执行'));
  previous.push((new Date()).toLocaleTimeString()+' · '+text);
  this.probeResults.set(id,previous.slice(-8).join('\n'));
 }
 async checkDevice(d,kind,profile){
  if(this.opening||this.getManagementBusy?.()||this.isBusyFor(d.id)||this.checking.has(d.id))return;
  if(d.status!=='connected'||d.active_serial!==d.selected_serial)return;
  if(!this.getToken()){this.status('请先输入访问密钥并加载设备。',true);return;}
  const key=d.id;this.checking.add(key);
  this.probeResults.set(key,(this.probeResults.get(key)||'')+
   '\n正在执行'+(kind==='preflight'?' M2 能力预检':'视频实验')+'…');this.updatePicker();
  try{
   let result;
   if(kind==='preflight'){
    result=await this.runPreflight(d.id);
    this.recordCheck(key,'M2 能力预检 · '+result.selected_serial+
      ' · 型号 '+(result.model||'未知')+' / Android SDK '+(result.android_sdk??'未知')+
      ' / ABI '+(result.cpu_abi||'未知')+' / 屏幕 '+(result.display_size||'未知')+
      ' · 此结果不代表视频链路通过');
   }else{
    result=await this.runVideoProbe(d.id,profile);
    this.recordCheck(key,'视频实验 '+profile+' · '+result.codec+' / '+
      result.encoded_width+'×'+result.encoded_height+
      ' / '+result.media_packets+' 帧 / '+result.key_frames+' 关键帧 / '+
      root.EasyADBTraffic.size(result.sample_bytes)+' / '+result.elapsed_ms+'ms');
   }
  }catch(error){this.recordCheck(key,'检测失败：'+error.message);}
  finally{this.checking.delete(key);this.updatePicker();}
 }
 updatePicker(notify=true){
  const devices=this.getDevices()||[];
  const ids=new Set(devices.filter(d=>d.status==='connected'&&d.active_serial===d.selected_serial).map(d=>d.id));
  for(const id of this.selected)if(!ids.has(id)&&!this.cards.has(id))this.selected.delete(id);
  this.picker.replaceChildren();
  for(const d of devices){
   const active=this.cards.has(d.id),connected=ids.has(d.id);
   const busy=this.opening||this.getManagementBusy?.()||
    this.isBusyFor(d.id)||this.checking.has(d.id);
   const item=make('div','multi-choice');
   item.setAttribute('data-device-id',d.id);
   const main=make('label','multi-choice-label');
   const check=make('input');check.type='checkbox';check.value=d.id;
   check.checked=this.selected.has(d.id);
   check.disabled=active||!connected||busy||(!check.checked&&this.selected.size>=MAX_DEVICES);
   check.addEventListener('change',()=>{
    if(check.checked)this.selected.add(d.id);else this.selected.delete(d.id);
    this.updatePicker();
   });
   main.append(check,make('span','',active?'已在投屏 · '+d.name:
    connected?'参与本轮投屏 · '+d.name:'手动连接后可选择投屏'));
   item.append(main);
   if(!connected)item.classList.add('multi-unavailable');
   const value=this.getChoice(d.id);
   const select=choice(CHOICES,value.profile);
   select.setAttribute('aria-label',d.name+' 投屏画质');
   select.disabled=busy||!connected;
   select.addEventListener('change',()=>this.setChoice(d.id,{profile:select.value}));
   item.append(select);
   if(value.profile==='custom'){
    const custom=make('div','multi-custom');
    for(const [key,label] of [['max_size','最大边'],['video_bit_rate','目标码率'],['max_fps','最高帧率']]){
     const field=make('label','',label),sel=choice(CUSTOM[key],value[key]);
     sel.setAttribute('aria-label',d.name+' '+label);sel.disabled=busy||!connected;
     sel.addEventListener('change',()=>this.setChoice(d.id,{[key]:Number(sel.value)}));
     field.append(sel);custom.append(field);
    }
    item.append(custom);
   }
   const actions=make('div','buttons');
   for(const [kind,profile,label] of [['preflight',null,'能力预检'],['video','baseline','视频实验 · 基础'],['video','native','视频实验 · 原生']]){
    const b=make('button','secondary',label);b.type='button';
    b.disabled=busy||!connected;
    b.addEventListener('click',()=>this.checkDevice(d,kind,profile));
    actions.append(b);
   }
   item.append(actions);
   const details=make('details','multi-probe-log');
   const summary=make('summary','','检测记录');
   const log=make('div','multi-check-log',this.probeResults.get(d.id)||'尚未执行本设备能力预检或视频实验');
   details.append(summary,log);item.append(details);
   // Separate per-device playback option, deliberately NOT a scrcpy setting.
   const latency=make('label','multi-latency'),low=make('input');
   low.type='checkbox';low.checked=value.low_latency===true;low.disabled=busy||!connected;
   low.setAttribute('aria-label',d.name+' 低延迟播放实验');
   low.addEventListener('change',()=>this.setChoice(d.id,{low_latency:low.checked}));
   latency.append(low,make('span','','低延迟播放实验（仅浏览器追帧，不改变手机编码）'));
   item.append(latency);
   this.picker.append(item);
  }
  // Existing cards, including pending stop/cleanup, retain their server slots.
  // Start may append ONLY newly checked devices, up to the remaining capacity.
  const available=[...this.selected].filter(id=>ids.has(id)&&!this.cards.has(id));
  const remaining=MAX_DEVICES-this.cards.size;
  this.startButton.disabled=this.opening||this.getManagementBusy?.()||available.length<1||
   available.length>remaining||available.some(id=>this.checking.has(id));
  this.stopButton.disabled=this.cards.size===0&&!this.opening;
  this.startButton.textContent=(this.cards.size?'追加投屏':'开始投屏')+
   '（待新增 '+available.length+' / 剩余 '+remaining+' 台）';
  this.grid.setAttribute('data-count',String(this.cards.size));
  if(notify)this.onChange();
 }

 hasActive(){return this.cards.size>0;}
 isBusyFor(id){
  // A pending/active/stopping card owns its device until its cleanup finishes.
  return this.cards.has(id)||this.launchQueue.some(item=>item.device.id===id);
 }
 start(){
  if(this.opening||this.getManagementBusy?.())return;
  const ds=this.getDevices()||[];
  const additions=[...this.selected].filter(id=>!this.isBusyFor(id))
   .map(id=>ds.find(d=>d.id===id));
  if(additions.length<1)return; // Do not reopen a running device.
  if(additions.length>MAX_DEVICES-this.cards.size||
     additions.some(d=>!d||d.status!=='connected'||!d.selected_serial||
       d.active_serial!==d.selected_serial||this.checking.has(d.id))){
   this.status('请检查新增设备的连接状态，或等待现有设备清理完成；最多同时四路。',true);
   this.updatePicker();return;
  }
  if(!this.getToken()){this.status('请先填写访问密钥并加载设备。',true);return;}
  // Only snapshot NEW devices. Running sessions keep their original stream,
  // touch controller, MSE player and requested profile completely untouched.
  const batch=additions.map(d=>({device:d,quality:qualityPayload(this.getChoice(d.id)),
    lowLatency:this.getChoice(d.id).low_latency===true}));
  const isAppend=this.cards.size>0;
  this.opening=true;
  // One explicit user request, staggered by authenticated server "init"
  // completion. Avoid pushing/initializing 2-4 scrcpy+FFmpeg pipelines
  // at the same instant; do not create timers or background reconnect jobs.
  this.launchQueue=batch;
  this.status((isAppend?'正在追加 ':'正在依次启动 ')+additions.length+
    ' 路独立投屏；已经运行的设备保持原会话与远控。');
  this._launchNext();
  this.updatePicker();
 }
 _launchNext(){
  if(!this.opening)return;
  const next=this.launchQueue.shift();
  if(!next){
   this.opening=false;this.updatePicker();return;
  }
  this.open(next.device,next.quality,()=>this._launchNext(),next.lowLatency);
 }
 open(d,quality,nextLaunch,lowLatency=false){
  if(this.cards.has(d.id)){ // Never create a second video/WS for this device.
   if(nextLaunch)nextLaunch();
   return;
  }
  const card={id:d.id,serial:d.selected_serial,name:d.name,quality,lowLatency,
   ws:null,session:null,
   state:'connecting',closed:false,enabled:false,pending:false,ready:false,size:null,
   keepSelected:false,
   touch:null,player:null,video:null,meter:new root.EasyADBTraffic.Meter(performance.now()),
   metrics:new root.EasyADBMetrics.QualityMeter(performance.now()),lastInput:false,
   startSettled:false,nextLaunch,adbCheckMs:null,frameLastAt:null,frameCount:0,
   permissionWarningShown:false,
   history:this.qualityHistory.get(d.id)||[],logLines:[]};
  const box=make('article','multi-card'),header=make('div','heading');
  header.append(make('strong','',d.name),make('span','muted',d.selected_serial));
  const video=make('video','multi-video');video.autoplay=true;video.muted=true;
  video.playsInline=true;video.setAttribute('aria-label',d.name+' 实时画面');
  const state=make('div','status','正在建立本轮会话…');
  const stats=make('div','muted','等待浏览器诊断…');
  const qualityLine=make('div','muted','本设备画质：'+briefQuality(this.getChoice(d.id))+
   (lowLatency?' / 低延迟播放实验已开启':'')+'（本轮固定）');
  const detail=make('details','multi-log'),summary=make('summary','','本设备诊断日志 / MSE / 资源详情');
  const initInfo=make('div','muted',this.probeResults.get(d.id)||'尚未执行本设备能力预检或视频实验');
  const diagnostic=make('div','multi-check-log','等待本轮视频统计…');
  const eventLog=make('div','multi-check-log','等待本轮会话日志…');
  const history=make('div','muted','本设备暂无历史画质采样（仅在本页内存保留）');
  const xiaomi=make('details','multi-help'),
   xiaomiTitle=make('summary','','小米 / 澎湃 OS：画面正常但无法控制？'),
   xiaomiHelp=make('div','muted','在手机开发者选项中，除普通 USB 调试和无线调试外，还须检查「USB 调试（安全设置）」是否启用；按手机要求完成授权后重启，再手动连接。单纯显示控制通道已开启，只说明指令写入成功，不代表 Android 已接受点击。先试“主页”，再试屏幕触控。');
  xiaomi.append(xiaomiTitle,xiaomiHelp);
  detail.append(summary,initInfo,diagnostic,eventLog,history,xiaomi);
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
  box.append(header,qualityLine,video,state,stats,buttons,form,keys,keyStatus,detail);
  this.grid.append(box);
  Object.assign(card,{box,video,stateEl:state,statsEl:stats,toggle,stop,input,submit,nav,keyStatus,
   initInfo,diagnostic,eventLog,historyEl:history});
  this.cards.set(card.id,card);
  card.settleLaunch=()=>{
   if(card.startSettled)return;
   card.startSettled=true;
   if(this.opening&&card.nextLaunch)card.nextLaunch();
  };
  const mark=(msg,error=false)=>{
   state.textContent=msg;state.className='status'+(error?' error':'');
   card.logLines.push((new Date()).toLocaleTimeString()+' · '+msg);
   if(card.logLines.length>24)card.logLines.shift();
   eventLog.textContent=card.logLines.join('\n');
  };
  if(this.qualityHistory.has(d.id)){
   history.textContent='本页该设备最近画质：'+card.history.map(v=>
    v.profile+' / '+fmt(v.avgFps)+' FPS / '+fmt(v.avgReceiveMbps)+' Mbps / '+
    fmt(v.avgCpuPct)+'% CPU / '+fmt(v.avgRssMib)+' MiB / '+
    root.EasyADBTraffic.size(v.totalBytes)).join('；');
  }
  const refresh=()=>{
   // Control readiness belongs to scrcpy's control socket, not to the
   // browser decoder's "playing" event (which may be delayed/throttled).
   const canToggle=!card.closed&&card.ready&&!card.permissionWarningShown&&
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
    lowOverhead:true,lowLatency:card.lowLatency,
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
     card.session=m.session_id;card.adbCheckMs=m.adb_check_ms;mark('已启动，正在等待手机编码…');
    }else if(m.type==='diagnostic'){
     if(card.session&&m.session_id===card.session&&card.state!=='stopping'&&
        ws.readyState===WebSocket.OPEN){
      try{ws.send(JSON.stringify({type:'heartbeat',session_id:card.session}));}
      catch{mark('心跳发送失败，本路已停止',true);this.end(card,false);return;}
     }
     if(m.control_warning==='android_input_permission'&&!card.permissionWarningShown){
      card.permissionWarningShown=true;
      keyStatus.textContent='Android 已拒绝输入注入（INJECT_EVENTS）。小米/澎湃 OS 请检查 USB 调试（安全设置），授权并重启手机。';
      mark('检测到 Android 输入权限拒绝；画面可继续观看，但当前远控未被手机接受。',true);
      if(card.touch)card.touch.disable();
      card.enabled=false;card.pending=false;refresh();
      if(card.session&&ws.readyState===WebSocket.OPEN){
       try{ws.send(JSON.stringify({type:'control_disable',session_id:card.session}));}
       catch{this.end(card,false);return;}
      }
     }
     const traffic=card.meter.sample(performance.now());
     const pd=card.player.diagnostics();
     const stat=card.metrics.sample(video,performance.now(),{
      renderedFrames:card.frameCount,
      frameAgeMs:card.frameLastAt===null?null:performance.now()-card.frameLastAt,
      receiveMbps:traffic.mbps,queueBytes:pd.queueBytes,
      procCpuPct:m.proc_cpu_pct,procRssMib:m.proc_rss_mib
     });
     stats.textContent=root.EasyADBMetrics.format(stat)+'｜提示：'+root.EasyADBMetrics.advice(stat)+
       '｜本路累计 '+root.EasyADBTraffic.size(traffic.totalBytes)+
       '｜本路本地进程 CPU '+fmt(m.proc_cpu_pct)+'% / RSS '+
       fmt(m.proc_rss_mib)+' MiB（仅 FFmpeg/ADB shell）';
     const age=v=>Number.isFinite(v)?fmt(v/1000,2)+'s':'—';
     diagnostic.textContent='会话 '+card.session+' / ADB 检查 '+(card.adbCheckMs??'—')+'ms'+
      ' / 阶段 '+m.stage+' / 已运行 '+age(m.elapsed_ms)+
      '\n手机编码包 '+(m.phone_packets??'—')+' / 距上包 '+age(m.phone_idle_ms)+
      ' / MP4 读取 '+(m.mux_chunks??'—')+' / 完整分片 '+(m.media_fragments??'—')+
      ' / 距上包 '+age(m.mux_idle_ms)+
      '\nFFmpeg 初始化 '+age(m.init_ready_ms)+
      ' / WS 已发 '+root.EasyADBTraffic.size(m.ws_video_bytes||0)+
      ' / 浏览器收到 '+root.EasyADBTraffic.size(traffic.totalBytes)+
      '\nMSE '+pd.sourceState+' / 区间 '+pd.sourceRanges+
      ' / 缓冲端 '+fmt(pd.rangeEnd,2)+'s / 播放点 '+fmt(pd.currentTime,2)+'s'+
      ' / 待追加 '+pd.queueChunks+' 块 '+pd.queueBytes+'B'+
      ' / append '+pd.appendCalls+' / update '+pd.completedUpdates+
      ' / video error '+(pd.videoError??'无')+
      '\n本路 CPU '+fmt(m.proc_cpu_pct)+'% / RSS '+fmt(m.proc_rss_mib,2)+' MiB'+
      ' / 播放倍率 '+fmt(pd.playbackRate)+'x / 低延迟实验 '+(pd.lowLatency?'开':'关')+
      ' / Android 控制提示 '+(m.control_warning||'无已确认拒绝');
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
      keyStatus.textContent='控制 Socket 已开启：此卡的指令仅发往 '+card.name+
        '；这不代表 Android 已授予模拟输入权限，请用“主页”验证。';refresh();
     }catch(e){mark(e.message,true);this.end(card,false);}
    }else if(m.type==='control_disabled'){
     card.enabled=false;card.pending=false;card.lastInput=false;
     if(card.touch)card.touch.disable();
     if(!card.permissionWarningShown)keyStatus.textContent='控制已关闭，此路仅观看';
     refresh();
    }else if(m.type==='input_accepted'){
     card.lastInput=false;
     if(m.kind==='input_text')input.value='';
     keyStatus.textContent='已写入本轮控制通道（手机是否接收由当前焦点决定）';refresh();
    }else if(m.type==='input_error'){
     card.lastInput=false;keyStatus.textContent=m.message||'输入失败';refresh();
     if(m.code==='adb_disconnected'){
      mark('ADB 已断开，请手动重新连接',true);
      this.onDeviceDisconnected?.(card.id);this.end(card,false);
     }
    }else if(m.type==='touch_error'){
     // A rejected early control_enable must release the pending UI latch.
     // Otherwise this card's button stays disabled forever.
     card.pending=false;refresh();
     keyStatus.textContent=m.message||'触摸失败';
     if(m.code==='adb_disconnected'){
      mark('ADB 已断开，请手动重新连接',true);
      this.onDeviceDisconnected?.(card.id);this.end(card,false);
     }
    }else if(m.type==='stopping'){
     card.state='stopping';mark('正在清理此路资源…');refresh();
    }else if(m.type==='ended'){
     if(m.cleanup_complete!==true){mark('服务端未确认完整清理',true);this.end(card,false);}
     else{mark('已停止，资源已释放');this.end(card,true);}
    }else if(m.type==='error'){
     mark(m.message||'本路视频异常',true);
     if(m.code==='adb_disconnected')this.onDeviceDisconnected?.(card.id);
     this.end(card,false);
    }
   };
   ws.onerror=()=>{if(!card.closed)mark('此路 WebSocket 发生网络错误',true);};
   ws.onclose=()=>{if(!card.closed){mark('连接已结束；若非主动停止，请检查清理状态',true);this.end(card,false);}};
  }catch(e){mark('本路启动失败：'+e.message,true);this.end(card,false);}
  if(typeof video.requestVideoFrameCallback==='function'){
   const track=()=>{
    if(card.closed)return;
    card.frameCount++;card.frameLastAt=performance.now();
    card.frameCallback=video.requestVideoFrameCallback(track);
   };
   card.frameCallback=video.requestVideoFrameCallback(track);
  }
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
 stop(card,keepSelected=false){
  if(card.closed||card.state==='stopping')return;
  // A single stopped/failed card is no longer a pending append candidate
  // while other phones remain live. Full-stop explicitly retains selections
  // for a deliberate restart of the former set.
  card.keepSelected=keepSelected;
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
  for(const card of [...this.cards.values()])this.stop(card,true);
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
  if(card.frameCallback!==undefined&&typeof card.video.cancelVideoFrameCallback==='function')
   card.video.cancelVideoFrameCallback(card.frameCallback);
  if(card.metrics.samples.length){
   const result=card.metrics.summary(card.quality.profile,card.name);
   const past=this.qualityHistory.get(card.id)||[];
   past.unshift(result);past.length=Math.min(past.length,8);
   this.qualityHistory.set(card.id,past);
   card.historyEl.textContent='本页该设备最近画质：'+past.map(v=>
    v.profile+' / '+fmt(v.avgFps)+' FPS / '+fmt(v.avgReceiveMbps)+' Mbps / '+
    fmt(v.avgCpuPct)+'% CPU / '+fmt(v.avgRssMib)+' MiB / '+
    root.EasyADBTraffic.size(v.totalBytes)).join('；');
  }
  if(card.player){card.player.destroy();card.player=null;}
  if(card.ws){
   const ws=card.ws;ws.onmessage=null;ws.onerror=null;ws.onclose=null;
   try{if(ws.readyState===WebSocket.OPEN&&!clean)ws.send('stop');ws.close();}catch{}
   card.ws=null;
  }
  card.enabled=false;card.pending=false;card.lastInput=false;card.refresh();
  card.stop.disabled=true;
  // Remove the terminal DOM node NOW: deleting only the registry entry left a
  // stale video card behind, so a second Start visually duplicated streams.
  card.box.remove();
  if(!card.keepSelected&&this.cards.size>1)this.selected.delete(card.id);
  this.cards.delete(card.id);
  // Full stop keeps the previous selection; stopping one live card
  // alongside others unchecks only that card. Nothing auto-starts.
  card.settleLaunch(); // early failure: clean this card before launching next
  this.updatePicker();
 }
}
root.EasyADBMulti=Object.freeze({
 MAX_DEVICES,create:options=>new MultiView(options)
});
})(window);
