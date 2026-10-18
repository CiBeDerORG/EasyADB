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
 video_bit_rate:[['2000000','2 Mbps'],['3000000','3 Mbps'],['4000000','4 Mbps'],['8000000','8 Mbps'],['12000000','12 Mbps'],['16000000','16 Mbps'],['18000000','18 Mbps'],['20000000','20 Mbps']],
 max_fps:[['15','15 FPS'],['24','24 FPS'],['30','30 FPS'],['45','45 FPS'],['55','55 FPS'],['60','60 FPS']]
};
const choice=(options,value)=>{
 const select=make('select','multi-quality');
 for(const [id,label] of options){const opt=make('option','',label);opt.value=id;opt.selected=id===String(value);select.append(opt);}
 select.value=String(value);return select;
};
const defaults=()=>({profile:'custom',max_size:960,video_bit_rate:3000000,max_fps:24,
 low_latency:true,screen_off:false});
const qualityPayload=v=>v.profile==='custom'
 ?{profile:'custom',quality:{max_size:v.max_size,video_bit_rate:v.video_bit_rate,max_fps:v.max_fps}}
 :{profile:v.profile};
const briefQuality=v=>v.profile==='custom'
 ?'自定义 · '+(v.max_size||'原生')+' / '+(v.video_bit_rate/1000000)+' Mbps / '+v.max_fps+' FPS'
 :(CHOICES.find(x=>x[0]===v.profile)||CHOICES[0])[1];
class MultiView{
 constructor({picker,grid,startButton,stopButton,info,getDevices,getToken,onChange,runPreflight,runVideoProbe,onDeviceDisconnected,getManagementBusy,getBatchSelection,onBatchSelectionRemove}){
  Object.assign(this,{picker,grid,startButton,stopButton,info,getDevices,getToken,onChange,runPreflight,runVideoProbe,onDeviceDisconnected,getManagementBusy,getBatchSelection,onBatchSelectionRemove});
  this.selected=new Set();this.cards=new Map();this.opening=false;this.launchQueue=[];
  this.qualityChoices=new Map();this.probeResults=new Map();this.qualityHistory=new Map();
  this.checking=new Set();this.lastLiveStatus=new Map();
  startButton.addEventListener('click',()=>this.start());
  stopButton.addEventListener('click',()=>this.stopSelected());
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
 isAdbReady(d){
  return d.status==='connected'&&d.connect_failed!==true&&
   Boolean(d.selected_serial)&&d.active_serial===d.selected_serial;
 }
 updatePicker(notify=true){
  const devices=this.getDevices()||[];
  const ids=new Set(devices.filter(d=>this.isAdbReady(d)).map(d=>d.id));
  for(const id of this.selected)if(!ids.has(id)&&!this.cards.has(id))this.selected.delete(id);
  this.picker.replaceChildren();
  for(const d of devices){
   const connected=ids.has(d.id);
   const busy=this.opening||this.getManagementBusy?.()||
    this.isBusyFor(d.id)||this.checking.has(d.id);
   const item=make('div','multi-choice');
   item.setAttribute('data-device-id',d.id);
   // Batch selection comes from the existing left-hand device checkbox.
   // The device management page prepends its ADB status badge here.
   // Preserve full-color ADB status even when streaming controls are disabled.
   const value=this.getChoice(d.id);
   // Three independent per-device settings, replacing the preset dropdown.
   // Server still validates their complete numeric tuple as custom quality.
   const custom=make('div','multi-custom');
   for(const [key,label] of [['max_size','分辨率上限'],['video_bit_rate','目标码率'],['max_fps','最高帧率']]){
    const field=make('label','',label),sel=choice(CUSTOM[key],value[key]);
    sel.setAttribute('aria-label',d.name+' '+label);
    sel.disabled=busy||!connected;
    sel.addEventListener('change',()=>this.setChoice(d.id,{profile:'custom',[key]:Number(sel.value)}));
    field.append(sel);custom.append(field);
   }
   item.append(custom);
   const actions=make('div','buttons');
   for(const [kind,profile,label] of [['preflight',null,'能力预检'],['video','baseline','视频实验 · 基础'],['video','native','视频实验 · 原生']]){
    const b=make('button','secondary',label);b.type='button';
    b.disabled=busy||!connected;
    b.addEventListener('click',()=>this.checkDevice(d,kind,profile));
    actions.append(b);
   }
   // Temporarily hide the three diagnostic actions, preserve their
   // explicit handlers and API for later use. No background probes.
   actions.hidden=true;
   item.append(actions);
   const details=make('details','multi-probe-log');
   details.hidden=true;
   const summary=make('summary','','检测记录');
   const log=make('div','multi-check-log',this.probeResults.get(d.id)||'尚未执行本设备能力预检或视频实验');
   details.append(summary,log);item.append(details);
   // Separate per-device playback option, deliberately NOT a scrcpy setting.
   const latency=make('label','multi-latency'),low=make('input');
   low.type='checkbox';low.checked=value.low_latency===true;low.disabled=busy||!connected;
   low.setAttribute('aria-label',d.name+' 低延迟播放实验');
   low.addEventListener('change',()=>this.setChoice(d.id,{low_latency:low.checked}));
   latency.append(low,make('span','','低延迟播放实验（仅浏览器追帧，不改变手机编码）'));
   const panel=make('label','multi-screen-off'),screenOff=make('input');
   screenOff.type='checkbox';screenOff.checked=value.screen_off===true;
   screenOff.disabled=busy||!connected;
   screenOff.setAttribute('aria-label',d.name+' 投屏时关闭手机物理屏幕');
   screenOff.addEventListener('change',()=>this.setChoice(d.id,{screen_off:screenOff.checked}));
   panel.append(screenOff,make('span','','投屏时关闭手机物理屏幕（远端画面继续显示）'));
   // Same-page, session-owned live status. It is intentionally NOT the
   // database's ADB connected status and never starts a background poll.
   const live=this.liveState(d.id);
   const liveRow=make('div','multi-live');
   const liveStatus=make('span','multi-live-status '+live.code,'实时画面：'+live.label);
   liveStatus.setAttribute('role','status');
   const liveButton=make('button',live.active?'danger':'secondary',
    live.active?'关闭此设备画面':'开启此设备画面');
   liveButton.type='button';
   liveButton.setAttribute('aria-label',d.name+' '+(live.active?'关闭':'开启')+'实时画面');
   liveButton.disabled=live.active?
    live.code==='stopping':
    !connected||this.opening||this.getManagementBusy?.()||
    this.checking.has(d.id)||this.cards.size>=MAX_DEVICES;
   liveButton.addEventListener('click',()=>{
    if(liveButton.disabled)return;
    if(live.active)this.stopFor(d.id);else this.startFor(d.id);
   });
   liveRow.append(liveStatus,liveButton);
   item.append(liveRow,panel,latency);
   this.picker.append(item);
  }
  // Existing cards, including pending stop/cleanup, retain their server slots.
  // Start may append ONLY newly checked devices, up to the remaining capacity.
  const picked=this.getBatchSelection?this.getBatchSelection():this.selected;
  // Count saved devices only; select-all is a checkbox, never a stream target.
  // Ignore disconnected/failed ADB and existing/queued sessions.
  const selectedDevices=devices.filter(d=>picked.has(d.id));
  const available=selectedDevices.filter(d=>this.isAdbReady(d)&&!this.isBusyFor(d.id));
  const remaining=MAX_DEVICES-this.cards.size;
  this.startButton.disabled=this.opening||this.getManagementBusy?.()||available.length<1||
   available.length>remaining||available.some(d=>this.checking.has(d.id));
  const selectedRunning=selectedDevices.filter(d=>this.isBusyFor(d.id));
  this.stopButton.disabled=selectedRunning.length===0;
  this.stopButton.textContent='批量停止投屏（'+selectedRunning.length+' 台）';
  this.startButton.textContent=(this.cards.size?'批量追加投屏':'批量投屏')+
   '（待新增 '+available.length+' 台 / 剩余 '+remaining+' 路）';
  this.grid.setAttribute('data-count',String(this.cards.size));
  if(notify)this.onChange();
 }

 hasActive(){return this.cards.size>0;}
 dropBatchSelection(id){
  if(this.getBatchSelection)this.onBatchSelectionRemove?.(id);
  else this.selected.delete(id);
 }
 isBusyFor(id){
  // Includes an opened card during stopping and an unstarted queued item.
  return this.cards.has(id)||this.launchQueue.some(item=>item.device.id===id);
 }
 liveState(id){
  const card=this.cards.get(id);
  if(card){
   const code=card.state==='stopping'?'stopping':
    card.state==='playing'?'playing':
    card.state==='ready'?'ready':'starting';
   return {code,label:({
    stopping:'停止中 · 等待清理',playing:'播放中',
    ready:'等待画面 · 会话已就绪',starting:'启动中'
   })[code],active:true};
  }
  if(this.launchQueue.some(item=>item.device.id===id))
   return {code:'queued',label:'排队中',active:true};
  return {code:'idle',label:this.lastLiveStatus.get(id)||'未开启',active:false};
 }
 startFor(id){
  // Only this target. Never inherit the other checked devices from the batch
  // picker, never replace an already-running device, never reconnect ADB.
  if(this.isBusyFor(id))return false;
  const d=(this.getDevices()||[]).find(item=>item.id===id);
  if(!d)return false;
  const started=this._startDevices([d]);
  if(started){
   if(!this.getBatchSelection)this.selected.add(id);
   this.updatePicker();
  }
  return started;
 }
 start(){
  const ds=this.getDevices()||[];
  const picked=this.getBatchSelection?this.getBatchSelection():this.selected;
  // Displayed count and the actual launch queue share one ADB predicate.
  const additions=ds.filter(d=>picked.has(d.id)&&this.isAdbReady(d)&&!this.isBusyFor(d.id));
  if(!additions.length)return false;
  return this._startDevices(additions);
 }
 startLabFor(id,experiment){
  // The lab uses the same per-device MSE card, never a second transport.
  const d=(this.getDevices()||[]).find(item=>item.id===id);
  if(!d||!this.isAdbReady(d)||this.isBusyFor(id)||this.opening||
     this.cards.size>=MAX_DEVICES||this.getManagementBusy?.()||!this.getToken())return false;
  if(!experiment||!["new","new_settings","display"].includes(experiment.mode))return false;
  const choice=this.getChoice(id);
  this.lastLiveStatus.delete(id);
  this.open(d,qualityPayload(choice),null,choice.low_latency===true,experiment,false);
  this.updatePicker();
  return true;
 }
 _startDevices(additions){
  if(this.opening||this.getManagementBusy?.())return false;
  if(!additions.length||new Set(additions.map(d=>d&&d.id)).size!==additions.length||
     additions.length>MAX_DEVICES-this.cards.size||
     additions.some(d=>!d||this.isBusyFor(d.id)||!this.isAdbReady(d)||this.checking.has(d.id))){
   this.status('请检查目标设备是否已手动连接、当前是否已有会话及剩余投屏名额（最多四路）。',true);
   this.updatePicker();return false;
  }
  if(!this.getToken()){this.status('请先填写访问密钥并加载设备。',true);return false;}
  const batch=additions.map(d=>({device:d,quality:qualityPayload(this.getChoice(d.id)),
   lowLatency:this.getChoice(d.id).low_latency===true,
   screenOff:this.getChoice(d.id).screen_off===true}));
  const isAppend=this.cards.size>0;
  for(const d of additions)this.lastLiveStatus.delete(d.id);
  this.opening=true;
  // Only this explicit user-requested batch is launched sequentially.
  // Never reopen/modify currently running WS, MSE or touch controller.
  this.launchQueue=batch;
  this.status((isAppend?'正在追加 ':'正在依次启动 ')+additions.length+
   ' 路独立投屏；已经运行的设备保持原会话与远控。');
  this._launchNext();
  this.updatePicker();
  return true;
 }
 _launchNext(){
  if(!this.opening)return;
  const next=this.launchQueue.shift();
  if(!next){
   this.opening=false;
   // Startup queue is settled: release any stale FAB reconnect-disable state.
   for(const card of this.cards.values())card.refresh?.();
   this.updatePicker();return;
  }
  this.open(next.device,next.quality,()=>this._launchNext(),next.lowLatency,null,next.screenOff);
 }
 open(d,quality,nextLaunch,lowLatency=false,experiment=null,screenOff=false){
  if(this.cards.has(d.id)){ // Never create a second video/WS for this device.
   if(nextLaunch)nextLaunch();
   return;
  }
  const card={id:d.id,serial:d.selected_serial,name:d.name,quality,lowLatency,experiment,
   screenOff:screenOff===true&&!experiment,reconnectRequested:false,wakePending:false,
   ws:null,session:null,
   state:'connecting',closed:false,enabled:false,pending:false,ready:false,size:null,
   keepSelected:false,
   touch:null,player:null,video:null,meter:new root.EasyADBTraffic.Meter(performance.now()),
   metrics:new root.EasyADBMetrics.QualityMeter(performance.now()),lastInput:false,
   startSettled:false,nextLaunch,adbCheckMs:null,frameLastAt:null,frameCount:0,
   permissionWarningShown:false,
   history:this.qualityHistory.get(d.id)||[],logLines:[]};
  const box=make('article','multi-card'),header=make('div','heading');
  header.append(make('strong','',d.name+(experiment?' · 电脑模式实验':'')),
   make('span','muted',d.selected_serial+(experiment?.mode==='display'?' · Display '+experiment.display_id:'')));
  const screen=make('div','multi-screen');
  const video=make('video','multi-video');video.autoplay=true;video.muted=true;
  video.playsInline=true;video.setAttribute('aria-label',d.name+' 实时画面');
  screen.append(video);
  // Each live card follows the stream's encoded pixel width, not a grid
  // column or a height-based heuristic. Padding/border total 26 CSS px.
  // max-width:100% only scales a card down when its parent is narrower.
  const fitScreen=(width,height)=>{
   if(!(Number.isInteger(width)&&Number.isInteger(height)&&width>0&&height>0))return;
   screen.style.aspectRatio=width+' / '+height;
   screen.setAttribute('data-orientation',width>height?'landscape':'portrait');
   screen.style.width='100%';
   box.style.width=(width+26)+'px';
  };
  fitScreen(360,640); // neutral placeholder until stream metadata arrives
  video.addEventListener('loadedmetadata',()=>{
   if(!card.closed&&video.videoWidth>0&&video.videoHeight>0)
    fitScreen(video.videoWidth,video.videoHeight);
  });
  const state=make('div','status','正在建立本轮会话…');
  const stats=make('div','muted','等待浏览器诊断…');
  const qualityLine=make('div','muted','本设备画质：'+briefQuality(this.getChoice(d.id))+
   (lowLatency?' / 低延迟播放实验已开启':'')+
   (card.screenOff?' / 已请求投屏时关闭物理屏幕':'')+'（本轮固定）');
  const detail=make('div','multi-log');
  const initInfo=make('div','muted',this.probeResults.get(d.id)||'尚未执行本设备能力预检或视频实验');
  const diagnostic=make('div','multi-check-log','等待本轮视频统计…');
  const eventLog=make('div','multi-check-log','等待本轮会话日志…');
  const history=make('div','muted','本设备暂无历史画质采样（仅在本页内存保留）');
  const xiaomi=make('details','multi-help'),
   xiaomiTitle=make('summary','','小米 / 澎湃 OS：画面正常但无法控制？'),
   xiaomiHelp=make('div','muted','在手机开发者选项中，除普通 USB 调试和无线调试外，还须检查「USB 调试（安全设置）」是否启用；按手机要求完成授权后重启，再手动连接。单纯显示控制通道已开启，只说明指令写入成功，不代表 Android 已接受点击。先试“主页”，再试屏幕触控。');
  xiaomi.append(xiaomiTitle,xiaomiHelp);
  detail.append(make('h4','','会话与画质'),qualityLine,state,stats,initInfo,
   make('h4','','MSE / 资源详情'),diagnostic,
   make('h4','','本轮事件日志'),eventLog,
   make('h4','','本页历史'),history,xiaomi);
  const logPanel=make('section','multi-log-panel');logPanel.hidden=true;
  logPanel.setAttribute('role','dialog');logPanel.setAttribute('aria-label',d.name+' 悬浮日志');
  const logHead=make('div','multi-log-head'),logClose=make('button','secondary multi-log-close','×');
  logClose.type='button';logClose.title='关闭悬浮日志';logClose.setAttribute('aria-label','关闭悬浮日志');
  const stop=make('button','danger','停止此路');stop.type='button';
  logHead.append(make('strong','','本设备诊断日志'),stop,logClose);
  logPanel.append(logHead,detail);screen.append(logPanel);
  const fab=make('div','multi-fab');
  fab.setAttribute('aria-label',d.name+' 画面悬浮控制');
  const icon=(cls,glyph,label)=>{
   const b=make('button','fab-action '+cls,glyph);b.type='button';
   b.title=label;b.setAttribute('aria-label',label);return b;
  };
  const main=make('button','fab-main','☰');main.type='button';
  main.setAttribute('aria-label','展开悬浮操作');main.setAttribute('aria-expanded','false');
  main.title='展开悬浮操作';
  const logButton=icon('fab-up','☷','查看日志');
  const wakeButton=icon('fab-up-wake','☀','唤醒手机屏幕');
  const reconnectButton=icon('fab-up-reconnect','↻','重连此路实时画面');
  wakeButton.disabled=true;reconnectButton.disabled=true;
  const toggle=icon('fab-remote','⏻','启用远控');toggle.disabled=true;
  const textButton=icon('fab-text','⌨','文字与按键输入');textButton.disabled=true;
  const form=make('form','multi-text-panel');form.hidden=true;
  form.setAttribute('aria-label','本设备文字与按键输入');
  const input=make('input'),submit=make('button','','发送');
  input.type='text';input.maxLength=300;input.autocomplete='off';
  input.placeholder='仅 ASCII，先启用此设备控制';
  submit.type='submit';input.disabled=true;submit.disabled=true;
  const textHead=make('div','multi-text-head'),textClose=make('button','secondary','×');
  textClose.type='button';textClose.setAttribute('aria-label','关闭文字输入');
  textHead.append(make('span','','文字输入'),textClose);
  const textEntry=make('div','multi-text-entry');textEntry.append(input,submit);
  const textKeys=make('div','multi-text-keys'),nav=[];
  const glyphs={back:'↩',home:'⌂',recents:'▣',enter:'↵',backspace:'⌫'};
  const positions={back:'fab-nav-back',home:'fab-nav-home',recents:'fab-nav-recents'};
  for(const [key,label] of KEYS){
   const btn=key==='enter'||key==='backspace'
    ?make('button','secondary',glyphs[key]+' '+label)
    :icon('fab-down '+positions[key],glyphs[key],label);
   btn.type='button';btn.disabled=true;
   btn.setAttribute('aria-label',label);
   if(key==='enter'||key==='backspace')textKeys.append(btn);
   else{btn.hidden=true;fab.append(btn);}
   btn.addEventListener('click',()=>{
    if(btn.disabled)return;
    this.sendInput(card,'nav_key',{key});resetMenuTimer();
   });
   nav.push(btn);
  }
  form.append(textHead,textEntry,textKeys);
  const keyStatus=make('div','muted','默认只观看，不会全局捕获键盘。');
  detail.append(make('h4','','远控输入状态'),keyStatus);
  fab.append(logButton,wakeButton,reconnectButton,toggle,textButton,main,form);
  screen.append(fab);box.append(header,screen);this.grid.append(box);
  Object.assign(card,{box,screen,fitScreen,video,stateEl:state,statsEl:stats,
   qualityLine,form,fab,main,logButton,wakeButton,reconnectButton,logPanel,logClose,toggle,stop,
   textButton,textClose,textKeys,input,submit,nav,keyStatus,
   initInfo,diagnostic,eventLog,historyEl:history,menuOpen:false,textOpen:false,
   menuTimer:null});
  const collapseMenu=()=>{
   if(card.menuTimer!==null){root.clearTimeout(card.menuTimer);card.menuTimer=null;}
   card.menuOpen=false;card.textOpen=false;form.hidden=true;
   fab.className='multi-fab'+(card.enabled?' is-control-enabled':'');
   main.setAttribute('aria-expanded','false');main.setAttribute('aria-label','展开悬浮操作');
   main.title='展开悬浮操作';
  };
  const resetMenuTimer=()=>{
   if(card.menuTimer!==null)root.clearTimeout(card.menuTimer);
   card.menuTimer=null;
   if(card.menuOpen&&!card.closed)card.menuTimer=root.setTimeout(()=>{
    card.menuTimer=null;collapseMenu();
   },5000);
  };
  card.collapseMenu=collapseMenu;card.resetMenuTimer=resetMenuTimer;
  main.addEventListener('click',()=>{
   if(card.closed)return;
   if(card.menuOpen){collapseMenu();return;}
   card.menuOpen=true;fab.className='multi-fab is-open'+(card.enabled?' is-control-enabled':'');
   main.setAttribute('aria-expanded','true');main.setAttribute('aria-label','收起悬浮操作');
   main.title='收起悬浮操作';resetMenuTimer();
  });
  logButton.addEventListener('click',()=>{
   if(!card.menuOpen||card.closed)return;
   collapseMenu();logPanel.hidden=false;
  });
  logClose.addEventListener('click',()=>{logPanel.hidden=true;});
  textButton.addEventListener('click',()=>{
   if(textButton.disabled||!card.menuOpen)return;
   card.textOpen=!card.textOpen;form.hidden=!card.textOpen;resetMenuTimer();
   if(card.textOpen)input.focus();
  });
  textClose.addEventListener('click',()=>{
   card.textOpen=false;form.hidden=true;resetMenuTimer();
  });
  for(const e of [form,input,submit,textKeys]){
   e.addEventListener('pointerdown',resetMenuTimer);
   e.addEventListener('keydown',resetMenuTimer);
  }
  input.addEventListener('input',resetMenuTimer);
  toggle.addEventListener('pointerdown',resetMenuTimer);
  logButton.addEventListener('pointerdown',resetMenuTimer);
  wakeButton.addEventListener('pointerdown',resetMenuTimer);
  reconnectButton.addEventListener('pointerdown',resetMenuTimer);
  card.refreshMenu=()=>{
   fab.className='multi-fab'+(card.menuOpen?' is-open':'')+
    (card.enabled?' is-control-enabled':'');
   for(const b of nav.slice(0,3))b.hidden=!card.enabled;
   if(!card.enabled){card.textOpen=false;form.hidden=true;}
  };
  this.cards.set(card.id,card);
  this.updatePicker();
  card.settleLaunch=()=>{
   if(card.startSettled)return;
   card.startSettled=true;
   if(this.opening&&card.nextLaunch)card.nextLaunch();
  };
  const mark=(msg,error=false)=>{
   state.textContent=msg;state.className='status'+(error?' error':'');
   if(error)card.lastFailure=msg;
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
   const sessionReady=!card.closed&&card.session&&card.ws&&
    card.ws.readyState===WebSocket.OPEN&&card.state!=='stopping';
   wakeButton.disabled=!sessionReady||Boolean(card.experiment)||card.wakePending||card.reconnectRequested;
   reconnectButton.disabled=!sessionReady||card.reconnectRequested||this.opening;
   const canToggle=!card.closed&&card.ready&&!card.permissionWarningShown&&
    (card.state==='ready'||card.state==='playing')&&!card.pending&&
    card.ws&&card.ws.readyState===WebSocket.OPEN&&Boolean(card.session);
   toggle.disabled=!canToggle;
   toggle.title=card.pending?'正在确认…':card.enabled?'关闭远控':'启用远控';
   toggle.setAttribute('aria-label',toggle.title);
   toggle.setAttribute('aria-pressed',String(card.enabled));
   const canInput=canToggle&&card.enabled&&!card.lastInput;
   input.disabled=!canInput;submit.disabled=!canInput;
   textButton.disabled=!canInput;
   nav.forEach(b=>b.disabled=!canInput);
   card.refreshMenu();
   stop.disabled=card.closed||card.state==='stopping';
  };
  card.refresh=refresh;
  try{
   card.player=root.EasyADBPlayers.create('mse',video,{
    lowOverhead:true,lowLatency:card.lowLatency,
    onState:stage=>{
     if(card.closed)return;
     if(stage==='ready'&&card.state!=='stopping'&&card.state!=='playing'){
      card.state='ready';mark('MSE 已就绪，控制通道可单独开启；等待首帧…');
      refresh();this.updatePicker();
     }
     if(stage==='playing'&&card.state!=='stopping'&&card.state!=='playing'){
      card.state='playing';mark('画面播放中（此路独立会话）');
      refresh();this.updatePicker();
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
    if(card.experiment)payload.display_experiment=card.experiment;
    payload.screen_off=card.screenOff;
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
     refresh();this.updatePicker();
    }else if(m.type==='screen_power_notice'){
     mark(m.message||'已发送显示屏电源指令');
    }else if(m.type==='wake_accepted'){
     card.wakePending=false;mark(m.message||'已发送唤醒请求');refresh();
    }else if(m.type==='wake_error'){
     card.wakePending=false;mark(m.message||'唤醒失败',true);refresh();
     if(m.code==='adb_disconnected')this.onDeviceDisconnected?.(card.id);
    }else if(m.type==='lab_notice'){
     mark(m.message||'显示器实验结果待确认');
     this.status(d.name+'：'+(m.message||'显示器实验已执行')+
      (Number.isInteger(m.display_id)?'（Display '+m.display_id+'）':''));
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
     card.fitScreen(m.width,m.height);
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
      refresh();this.updatePicker();
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
     card.state='stopping';mark('正在清理此路资源…');refresh();this.updatePicker();
    }else if(m.type==='ended'){
     if(m.cleanup_complete!==true){mark('服务端未确认完整清理',true);this.end(card,false);}
     else{
      const restart=card.reconnectRequested;
      mark('已停止，资源已释放');this.end(card,true);
      // Only the explicit one-shot reconnect path may create this new card,
      // after the server has confirmed cleanup and released its slot.
      if(restart)this.reopenAfterClean(card);
     }
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
  wakeButton.addEventListener('click',()=>{
   if(wakeButton.disabled||!card.session||card.closed)return;
   card.wakePending=true;refresh();resetMenuTimer();
   try{card.ws.send(JSON.stringify({type:'wake',session_id:card.session}));}
   catch(e){card.wakePending=false;mark('唤醒请求发送失败：'+e.message,true);refresh();}
  });
  reconnectButton.addEventListener('click',()=>{
   if(reconnectButton.disabled)return;
   this.reconnectFor(card.id);resetMenuTimer();
  });
  stop.addEventListener('click',()=>this.stop(card));
  form.addEventListener('submit',ev=>{
   ev.preventDefault();resetMenuTimer();
   if(submit.disabled)return;
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
 reconnectFor(id){
  const card=this.cards.get(id);
  if(!card||card.closed||card.reconnectRequested||card.state==='stopping'||
     !card.session||!card.ws||card.ws.readyState!==WebSocket.OPEN||this.opening)return false;
  card.reconnectRequested=true;
  this.stop(card,true);this.status(card.name+'：正在清理旧实时画面，清理完成后仅重启此路。');
  return true;
 }
 reopenAfterClean(previous){
  const d=(this.getDevices()||[]).find(item=>item.id===previous.id);
  if(!d||!this.isAdbReady(d)||d.selected_serial!==previous.serial||
     this.isBusyFor(previous.id)||this.opening||this.cards.size>=MAX_DEVICES||
     !this.getToken()){
   this.status(previous.name+'：清理完成，但 ADB 已变化或当前不可启动；未自动连接手机。',true);
   return false;
  }
  this.open(d,previous.quality,null,previous.lowLatency,previous.experiment,previous.screenOff);
  this.status(previous.name+'：已按原画质和显示源重新建立一次视频会话。');
  return true;
 }
 stop(card,keepSelected=false){
  if(card.closed||card.state==='stopping')return;
  // A single stopped/failed card is no longer a pending append candidate
  // while other phones remain live. Full-stop explicitly retains selections
  // for a deliberate restart of the former set.
  card.keepSelected=keepSelected;
  if(card.touch){card.touch.disable();}
  card.enabled=false;card.pending=false;card.lastInput=false;
  card.state='stopping';card.refresh();this.updatePicker();
  if(card.ws&&card.ws.readyState===WebSocket.OPEN){
   try{card.ws.send('stop');card.stateEl.textContent='正在请求服务端停止并清理…';}
   catch{this.end(card,false);}
  }else this.end(card,false);
 }
 stopFor(id){
  const card=this.cards.get(id);
  if(card){this.stop(card);return true;}
  // Explicit cancellation of a still-queued, not-yet-opened device.
  const before=this.launchQueue.length;
  this.launchQueue=this.launchQueue.filter(item=>item.device.id!==id);
  if(before===this.launchQueue.length)return false;
  this.dropBatchSelection(id);
  this.lastLiveStatus.set(id,'已取消排队');
  this.updatePicker();return true;
 }
 stopSelected(){
  // Only the selected rows are stopped/cancelled. Unselected sessions and
  // their player/control sockets remain untouched.
  if(!this.getBatchSelection){this.stopAll();return;}
  const picked=new Set(this.getBatchSelection());
  if(!picked.size)return;
  const canceled=this.launchQueue.filter(item=>picked.has(item.device.id));
  this.launchQueue=this.launchQueue.filter(item=>!picked.has(item.device.id));
  for(const item of canceled)this.lastLiveStatus.set(item.device.id,'已取消排队');
  for(const [id,card] of [...this.cards])
   if(picked.has(id))this.stop(card,true);
  this.updatePicker();
 }
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
  if(card.menuTimer!==null){root.clearTimeout(card.menuTimer);card.menuTimer=null;}
  card.menuOpen=false;card.textOpen=false;
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
  this.lastLiveStatus.set(card.id,clean?'已停止':
   (card.lastFailure?'异常结束':'已结束 · 清理未确认'));
  if(!card.keepSelected&&this.cards.size>1)this.dropBatchSelection(card.id);
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
