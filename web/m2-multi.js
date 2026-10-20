/* M2-06: one-page, multi-phone viewing. Every card owns its player, socket,
 * traffic, metrics, touch and current session. No cross-browser takeover,
 * background reconnect, global keyboard capture or automatic ADB connect.
 */
(function(root){
'use strict';
const MAX_DEVICES=20;
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
const EXPERIMENTAL_RESOLUTIONS=[
 ['2560x1440','2560 × 1440'],['1920x1440','1920 × 1440'],
 ['1920x1200','1920 × 1200'],['1920x1080','1920 × 1080'],
 ['1680x1050','1680 × 1050'],['1600x1200','1600 × 1200'],
 ['1600x1024','1600 × 1024'],['1600x900','1600 × 900'],
 ['1440x1080','1440 × 1080'],['1440x900','1440 × 900'],
 ['1366x768','1366 × 768']
];
const CUSTOM={
 max_size:[['960','960'],['1280','1280'],['1600','1600'],['0','原生']],
 video_bit_rate:[['2000000','2 Mbps'],['3000000','3 Mbps'],['4000000','4 Mbps'],['8000000','8 Mbps'],['12000000','12 Mbps'],['16000000','16 Mbps'],['18000000','18 Mbps'],['20000000','20 Mbps']],
 max_fps:[['15','15 FPS'],['24','24 FPS'],['30','30 FPS'],['45','45 FPS'],['55','55 FPS'],['60','60 FPS']],
 dpi:[['160','160 DPI'],['200','200 DPI'],['240','240 DPI（默认）'],['280','280 DPI'],['320','320 DPI'],['360','360 DPI'],['400','400 DPI'],['420','420 DPI'],['480','480 DPI'],['560','560 DPI']]
};
const choice=(options,value)=>{
 const select=make('select','multi-quality');
 for(const [id,label] of options){const opt=make('option','',label);opt.value=id;opt.selected=id===String(value);select.append(opt);}
 select.value=String(value);return select;
};
const resolutionChoice=value=>{
 const select=choice(CUSTOM.max_size,value),group=make('optgroup');
 group.label='实验性分辨率';
 for(const [id,label] of EXPERIMENTAL_RESOLUTIONS){
  const option=make('option','',label);option.value='exp:'+id;group.append(option);
 }
 select.append(group);select.value=String(value);return select;
};
const defaults=()=>({profile:'custom',max_size:960,experimental_resolution:null,
 video_bit_rate:3000000,max_fps:24,dpi:240,low_latency:true,screen_off:false});
const qualityPayload=v=>v.profile==='custom'
 ?{profile:'custom',quality:{max_size:v.experimental_resolution?0:v.max_size,
    video_bit_rate:v.video_bit_rate,max_fps:v.max_fps}}
 :{profile:v.profile};
const resolutionExperiment=v=>{
 if(!v.experimental_resolution)return null;
 const [width,height]=v.experimental_resolution.split('x').map(Number);
 return {mode:'new_resolution',width,height,dpi:v.dpi};
};
const briefQuality=v=>v.profile==='custom'
 ?'自定义 · '+(v.experimental_resolution?'实验性虚拟屏幕 '+v.experimental_resolution.replace('x','×'):(v.max_size||'原生'))+
  ' / '+(v.video_bit_rate/1000000)+' Mbps / '+v.max_fps+' FPS'+
  (v.experimental_resolution?' / '+v.dpi+' DPI':'')
 :(CHOICES.find(x=>x[0]===v.profile)||CHOICES[0])[1];
class MultiView{
 constructor({picker,grid,startButton,stopButton,info,getDevices,getToken,onChange,runPreflight,runVideoProbe,onDeviceDisconnected,getManagementBusy,getBatchSelection,onBatchSelectionRemove,onProjectionStarted,onOpenManagement,readUnlockSettings,saveUnlockSettings}){
  Object.assign(this,{picker,grid,startButton,stopButton,info,getDevices,getToken,onChange,runPreflight,runVideoProbe,onDeviceDisconnected,getManagementBusy,getBatchSelection,onBatchSelectionRemove,readUnlockSettings,saveUnlockSettings});
  this.onProjectionStarted=onProjectionStarted;this.onOpenManagement=onOpenManagement;
  this.selected=new Set();this.cards=new Map();this.opening=false;this.launchQueue=[];
  this.stopBatch=null; // independent per-device acknowledgements, no global stop wait
  this.videoEngine='webrtc';this.engineReady=true;this.engineSupported=true;
  if(typeof root.fetch==='function'){
   this.engineReady=false;
   root.fetch('/api/m2/video-engine',{cache:'no-store'})
    .then(r=>{if(!r.ok)throw Error('无法加载服务端视频引擎配置');return r.json();})
    .then(data=>{
     if(!['webrtc','webcodecs'].includes(data.engine))throw Error('未知视频引擎');
     this.videoEngine=data.engine;this.engineSupported=data.implemented===true;
     this.engineReady=true;
     this.status('当前视频引擎：'+({webrtc:'WebRTC',
      webcodecs:'WebCodecs（尚未实现）'})[data.engine]+
      (this.engineSupported?'':'；请在 .env 改用 webrtc'),!this.engineSupported);
     this.updatePicker();
    }).catch(e=>{this.engineReady=false;this.status(e.message+'；暂不允许启动投屏',true);});
  }
  this.qualityChoices=new Map();this.probeResults=new Map();this.qualityHistory=new Map();
  this.playbackOpen=new Set();
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
   // DPI configures ONLY a new virtual display; ordinary primary-screen
   // mirroring never modifies Android's persistent wm density.
   const custom=make('div','multi-custom');
   for(const [key,label] of [['max_size','分辨率上限'],['video_bit_rate','目标码率'],['max_fps','最高帧率'],['dpi','DPI']]){
    const field=make('label','',label);
    const sel=key==='max_size'
     ?resolutionChoice(value.experimental_resolution?'exp:'+value.experimental_resolution:value.max_size)
     :choice(CUSTOM[key],value[key]);
    sel.setAttribute('aria-label',d.name+' '+label);
    // DPI is always selectable as a per-device preference; only a new
    // virtual display sends it to scrcpy. Never change Android wm density.
    sel.disabled=busy||!connected;
    sel.addEventListener('change',()=>{
     if(key==='max_size'){
      const experimental=sel.value.startsWith('exp:')?sel.value.slice(4):null;
      this.setChoice(d.id,experimental
       ?{profile:'custom',experimental_resolution:experimental,screen_off:false}
       :{profile:'custom',max_size:Number(sel.value),experimental_resolution:null});
     }else this.setChoice(d.id,{profile:'custom',[key]:Number(sel.value)});
    });
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
   screenOff.type='checkbox';screenOff.checked=value.screen_off===true&&!value.experimental_resolution;
   screenOff.disabled=busy||!connected||Boolean(value.experimental_resolution);
   screenOff.setAttribute('aria-label',d.name+' 投屏时关闭手机物理屏幕');
   screenOff.addEventListener('change',()=>this.setChoice(d.id,{screen_off:screenOff.checked}));
   panel.append(screenOff,make('span','','投屏时关闭手机物理屏幕（远端画面继续显示）'));
   const playback=make('details','multi-playback-options');
   playback.open=this.playbackOpen.has(d.id);
   playback.addEventListener('toggle',()=>{
    if(playback.isConnected===false)return;
    if(playback.open)this.playbackOpen.add(d.id);else this.playbackOpen.delete(d.id);
   });
   playback.append(make('summary','','播放选项'),panel,latency);
   item.append(playback);
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
  const selectedRunning=selectedDevices.filter(d=>this.cards.has(d.id)&&
   this.cards.get(d.id).state!=='stopping');
  this.stopButton.disabled=selectedRunning.length===0||Boolean(this.stopBatch);
  this.stopButton.textContent='批量停止投屏（'+selectedRunning.length+' 台）';
  this.startButton.textContent=(this.cards.size?'批量追加投屏':'批量投屏')+
   '（待新增 '+available.length+' 台 / 剩余 '+remaining+' 路）';
  this.grid.setAttribute('data-count',String(this.cards.size));
  this.groupControl?.refresh();
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
  const last=this.lastLiveStatus.get(id)||'未开启';
  return {code:/异常结束|清理未确认|启动失败/.test(last)?'error':'idle',
   label:last,active:false};
 }
 projectionButton(d){
  // The ADB port chip is the ONLY individual projection toggle; no extra
  // adjacent icon, no bulk-selection mutation and no new ADB connection.
  const live=this.liveState(d.id),adbReady=this.isAdbReady(d);
  const state=live.code;
  const adbTone=adbReady?'connected':
   ['checking','connecting'].includes(d.status)?d.status:
   d.connect_failed===true||d.status==='error'?'failed':'idle';
  const adbAddress=adbReady?d.active_serial:d.selected_serial;
  const adbLabel=adbReady?'ADB 已连接':
   adbTone==='failed'?'ADB 连接失败':
   adbTone==='connecting'?'ADB 连接中':
   adbTone==='checking'?'ADB 检查中':'ADB 未连接';
  const button=make('button','device-port device-projector '+state+' adb-'+adbTone,'ADB '+d.port);
  button.type='button';
  const projectionLabel=live.active?'关闭此设备投屏 · '+live.label:
   adbReady?'开启此设备投屏 · '+live.label:'请先连接 ADB 再投屏';
  button.title=adbLabel+(adbAddress?' · '+adbAddress:'')+'\n'+projectionLabel;
  button.setAttribute('aria-label',d.name+' · '+adbLabel+
   (adbAddress?' · '+adbAddress:'')+' · '+projectionLabel);
  button.setAttribute('data-adb-state',adbTone);
  button.setAttribute('aria-pressed',String(live.active));
  button.setAttribute('data-projection-state',state);
  button.disabled=live.active
   ?live.code==='stopping'
   :!adbReady||this.opening||this.getManagementBusy?.()||
    this.checking.has(d.id)||this.cards.size>=MAX_DEVICES;
  button.addEventListener('click',()=>{
   if(button.disabled)return;
   // Re-read the live session at click time, not the state captured by render.
   // This avoids stale buttons opening duplicate media sessions.
   if(this.liveState(d.id).active)this.stopFor(d.id);else this.startFor(d.id);
  });
  return button;
 }
 openSettings(d){
  // Native modal with a draft: do not mutate a running/queued session or
  // rebuild the hidden per-device picker until Save is pressed.
  if(this.settingsDialog?.open)return false;
  const previous=this.getChoice(d.id),dialog=make('dialog','quality-settings-dialog');
  const form=make('form','quality-settings-form');
  const head=make('div','quality-settings-head'),close=make('button','secondary','×');
  close.type='button';close.setAttribute('aria-label','关闭投屏参数设置');
  head.append(make('h2','','投屏参数 · '+d.name),close);
  const description=make('p','muted','四项画质参数与播放设置按设备独立保存（本页面会话内）。'+
   '正在投屏时可编辑，但当前会话不热切换，保存后仅对下一次投屏生效。');
  const fields=make('div','quality-settings-fields');
  const selectors={};
  for(const [key,label] of [['max_size','分辨率上限'],['video_bit_rate','目标码率'],
   ['max_fps','最高帧率'],['dpi','DPI']]){
   const field=make('label','',label);
   const selected=key==='max_size'?
    (previous.experimental_resolution?'exp:'+previous.experimental_resolution:previous.max_size):
    previous[key];
   const select=key==='max_size'?resolutionChoice(selected):choice(CUSTOM[key],selected);
   select.setAttribute('aria-label',d.name+' '+label);
   selectors[key]=select;field.append(select);fields.append(field);
  }
  const section=make('fieldset','quality-playback');
  section.append(make('legend','','播放设置'));
  const latency=make('label','quality-setting-check'),low=make('input');
  low.type='checkbox';low.checked=previous.low_latency===true;
  latency.append(low,make('span','','低延迟播放实验（仅浏览器追帧，不改变手机编码）'));
  const screenLabel=make('label','quality-setting-check'),screenOff=make('input');
  screenOff.type='checkbox';screenOff.checked=previous.screen_off===true&&!previous.experimental_resolution;
  screenLabel.append(screenOff,make('span','','投屏时关闭手机物理屏幕（远端画面继续显示）'));
  const experimentHint=make('p','muted','实验性虚拟分辨率使用所选 DPI，不改变手机原有系统 DPI；此模式不支持关闭物理屏幕。');
  let hasUnlock=false,serverHasUnlock=false;
  const syncExperiment=()=>{
   const experimental=selectors.max_size.value.startsWith('exp:');
   screenOff.disabled=experimental||hasUnlock;
   if(screenOff.disabled)screenOff.checked=false;
   experimentHint.hidden=!experimental;
  };
  selectors.max_size.addEventListener('change',syncExperiment);syncExperiment();
  section.append(latency,screenLabel,experimentHint);
  const unlockLabel=make('label','quality-unlock-entry','开屏密码（可选）');
  const unlockInput=make('input','quality-unlock-input');
  unlockInput.type='password';unlockInput.maxLength=32;unlockInput.autocomplete='new-password';
  unlockInput.placeholder='4～32 位英文数字；留空表示保留原密码';
  unlockInput.setAttribute('aria-label',d.name+' 开屏密码');
  const unlockHint=make('p','muted','配置后，单次/批量投屏自动亮屏；仅确认锁屏时滑动、输入密码和回车。');
  const unlockState=make('p','muted','密码状态：正在读取…');
  const clearLabel=make('label','quality-setting-check'),clear=make('input');
  clear.type='checkbox';clearLabel.append(clear,make('span','','清除已保存的开屏密码'));
  unlockInput.addEventListener('input',()=>{
   if(unlockInput.value)clear.checked=false;
   hasUnlock=Boolean(unlockInput.value)||(!clear.checked&&serverHasUnlock);
   syncExperiment();
  });
  clear.addEventListener('change',()=>{
   if(clear.checked)unlockInput.value='';
   hasUnlock=Boolean(unlockInput.value)||(!clear.checked&&serverHasUnlock);
   syncExperiment();
  });
  unlockLabel.append(unlockInput);section.append(unlockLabel,unlockHint,unlockState,clearLabel);
  if(this.readUnlockSettings){
   Promise.resolve(this.readUnlockSettings(d.id)).then(state=>{
    if(dialog.open){
     serverHasUnlock=state.configured===true;
     hasUnlock=serverHasUnlock&&!clear.checked||Boolean(unlockInput.value);
     unlockState.textContent='密码状态：'+(state.configured?'已配置（不会回显）':'未配置');
     syncExperiment();
    }
   }).catch(()=>{if(dialog.open)unlockState.textContent='密码状态：读取失败，请检查服务端。';});
  }else unlockState.textContent='密码状态：未配置';
  const footer=make('div','modal-actions'),cancel=make('button','secondary','取消'),
   save=make('button','','保存设置');
  cancel.type='button';save.type='submit';footer.append(cancel,save);
  form.append(head,description,fields,section,footer);dialog.append(form);
  const dismiss=()=>{if(dialog.open)dialog.close();else dialog.remove();};
  close.addEventListener('click',dismiss);cancel.addEventListener('click',dismiss);
  dialog.addEventListener('close',()=>{
   dialog.remove();if(this.settingsDialog===dialog)this.settingsDialog=null;
  });
  form.addEventListener('submit',event=>{
   event.preventDefault();
   const resolution=selectors.max_size.value;
   const experiment=resolution.startsWith('exp:')?resolution.slice(4):null;
   const password=unlockInput.value,remove=clear.checked;
   if(password&&!/^[A-Za-z0-9]{4,32}$/.test(password)){
    unlockState.textContent='仅支持 4～32 位英文数字密码';return;
   }
   const finalize=()=>{
    if(!dialog.open)return;
    this.setChoice(d.id,{
     profile:'custom',
     max_size:experiment?previous.max_size:Number(resolution),
     experimental_resolution:experiment,
     video_bit_rate:Number(selectors.video_bit_rate.value),
     max_fps:Number(selectors.max_fps.value),dpi:Number(selectors.dpi.value),
     low_latency:low.checked,screen_off:!experiment&&screenOff.checked
    });
    unlockInput.value='';
    this.status(d.name+'：投屏参数已保存，下次投屏生效。');
    dismiss();
   };
   if((password||remove)&&this.saveUnlockSettings){
    save.disabled=true;
    Promise.resolve(this.saveUnlockSettings(d.id,remove?'':password))
     .then(finalize).catch(()=>{save.disabled=false;
      unlockState.textContent='开屏密码保存失败，请检查服务端并重试。';});
   }else finalize();
  });
  root.document.body.append(dialog);this.settingsDialog=dialog;dialog.showModal();
  return true;
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
  // Display lab uses the same per-device WebRTC session, not a second transport.
  const d=(this.getDevices()||[]).find(item=>item.id===id);
  if(!d||!this.isAdbReady(d)||this.isBusyFor(id)||this.opening||
     this.cards.size>=MAX_DEVICES||this.getManagementBusy?.()||!this.getToken()||
     !this.engineReady||!this.engineSupported)return false;
  if(!experiment||!["new","new_settings","display"].includes(experiment.mode))return false;
  const choice=this.getChoice(id);
  this.lastLiveStatus.delete(id);
  this.open(d,qualityPayload(choice),null,choice.low_latency===true,experiment,false);
  this.updatePicker();
  this.onProjectionStarted?.();
  return true;
 }
 _startDevices(additions){
  if(this.opening||this.getManagementBusy?.())return false;
  if(!additions.length||new Set(additions.map(d=>d&&d.id)).size!==additions.length||
     additions.length>MAX_DEVICES-this.cards.size||
     additions.some(d=>!d||this.isBusyFor(d.id)||!this.isAdbReady(d)||this.checking.has(d.id))){
   this.status('请检查目标设备是否已手动连接、当前是否已有会话及剩余投屏名额（最多 '+MAX_DEVICES+' 路）。',true);
   this.updatePicker();return false;
  }
  if(!this.engineReady||!this.engineSupported){this.status('当前视频引擎未就绪或尚未实现。',true);return false;}
  if(!this.getToken()){this.status('请先填写访问密钥并加载设备。',true);return false;}
  const batch=additions.map(d=>({device:d,quality:qualityPayload(this.getChoice(d.id)),
   experiment:resolutionExperiment(this.getChoice(d.id)),
   lowLatency:this.getChoice(d.id).low_latency===true,
   screenOff:this.getChoice(d.id).screen_off===true&&!this.getChoice(d.id).experimental_resolution}));
  const isAppend=this.cards.size>0;
  for(const d of additions)this.lastLiveStatus.delete(d.id);
  this.opening=true;
  // Reserve the complete batch before creating cards. Every device opens
  // its OWN WS immediately; each synchronous FastAPI startup / scrcpy worker
  // proceeds concurrently. Do not wait for device A's first frame to start B.
  this.launchQueue=batch;
  this.status((isAppend?'正在并发追加 ':'正在并发启动 ')+additions.length+
   ' 路独立投屏；最多同时 '+MAX_DEVICES+' 路，已经运行的设备保持原会话与远控。');
  this._launchNext();
  this.updatePicker();
  this.onProjectionStarted?.();
  return true;
 }
 _launchNext(){
  if(!this.opening)return;
  // A single JS event-loop turn atomically reserves and dispatches the batch.
  // The sessions, offers, ADB processes and results then progress independently.
  const pending=this.launchQueue.splice(0);
  try{
   for(const next of pending){
    try{this.open(next.device,next.quality,null,next.lowLatency,next.experiment,next.screenOff);}
    catch(error){
     this.lastLiveStatus.set(next.device.id,'启动失败');
     this.status(next.device.name+'：'+error.message,true);
    }
   }
  }finally{
   this.opening=false;
   for(const card of this.cards.values())card.refresh?.();
   this.updatePicker();
  }
 }
 open(d,quality,nextLaunch,lowLatency=false,experiment=null,screenOff=false){
  if(this.cards.has(d.id)){ // Never create a second video/WS for this device.
   if(nextLaunch)nextLaunch();
   return;
  }
  const card={id:d.id,serial:d.selected_serial,name:d.name,quality,lowLatency,experiment,
   engine:this.videoEngine,
   screenOff:screenOff===true&&!experiment,reconnectRequested:false,wakePending:false,
   stopTimer:null,unlockPending:false,
   ws:null,session:null,
   state:'connecting',closed:false,enabled:false,pending:false,ready:false,size:null,
   keepSelected:false,
   touch:null,player:null,video:null,meter:new root.EasyADBTraffic.Meter(performance.now()),
   metrics:new root.EasyADBMetrics.QualityMeter(performance.now()),lastInput:false,
   startSettled:false,nextLaunch,adbCheckMs:null,frameLastAt:null,frameCount:0,
   permissionWarningShown:false,autoControlRejected:false,
   history:this.qualityHistory.get(d.id)||[],logLines:[]};
  const box=make('article','multi-card'),header=make('div','heading');
  header.append(make('strong','',d.name+(experiment?.mode==='new_resolution'?' · 实验性虚拟屏幕':
  experiment?' · 电脑模式实验':'')),
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
  const qualityLine=make('div','muted','视频引擎：WebRTC'+
   ' / 本设备画质：'+briefQuality(this.getChoice(d.id))+
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
   make('h4','','WebRTC / 资源详情'),diagnostic,
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
  const closeStreamButton=icon('fab-up-stop','✕','关闭当前投屏并展开设备管理');
  wakeButton.disabled=true;reconnectButton.disabled=true;closeStreamButton.disabled=true;
  // Remote control is enabled automatically when this session's control
  // socket becomes ready; there is no manual on/off button in the FAB.
  const textButton=icon('fab-text','⌨','文字与按键输入');textButton.disabled=true;
  const unlockButton=icon('fab-unlock','🔓','主动解锁（使用本设备已保存密码）');unlockButton.disabled=true;
  const fullscreenButton=icon('fab-fullscreen','⛶','全屏展示');
  fullscreenButton.disabled=typeof screen.requestFullscreen!=='function';
  fullscreenButton.setAttribute('aria-pressed','false');
  const form=make('form','multi-text-panel');form.hidden=true;
  form.setAttribute('aria-label','本设备文字与按键输入');
  const input=make('input'),submit=make('button','','发送');
  input.type='text';input.maxLength=300;input.autocomplete='off';
  input.placeholder='仅 ASCII；等待本设备控制通道就绪';
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
   else fab.append(btn);
   btn.addEventListener('click',()=>{
    if(btn.disabled)return;
    this.sendInput(card,'nav_key',{key});resetMenuTimer();
   });
   nav.push(btn);
  }
  form.append(textHead,textEntry,textKeys);
  const keyStatus=make('div','muted','默认只观看，不会全局捕获键盘。');
  detail.append(make('h4','','远控输入状态'),keyStatus);
  fab.append(logButton,wakeButton,reconnectButton,closeStreamButton,textButton,unlockButton,fullscreenButton,main,form);
  screen.append(fab);box.append(header,screen);this.grid.append(box);
  Object.assign(card,{box,screen,fitScreen,video,stateEl:state,statsEl:stats,
   qualityLine,form,fab,main,logButton,wakeButton,reconnectButton,closeStreamButton,fullscreenButton,
   logPanel,logClose,stop,
   textButton,unlockButton,textClose,textKeys,input,submit,nav,keyStatus,
   initInfo,diagnostic,eventLog,historyEl:history,menuOpen:false,textOpen:false,
   menuTimer:null});
  // Browser handles Escape natively; this event keeps the icon synchronized
  // when Escape, browser UI or another card exits/replaces fullscreen.
  const syncFullscreen=()=>{
   const active=root.document.fullscreenElement===screen;
   fullscreenButton.textContent=active?'↙':'⛶';
   fullscreenButton.title=active?'退出全屏（Esc）':'全屏展示';
   fullscreenButton.setAttribute('aria-label',fullscreenButton.title);
   fullscreenButton.setAttribute('aria-pressed',String(active));
  };
  root.document.addEventListener?.('fullscreenchange',syncFullscreen);
  card.syncFullscreen=syncFullscreen;
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
  logButton.addEventListener('pointerdown',resetMenuTimer);
  wakeButton.addEventListener('pointerdown',resetMenuTimer);
  reconnectButton.addEventListener('pointerdown',resetMenuTimer);
  closeStreamButton.addEventListener('pointerdown',resetMenuTimer);
  fullscreenButton.addEventListener('pointerdown',resetMenuTimer);
  unlockButton.addEventListener('pointerdown',resetMenuTimer);
  card.refreshMenu=()=>{
   fab.className='multi-fab'+(card.menuOpen?' is-open':'')+
    (card.enabled?' is-control-enabled':'');
   // The three fixed navigation buttons follow the main FAB's visibility
   // (CSS .is-open), not the asynchronous control handshake.
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
   this.groupControl?.updateLog();
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
   closeStreamButton.disabled=!sessionReady||card.reconnectRequested;
   // Manual unlock does not depend on decoder playback nor the browser's
   // general control_enabled latch; the server validates THIS session.
   unlockButton.disabled=!sessionReady||!card.ready||Boolean(card.experiment)||
    card.unlockPending||card.reconnectRequested;
   const controlReady=!card.closed&&card.ready&&!card.permissionWarningShown&&!card.autoControlRejected&&
    (card.state==='ready'||card.state==='playing')&&!card.pending&&
    card.ws&&card.ws.readyState===WebSocket.OPEN&&Boolean(card.session);
   const canInput=controlReady&&card.enabled&&!card.lastInput;
   input.disabled=!canInput;submit.disabled=!canInput;
   textButton.disabled=!canInput;
   nav.forEach(b=>b.disabled=!canInput);
   card.refreshMenu();
   stop.disabled=card.closed||card.state==='stopping';
   this.groupControl?.refresh();
  };
  card.refresh=refresh;
  try{
   card.player=root.EasyADBWebRTC.create(video,{
    onState:stage=>{
     if(card.closed)return;
     if(stage==='ready'&&card.state!=='stopping'&&card.state!=='playing'){
      card.state='ready';mark('WebRTC 已就绪，远控独立于媒体连接');refresh();this.updatePicker();
     }
     if(stage==='playing'&&card.state!=='stopping'&&card.state!=='playing'){
      card.state='playing';mark('WebRTC 画面播放中');refresh();this.updatePicker();
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
    const payload={token:this.getToken(),player:card.engine,selected_serial:card.serial,
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
     mark('WebRTC 信令通道收到非预期二进制数据',true);this.end(card,false);return;
    }
    let m;try{m=JSON.parse(ev.data);}catch{mark('服务端返回非法消息',true);this.end(card,false);return;}
    if(m.session_id&&card.session&&m.session_id!==card.session){
     mark('会话标识不匹配，已停止此路',true);this.end(card,false);return;
    }
    if(m.type==='starting'){
     card.session=m.session_id;card.adbCheckMs=m.adb_check_ms;mark('已启动，正在等待手机编码…');
     refresh();this.updatePicker();
     card.player.start(ws,card.session).catch(e=>{
      if(!card.closed){mark('WebRTC Offer 失败：'+e.message,true);this.end(card,false);}
     });
    }else if(m.type==='webrtc_answer'){
     card.player.answer(m.sdp).catch(e=>{
      if(!card.closed){mark('WebRTC Answer 失败：'+e.message,true);this.end(card,false);}
     });
    }else if(m.type==='screen_power_notice'){
     mark(m.message||'已发送显示屏电源指令');
    }else if(m.type==='unlock_notice'){
     card.unlockPending=m.status==='running';
     mark((m.source==='manual'?'主动解锁：':'自动解锁：')+
      (m.message||'本次解锁操作结束'),m.error===true);
     if(m.source==='manual'&&m.status!=='running')
      this.status(d.name+'：'+(m.message||'解锁操作结束'),m.error===true);
     refresh();
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
     card.player.pollStats(delta=>{
       if(!card.closed){card.meter.record(delta);card.metrics.recordBytes(delta);}
      });
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
       '｜本路进程 CPU '+fmt(m.proc_cpu_pct)+'% / RSS '+fmt(m.proc_rss_mib)+' MiB（ADB shell）';
     const age=v=>Number.isFinite(v)?fmt(v/1000,2)+'s':'—';
     diagnostic.textContent='会话 '+card.session+' / ADB 检查 '+(card.adbCheckMs??'—')+'ms'+
      ' / 阶段 '+m.stage+' / 已运行 '+age(m.elapsed_ms)+
      '\\n手机编码包 '+(m.phone_packets??'—')+' / 距上包 '+age(m.phone_idle_ms)+
      ' / WebRTC 已取帧 '+(m.webrtc_sent_frames??0)+
      ' / 入轨队列丢帧 '+(m.webrtc_dropped_frames??0)+
      '\\n首关键帧 '+age(m.init_ready_ms)+
      ' / RTP 浏览器累计接收 '+root.EasyADBTraffic.size(pd.webrtcBytes||0)+
      ' / 本路浏览器收到 '+root.EasyADBTraffic.size(traffic.totalBytes)+
      '\\nICE/DTLS '+pd.sourceState+' / 播放点 '+fmt(pd.currentTime,2)+'s'+
      ' / 解码帧 '+(pd.webrtcFrames??'—')+' / 丢帧 '+(pd.webrtcDrops??'—')+
      ' / Video error '+(pd.videoError??'无')+
      ' / Android 控制提示 '+(m.control_warning||'无已确认拒绝');
    }else if(m.type==='init'){
     card.ready=m.control_available===true;
     card.size={width:m.width,height:m.height};
     card.fitScreen(m.width,m.height);
     mark('实际编码 '+m.width+'×'+m.height+
      (card.experiment?.mode==='new_resolution'
       ?' · 请求虚拟屏幕 '+card.experiment.width+'×'+card.experiment.height+
        '（不额外限制最长边）'
       :' · 请求上限 '+(m.requested?((m.requested.max_size||'原生')+' / '+
        m.requested.video_bit_rate/1000000+' Mbps / '+m.requested.max_fps+' FPS'):'—')));
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
      // Single and batch launches share open(): enable only THIS session
      // once the current scrcpy control channel has been announced as ready.
      if(card.ready&&!card.closed&&!card.pending&&!card.enabled&&!card.permissionWarningShown){
       card.pending=true;refresh();
       try{ws.send(JSON.stringify({type:'control_enable',session_id:card.session}));}
       catch(e){mark('自动开启远控失败：'+e.message,true);this.end(card,false);return;}
      }else if(!card.ready){
       keyStatus.textContent='本轮控制通道不可用，导航及输入已禁用。';
      }
      card.settleLaunch(); // start next phone only after this pipeline initialized
     }catch(e){mark(e.message,true);this.end(card,false);}
    }else if(m.type==='control_enabled'){
     if(card.autoControlRejected)return; // never resurrect a rejected one-shot opt-in
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
     if(!card.permissionWarningShown)keyStatus.textContent='服务端已关闭此路控制，当前仅可观看。';
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
     // Fail closed if the one-shot automatic control opt-in was rejected;
     // do not repeatedly send enable requests or imply inputs will work.
     const enableRejected=card.pending&&!card.enabled;
     card.pending=false;
     if(enableRejected)card.autoControlRejected=true;
     refresh();
     keyStatus.textContent=m.message||'自动开启控制失败，本轮仅可观看';
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
  unlockButton.addEventListener('click',()=>{
   if(this.requestUnlock(card))resetMenuTimer();
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
  closeStreamButton.addEventListener('click',()=>{
   if(closeStreamButton.disabled||card.closed||card.state==='stopping')return;
   card.openManagementAfterClose=true;
   collapseMenu();
   this.stop(card); // Only this stream. Do not stop the other active devices.
  });
  fullscreenButton.addEventListener('click',()=>{
   if(fullscreenButton.disabled||card.closed)return;
   resetMenuTimer();
   try{
    const operation=root.document.fullscreenElement===screen
     ?root.document.exitFullscreen()
     :screen.requestFullscreen();
    Promise.resolve(operation).catch(()=>mark('浏览器未允许全屏，请检查全屏权限。',true));
   }catch(error){mark('浏览器不支持或未允许此画面全屏。',true);}
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
 requestUnlock(card){
  // No plaintext, credential ID or user input in browser payload.
  if(!card||card.closed||card.unlockButton.disabled||!card.session||!card.ws||
   card.ws.readyState!==WebSocket.OPEN||!card.ready||card.experiment||
   card.state==='stopping'||card.unlockPending)return false;
  card.unlockPending=true;card.refresh();
  try{
   card.ws.send(JSON.stringify({type:'unlock',session_id:card.session}));
   card.keyStatus.textContent='已请求主动解锁，等待服务端确认。';
   return true;
  }catch{
   card.unlockPending=false;card.refresh();
   this.status(card.name+'：主动解锁请求发送失败',true);
   return false;
  }
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
  if(card.engine==='webrtc'){
   // Hide controls immediately while the server is cleaning this media peer.
   // A timeout is NOT cleanup confirmation: never auto-reconnect on it.
   card.collapseMenu();card.fab.hidden=true;card.logPanel.hidden=true;
   card.stopTimer=root.setTimeout(()=>{
    card.stopTimer=null;
    if(card.closed||card.state!=='stopping')return;
    card.reconnectRequested=false;
    card.lastFailure='WebRTC 停止确认超时；服务端资源未确认释放，请检查 NAS 日志';
    card.stateEl.textContent=card.lastFailure;
    card.stateEl.className='status error';
    this.status(card.name+'：停止确认超时，页面已移除旧画面；不代表服务端资源已释放，不会自动重连。',true);
    this.end(card,false);
   },40000);
  }
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
  // Dispatch stop over ALL selected live sessions in this event-loop turn.
  // Every WS independently reports cleanup; no phone waits for another.
  if(!this.getBatchSelection){this.stopAll();return;}
  if(this.stopBatch)return;
  const picked=new Set(this.getBatchSelection());
  const targets=[...this.cards.values()].filter(c=>picked.has(c.id)&&
   !c.closed&&c.state!=='stopping');
  if(!targets.length)return;
  this.stopBatch={pending:new Set(targets.map(c=>c.id)),total:targets.length,clean:0,failed:0};
  for(const card of targets)this.stop(card,true);
  this.status('已并发发送 '+targets.length+' 路停止请求；各设备独立清理，不互相等待。');
  this.updatePicker();
 }
 stopAll(){
  this.opening=false;this.launchQueue=[];
  const targets=[...this.cards.values()].filter(c=>!c.closed&&c.state!=='stopping');
  if(targets.length&&!this.stopBatch)
   this.stopBatch={pending:new Set(targets.map(c=>c.id)),total:targets.length,clean:0,failed:0};
  for(const card of targets)this.stop(card,true);
  this.updatePicker();
 }
 closeAll(){
  this.opening=false;this.launchQueue=[];this.stopBatch=null;
  for(const card of [...this.cards.values()])this.end(card,false);
  this.updatePicker();
 }
 end(card,clean){
  if(card.closed)return;
  card.closed=true;
  root.document.removeEventListener?.('fullscreenchange',card.syncFullscreen);
  let fullscreenExit=null;
  if(root.document.fullscreenElement===card.screen){
   try{fullscreenExit=Promise.resolve(root.document.exitFullscreen());}
   catch{fullscreenExit=Promise.reject(new Error('退出全屏失败'));}
   fullscreenExit.catch(()=>{});
  }
  if(card.stopTimer!==null){root.clearTimeout(card.stopTimer);card.stopTimer=null;}
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
  if(this.stopBatch?.pending.has(card.id)){
   const batch=this.stopBatch;
   batch.pending.delete(card.id);
   if(clean)batch.clean++;else batch.failed++;
   this.status('批量停止进度：'+(batch.total-batch.pending.size)+' / '+batch.total+
    ' 台；已确认清理 '+batch.clean+' 台，未确认 '+batch.failed+' 台。',batch.failed>0);
   if(!batch.pending.size)this.stopBatch=null;
  }
  this.lastLiveStatus.set(card.id,clean?'已停止':
   (card.lastFailure?'异常结束':'已结束 · 清理未确认'));
  if(!card.keepSelected&&this.cards.size>1)this.dropBatchSelection(card.id);
  this.cards.delete(card.id);
  if(card.openManagementAfterClose){
   // The management drawer is outside the fullscreen top layer.
   // Reopen only after the closing stream has left browser fullscreen.
   const showManagement=()=>this.onOpenManagement?.();
   if(fullscreenExit)fullscreenExit.then(showManagement,showManagement);
   else showManagement();
  }
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
