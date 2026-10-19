/* M2-06 individual quality, diagnostics and 1–4 selected-device launch.
 * Mock-only: never opens network, ADB, MediaSource or GitHub runner.
 */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
class El{
 constructor(tag){this.tagName=tag;this.children=[];this.events={};this.style={};this.classList={add(){}};this.value='';this.disabled=false;this.textContent='';this.checked=false;this.open=false;}
 addEventListener(name,fn){(this.events[name]??=[]).push(fn);}
 append(...items){
  for(const item of items){
   if(item.parent){const siblings=item.parent.children;const i=siblings.indexOf(item);if(i!==-1)siblings.splice(i,1);}
   item.parent=this;this.children.push(item);
  }
 }
 replaceChildren(...items){for(const child of this.children)child.parent=null;this.children=[];this.append(...items);}
 remove(){
  this.removed=true;
  if(this.parent){const siblings=this.parent.children;const i=siblings.indexOf(this);if(i!==-1)siblings.splice(i,1);this.parent=null;}
 }
 setAttribute(name,value){this[name]=value;}
 focus(){this.focused=true;}
 fire(name,ev={}){for(const fn of this.events[name]||[])fn({preventDefault(){},...ev});}
}
const timers=new Map();let nextTimer=1;
const fullscreenEvents=new Set();
function advanceMenuTimers(){
 const due=[...timers.entries()].filter(([,timer])=>timer.ms===5000);
 for(const [id,{fn}] of due){timers.delete(id);fn();}
}
function advanceStopTimers(){
 const due=[...timers.entries()].filter(([,timer])=>timer.ms===40000);
 for(const [id,{fn}] of due){timers.delete(id);fn();}
}
const sockets=[];
class WS{
 static OPEN=1;
 constructor(url){this.url=url;this.readyState=0;this.sent=[];sockets.push(this);}
 open(){this.readyState=WS.OPEN;this.onopen();}
 send(value){this.sent.push(value);}
 emit(type,attrs={}){this.onmessage({data:JSON.stringify({type,...attrs})});}
 close(){this.readyState=3;this.onclose?.();}
}
let clock=0;
const root={
 document:{createElement:tag=>new El(tag)},WebSocket:WS,
 setTimeout(fn,ms){assert([5000,40000].includes(ms));const id=nextTimer++;timers.set(id,{fn,ms});return id;},
 clearTimeout(id){timers.delete(id);},
 location:{protocol:'http:',host:'nas.local'},Date,
 performance:{now:()=>{clock+=1000;return clock;}},
 EasyADBPlayers:{create:(_type,_video,cbs)=>({
   initialize(){cbs.onState('ready');},append(){},triggerPlaying(){cbs.onState('playing');},
   diagnostics(){return {queueBytes:0,sourceState:'open',sourceRanges:1,
    rangeEnd:3,currentTime:2,queueChunks:0,appendCalls:4,completedUpdates:4,videoError:null};},
   resume(){},destroy(){}
 })},
 EasyADBTouch:{create:()=>({enable(){},disable(){},destroy(){}})},
 EasyADBTraffic:{Meter:class{
  totalBytes=0;record(n){this.totalBytes+=n;}sample(){return{mbps:1,totalBytes:this.totalBytes};}},
  size:x=>String(x)+'B'},
 EasyADBMetrics:{QualityMeter:class{
  samples=[];recordBytes(){} sample(){this.samples.push({});return{};}
  summary(profile,device){return{profile,device,avgFps:24,avgReceiveMbps:1,avgCpuPct:3,avgRssMib:8,totalBytes:128};}},
  format:()=>'',fmt:(v)=>Number.isFinite(v)?String(v):'—',advice:()=> ''}
};
root.document.addEventListener=(type,fn)=>{if(type==='fullscreenchange')fullscreenEvents.add(fn);};
root.document.removeEventListener=(type,fn)=>{if(type==='fullscreenchange')fullscreenEvents.delete(fn);};
const notifyFullscreen=()=>{for(const fn of [...fullscreenEvents])fn();};
root.document.exitFullscreen=()=>{root.document.fullscreenElement=null;notifyFullscreen();return Promise.resolve();};
El.prototype.requestFullscreen=function(){root.document.fullscreenElement=this;notifyFullscreen();return Promise.resolve();};
root.window=root;
vm.runInNewContext(fs.readFileSync('web/m2-multi.js','utf8'),root,{filename:'m2-multi.js'});
const page=fs.readFileSync('web/index.html','utf8');
assert.match(page,/最多四路/);
assert.doesNotMatch(page,/id="legacySolo"/,'legacy screenshot player must be deleted');
assert.doesNotMatch(page,/id="previewTitle"|id="shotButton"|id="liveVideo"/);
assert.match(page,/class="workspace"/);
assert.match(page,/class="panel inventory-panel"/);
assert.match(page,/elem\('div','device-quality'\)/);
assert.match(page,/class="stage-view"/);
assert.doesNotMatch(page,/class="stage-main"|class="stage-settings"/);
assert.match(page,/id="multiPicker" hidden aria-hidden="true"/);
assert.match(page,/id="multiStart"[\s\S]*id="multiStop"[\s\S]*id="devices"/);
assert.match(page,/批量停止投屏|批量检查状态/);
assert.doesNotMatch(page,/class="panel access-panel"/);
assert.match(page,/<h2>设备管理<\/h2>[\s\S]*id="token"[\s\S]*id="load"/);
assert.match(page,/\/temp-address/);
assert.match(page,/id="devices"[\s\S]*id="multiGrid"/);
assert.match(page,/qualityRows\.get\(d\.id\)/);
assert.match(page,/\.multi-grid\{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:flex-start/);
assert.doesNotMatch(page,/\.multi-grid\[data-count="(?:1|3)"\]|\.multi-grid\{display:grid/);
assert.match(page,/\.multi-card\{flex:0 1 auto;width:386px;max-width:100%/);
assert.match(page,/\.multi-screen\{[^}]*width:100%;max-width:100%/);
assert.match(page,/runPreflight:async id/);
assert.match(page,/runVideoProbe:async\(id,profile\)/);
assert.doesNotMatch(page,/id="multiProfile"/,'no global multiview quality selector');
assert.match(page,/getManagementBusy:\(\)=>loading/);
assert.match(page,/newDevice'\)\.disabled=loading\|\|!loaded/);
assert.match(page,/newGroup'\)\.disabled=loading\|\|!loaded/);
assert.doesNotMatch(page,/请先停止全部同屏，再/,'no global session lock for CRUD');
assert.match(page,/multiView\.isBusyFor\(id\)/,'mutations guard their own device only');
assert.match(page,/id="bulkSelectAll"/);
const toolbar=page.match(/<div class="management-bar"[^>]*>[\s\S]*?<\/div>/)?.[0];
assert(toolbar,'batch buttons share the management toolbar');
const order=['bulkSelectAll','bulkConnect','bulkDelete','multiStart','multiStop','refreshAll']
 .map(id=>toolbar.indexOf('id="'+id+'"'));
assert(order.every(index=>index>=0)&&order.every((index,i)=>!i||index>order[i-1]),
 'the three projection/check buttons follow batch delete');
assert.equal((page.match(/id="multiStart"/g)||[]).length,1);
assert.equal((page.match(/id="multiStop"/g)||[]).length,1);
assert.match(page,/id="bulkConnect"/);
assert.match(page,/id="bulkDelete"/);
assert.match(page,/const managementSelected=new Set\(\)/);
assert.match(page,/managementCheck\.checked=managementSelected\.has\(d\.id\)/);
assert.match(page,/managementSelected\.clear\(\);render\(\)/,'auth change clears bulk selection');
assert.match(page,/candidates=picked\.filter\(d=>!\(multiView&&multiView\.isBusyFor\(d\.id\)\)\)/,'batch skips busy devices');
assert.match(page,/if\(!confirm\('将从列表永久删除以下 /,'batch deletion requires confirmation');
assert(page.includes("+'/connect',{method:'POST'}"),'batch connects via explicit existing endpoint');
assert(page.includes("encodeURIComponent(d.id),{method:'DELETE'}"),'batch deletes via existing endpoint');
assert.match(page,/action\(label\+'：'\+ip,\(\)=>switchRoute\(d\.id,route\),'address-target'\)/);
assert(page.includes("title.append(elem('span','device-port','ADB '+d.port))"),'shared port belongs to device title');
assert(!page.includes("primary.append(elem('div','common-adb-port'"),'no separate shared-port row');
assert(page.includes("addressList.append(...addressRows)"),'addresses use wrapping compact layout');
assert(page.includes("addressList.append(plus)"),'inline plus adds/edits temporary IP');
assert(page.includes("row.append(del)"),'temporary IP has its own close control');
assert(!page.includes("removeButton=action('删除'"),'no single-device delete control');
assert(!page.includes("const tempEdit=action("),'no duplicate temporary IP editor button');
assert.match(page,/if\(!confirm\('将从列表永久删除以下 '/,'batch deletion still asks for confirmation');
assert(page.includes("$('tempSharedPort').value=String(d.port)"),'temporary IP modal starts from shared port');
assert(page.includes('id="tempDialog"'),'temporary IP editor is a real dialog');
assert(page.includes("editingTemp=d.id"),'temporary IP dialog owns its selected device');
assert(page.includes("change.title='编辑 '+d.name"),'single-device edit is a card icon');
assert(!page.includes("const connect=action('连接'"),'no single-device connect button');
assert(page.includes("$('load').addEventListener('click',loadAndConnect)"),'explicit reload connects once');
assert(page.includes("if(current.selected_route!==route)"),'clicking current IP can reconnect without route mutation');
assert(page.includes("multiView.projectionButton(d)"),'projection control lives next to ADB port');
assert(!page.includes('临时 ADB 端口：'),'legacy temporary-only port is removed');
assert.match(page,/target\.setAttribute\('aria-pressed',String\(chosen\)\)/);
assert.doesNotMatch(page,/⇄ 切换|✓ 当前选择/,'the IP itself is the route control');
assert.match(page,/const name=elem\('span','item-name',d\.name\)/);
assert.match(page,/title\.append\(name\)/);
assert.match(page,/name\.append\(model\)/);
assert.match(page,/\.device-title:hover \.device-model-tooltip/);
assert.match(page,/\.device-title\{display:flex;[^\n]*position:relative/);
assert.doesNotMatch(page,/if\(d\.model\)title\.append\(elem\('span','device-model'/);
assert.match(page,/if\(d\.android_version\)title\.append\(elem\('span','device-android','Android '\+d\.android_version\)\)/);
assert.match(page,/\.device-title\{display:flex;align-items:center;flex-wrap:wrap/);
assert.doesNotMatch(page,/primary\.append\(elem\('div','muted','Android '\+d\.android_version\)\)/,'Android version is not repeated below the title');

assert.match(page,/top\.append\(managementLabel,info\);primary\.append\(top,addressList\)/);
assert.match(page,/row\.prepend\(adbStatusBadge\(d\)\)/);
assert.match(page,/\.device-quality \.adb-badge\{justify-self:start;margin-left:0\}/);
assert.doesNotMatch(page,/primary\.append\(elem\('div','muted','ADB 已连接：'/,
 'success address is in the header badge, not repeated below it');
assert.match(page,/\.adb-badge\.connected\{background:#183e31/,'green successful ADB');
assert.match(page,/\.adb-badge\.failed\{background:#49252e/,'red failed ADB');
const badgeStart=page.indexOf('function adbStatusBadge(d){'),
 badgeEnd=page.indexOf('\nconst toastHost=',badgeStart);
assert(badgeStart>=0&&badgeEnd>badgeStart,'a standalone session-status renderer exists');
const make=(tag,cls,value)=>{
 const el=new El(tag);el.className=cls;el.textContent=value===undefined?'':value;return el;
};
const makeBadge=vm.runInNewContext('('+page.slice(badgeStart,badgeEnd)+')',{elem:make});
const successBadge=makeBadge({status:'connected',active_serial:'10.10.10.2:5555',
 selected_serial:'192.168.1.2:5555',connect_failed:false});
assert.match(successBadge.className,/connected/);
assert.equal(successBadge.children[0].textContent,'ADB 已连接');
assert.equal(successBadge.children[1].textContent,'10.10.10.2:5555',
 'show actually connected ADB address rather than another selected route');
const errorBadge=makeBadge({status:'disconnected',active_serial:null,
 selected_serial:'192.168.1.2:5555',connect_failed:true});
assert.match(errorBadge.className,/failed/);
assert.equal(errorBadge.children[0].textContent,'ADB 连接失败');
assert.equal(errorBadge.children[1].textContent,'192.168.1.2:5555');
const idleBadge=makeBadge({status:'disconnected',
 selected_serial:'192.168.1.2:5555',connect_failed:false});
assert.doesNotMatch(idleBadge.className,/failed|connected/,'not-yet-connected is neutral');
assert.equal(idleBadge.children.length,1,'idle must not claim a live ADB address');
const checkingBadge=makeBadge({status:'checking',selected_serial:'10.10.10.2:5555',
 connect_failed:true});
assert.match(checkingBadge.className,/checking/,'ongoing check must not show stale red error');


const devices=[1,2,3,4,5].map(n=>({id:'id-'+n,name:'Phone '+n,status:'connected',
 selected_serial:'10.10.0.'+n+':5555',active_serial:'10.10.0.'+n+':5555'}));
const picker=new El('div'),grid=new El('div'),startButton=new El('button'),stopButton=new El('button'),info=new El('div');
const calls=[],batchSelected=new Set(),drawerEvents=[];
const multi=root.EasyADBMulti.create({picker,grid,startButton,stopButton,info,
 getDevices:()=>devices,getToken:()=> 'token-test',
 onChange(){},
 onProjectionStarted:()=>drawerEvents.push('collapsed'),
 onOpenManagement:()=>drawerEvents.push('opened'),
 getBatchSelection:()=>batchSelected,onBatchSelectionRemove:id=>batchSelected.delete(id),
 runPreflight:async id=>{calls.push(['preflight',id]);return{selected_serial:'checked-'+id,model:'Test',android_sdk:35,cpu_abi:'arm64',display_size:'1080x2400'};},
 runVideoProbe:async(id,p)=>{calls.push(['probe',id,p]);return{codec:'H.264',encoded_width:720,
  encoded_height:1280,media_packets:3,key_frames:1,sample_bytes:1024,elapsed_ms:150};}
});
const quality=(i,key)=>picker.children[i].children[0].children[
 ({max_size:0,video_bit_rate:1,max_fps:2,dpi:3})[key]].children[0];
const playback=i=>picker.children[i].children.find(x=>x.className==='multi-playback-options');
const liveButton=i=>multi.projectionButton(devices[i]);
const liveStatus=i=>multi.liveState(devices[i].id).label;
assert.equal(picker.children[0].children.some(node=>node.className==='multi-live'),false,
 'duplicate projection status/action row must be removed');
function select(i){batchSelected.add(devices[i].id);multi.updatePicker();}
function init(ws,sid){
 ws.emit('init',{session_id:sid,width:720,height:1280,
  mime:'video/mp4; codecs="avc1.640028"',format:'fmp4',control_available:true,
  requested:{max_size:960,video_bit_rate:3000000,max_fps:24}});
}
assert.equal(root.EasyADBMulti.MAX_DEVICES,4);
assert.equal(sockets.length,0);
assert.equal(startButton.disabled,true,'empty selection cannot start');
assert.equal(picker.children[0].children.some(x=>x.className==='multi-choice-label'),false,'no duplicate projection checkbox');
assert.match(liveStatus(0),/未开启/);
assert.equal(liveButton(0).disabled,false);
assert.match(liveStatus(1),/未开启/);
select(0);
assert.equal(startButton.disabled,false,'ONE selected device is enough');
assert.match(startButton.textContent,/待新增 1/);
// Neither the select-all control nor devices with failed/disconnected ADB
// may inflate the stream count.
batchSelected.add('bulkSelectAll');
batchSelected.add('id-2');batchSelected.add('id-3');
devices[1].status='disconnected';devices[1].active_serial=null;
devices[2].status='error';devices[2].connect_failed=true;devices[2].active_serial=null;
multi.updatePicker();
assert.match(startButton.textContent,/待新增 1 台/,'exclude select-all and unavailable ADB');
assert.equal(startButton.disabled,false,'one ready device is launchable');
batchSelected.delete('bulkSelectAll');batchSelected.delete('id-2');batchSelected.delete('id-3');
devices[1].status='connected';devices[1].active_serial=devices[1].selected_serial;
devices[2].status='connected';devices[2].connect_failed=false;devices[2].active_serial=devices[2].selected_serial;
multi.updatePicker();
assert.match(startButton.textContent,/待新增 1 台/);
assert.equal(batchSelected.has('id-2'),false);
assert.equal(multi.getChoice('id-1').profile,'custom');
const resolutionGroup=quality(0,'max_size').children.at(-1);
assert.equal(resolutionGroup.tagName,'optgroup');
assert.equal(resolutionGroup.label,'实验性分辨率');
assert.deepEqual(resolutionGroup.children.map(x=>x.value),[
 'exp:2560x1440','exp:1920x1440','exp:1920x1200','exp:1920x1080',
 'exp:1680x1050','exp:1600x1200','exp:1600x1024','exp:1600x900',
 'exp:1440x1080','exp:1440x900','exp:1366x768'
]);
assert.equal(quality(0,'max_size').value,'960');
const normalDpi=quality(0,'dpi');normalDpi.value='320';normalDpi.fire('change');
assert.equal(multi.getChoice('id-1').dpi,320,'normal mode remembers DPI but does not alter Android');
assert.equal(multi.getChoice('id-2').dpi,240);
const defaultDpi=quality(0,'dpi');defaultDpi.value='240';defaultDpi.fire('change');
assert.equal(quality(0,'video_bit_rate').value,'3000000');
assert.equal(quality(0,'max_fps').value,'24');
assert.equal(quality(0,'dpi').value,'240');
assert.equal(quality(0,'dpi').disabled,false,'DPI preference can be selected in normal mode');
assert.equal(quality(1,'max_size').value,'960');
assert.equal(quality(1,'video_bit_rate').value,'3000000');
assert.equal(quality(1,'max_fps').value,'24');
assert.equal(picker.children[0].children[1].hidden,true,'hide probe actions only');
assert.equal(picker.children[0].children[2].hidden,true,'hide probe log only');
assert.match(page,/\.multi-choice>\.buttons\[hidden\],\.multi-choice>\.multi-probe-log\[hidden\]/);
assert.equal(playback(0).open,false,'playback experiments are folded by default');
const latency0=playback(0).children[2].children[0];
assert.equal(latency0.checked,true,'low latency defaults enabled for every device');
assert.equal(multi.getChoice('id-2').low_latency,true,'B retains its own default');
const panel0=playback(0).children[1].children[0];
assert.equal(panel0.checked,false,'physical display remains on by default');
assert.equal(multi.getChoice('id-2').screen_off,false,'another phone remains independent');
panel0.checked=true;panel0.fire('change');
assert.equal(multi.getChoice('id-1').screen_off,true);
assert.equal(multi.getChoice('id-2').screen_off,false);
assert.match(page,/fab-up-wake/);
assert.match(page,/fab-up-reconnect/);
latency0.checked=false;latency0.fire('change');
assert.equal(multi.getChoice('id-1').low_latency,false,'A can opt out independently');
assert.equal(multi.getChoice('id-2').low_latency,true,'A opting out does not alter B');
latency0.checked=true;latency0.fire('change');
assert.equal(multi.getChoice('id-1').low_latency,true);
// The three fields can be changed independently, per device, including 3 Mbps.
const setQuality=(i,key,value)=>{
 const field=quality(i,key);field.value=String(value);field.fire('change');
};
setQuality(0,'video_bit_rate',20000000);
assert.equal(multi.getChoice('id-1').video_bit_rate,20000000);
assert.equal(multi.getChoice('id-1').max_size,960);
assert.equal(multi.getChoice('id-1').max_fps,24);
setQuality(0,'max_size',1280);
setQuality(0,'max_fps',60);
assert.equal(multi.getChoice('id-1').max_size,1280);
assert.equal(multi.getChoice('id-1').max_fps,60);
assert.equal(multi.getChoice('id-2').video_bit_rate,3000000,'device B remains at default');
assert.equal(multi.getChoice('id-2').max_size,960);
assert.equal(multi.getChoice('id-2').max_fps,24);
// one selected must create ONLY its own WS with exact per-device quality.
startButton.fire('click');assert.equal(sockets.length,1);
assert.equal(drawerEvents.at(-1),'collapsed','batch projection collapses management');
const a=sockets[0];a.open();const pa=JSON.parse(a.sent[0]);
assert.equal(pa.profile,'custom');
assert.equal(pa.quality.video_bit_rate,20000000);
assert.equal(pa.quality.max_size,1280);
assert.equal(pa.quality.max_fps,60);
assert.equal(pa.selected_serial,devices[0].selected_serial);
assert.equal(pa.screen_off,true,'single-device choice is pinned in handshake');
assert.equal(multi.cards.size,1);
assert.equal(grid.children.length,1);
a.emit('starting',{session_id:'only-one'});
assert.equal(sockets.length,1);
const early=multi.cards.get('id-1');
assert.equal(early.wakeButton.disabled,false,'wake must work before first media frame');
early.wakeButton.fire('click');
assert.equal(JSON.parse(a.sent.at(-1)).type,'wake');
assert.equal(JSON.parse(a.sent.at(-1)).session_id,'only-one');
a.emit('wake_accepted',{session_id:'only-one',message:'WAKEUP dispatched'});
assert.equal(early.wakePending,false);
init(a,'only-one');
const ca=multi.cards.get('id-1');
assert.equal(quality(0,'max_size').disabled,true,'no hot switching while streaming');
assert.equal(quality(0,'video_bit_rate').disabled,true);
assert.equal(quality(0,'max_fps').disabled,true);
assert.equal(ca.toggle.disabled,false,'control independent of video playing');
assert.equal(ca.quality.profile,'custom');
assert.equal(ca.lowLatency,true,'local player setting is pinned to device A only');
assert.equal(ca.fullscreenButton.title,'全屏展示');
assert.equal(ca.fullscreenButton.disabled,false);
assert.equal(fullscreenEvents.size,1,'fullscreen observer is session-owned');
ca.main.fire('click');ca.fullscreenButton.fire('click');
assert.equal(root.document.fullscreenElement,ca.screen,'only this card video becomes fullscreen');
assert.equal(ca.fullscreenButton['aria-pressed'],'true');
assert.equal(ca.fullscreenButton.title,'退出全屏（Esc）');
assert.notEqual(ca.fab.hidden,true,'video controls remain in fullscreen');
assert.match(page,/\.multi-screen:fullscreen \.multi-fab\{right:14px;top:50%;transform:translateY\(-50%\);z-index:20;visibility:visible\}/);
assert.match(page,/\.multi-screen:fullscreen \.multi-fab \.fab-main\{visibility:visible;opacity:1;pointer-events:auto\}/);
// Browser Esc invokes native exitFullscreen -> fullscreenchange, no global key capture.
root.document.exitFullscreen();
assert.equal(root.document.fullscreenElement,null);
assert.equal(ca.fullscreenButton['aria-pressed'],'false');
assert.equal(ca.fullscreenButton.title,'全屏展示');
ca.fullscreenButton.fire('click');
assert.equal(root.document.fullscreenElement,ca.screen);
root.document.exitFullscreen();
ca.main.fire('click');
assert.match(ca.qualityLine.textContent,/自定义/);
assert.equal(ca.screen.style.aspectRatio,'720 / 1280');
assert.equal(ca.screen.style.width,'100%');
assert.equal(ca.box.style.width,'746px','card follows source width plus 26px of padding and borders');
ca.fitScreen(1280,720);
assert.equal(ca.screen.style.aspectRatio,'1280 / 720','landscape card keeps source aspect');
assert.equal(ca.screen['data-orientation'],'landscape');
assert.equal(ca.box.style.width,'1306px','landscape source width sets independent card width');
ca.fitScreen(393,873);
assert.equal(ca.box.style.width,'419px','narrow stream sets its own width');
assert.equal(ca.screen.style.aspectRatio,'393 / 873');
assert.equal(ca.screen['data-orientation'],'portrait');
ca.fitScreen(720,1280);
assert.equal(ca.logPanel.hidden,true,'diagnostics start hidden inside video');
assert.equal(ca.menuOpen,false);
assert.equal(ca.nav.slice(0,3).every(b=>b.hidden),true,'navigation hidden before remote control');
ca.main.fire('click');assert.equal(ca.main['aria-expanded'],'true');
assert.equal(ca.menuOpen,true);
ca.main.fire('click');assert.equal(ca.menuOpen,false,'second tap collapses menu');
ca.main.fire('click');advanceMenuTimers();
assert.equal(ca.menuOpen,false,'menu auto folds at five seconds');
assert.equal(ca.main['aria-expanded'],'false');
ca.main.fire('click');ca.logButton.fire('click');
assert.equal(ca.logPanel.hidden,false,'upward log action opens overlay');
assert.equal(ca.menuOpen,false,'opening log folds floating menu');
ca.logClose.fire('click');assert.equal(ca.logPanel.hidden,true,'log panel closes independently');
a.emit('diagnostic',{session_id:'only-one',adb_check_ms:23,stage:'streaming',phone_packets:9,
 mux_chunks:4,media_fragments:3,elapsed_ms:1500,proc_cpu_pct:5,proc_rss_mib:20,ws_video_bytes:1000});
assert.match(ca.diagnostic.textContent,/手机编码包 9/);
assert.match(ca.diagnostic.textContent,/完整分片 3/);
assert.equal(JSON.parse(a.sent.at(-1)).session_id,'only-one');
ca.main.fire('click');
ca.toggle.fire('click');a.emit('control_enabled',{session_id:'only-one'});
assert.equal(ca.enabled,true);
assert.equal(ca.nav.slice(0,3).every(b=>!b.hidden&&!b.disabled),true,
 'downward back/home/recents appear only after remote enabled');
ca.textButton.fire('click');
assert.equal(ca.form.hidden,false,'left keyboard action reveals text, send, enter and backspace');
assert.equal(ca.nav[3].disabled,false);assert.equal(ca.nav[4].disabled,false);
ca.nav[0].fire('click');assert.equal(JSON.parse(a.sent.at(-1)).key,'back');
a.emit('input_accepted',{session_id:'only-one'});
ca.nav[3].fire('click');assert.equal(JSON.parse(a.sent.at(-1)).key,'enter');
a.emit('input_accepted',{session_id:'only-one'});
ca.nav[4].fire('click');assert.equal(JSON.parse(a.sent.at(-1)).key,'backspace');
a.emit('input_accepted',{session_id:'only-one'});
ca.textClose.fire('click');assert.equal(ca.form.hidden,true);
ca.stop.fire('click');assert.equal(a.sent.at(-1),'stop');
a.emit('ended',{session_id:'only-one',cleanup_complete:true});
assert.equal(multi.hasActive(),false);
assert.equal(fullscreenEvents.size,0,'teardown removes the fullscreen observer');
assert.equal(timers.size,0,'teardown clears floating menu timer');
assert.equal(grid.children.length,0,'terminal session must REMOVE its old video DOM card');
assert.equal(batchSelected.has('id-1'),true,'left-side selection survives clean stop');
assert.match(ca.historyEl.textContent,/最近画质/);
// selection is available again, no automatic start and no all-selected rule.
assert.equal(sockets.length,1);
setQuality(1,'video_bit_rate',18000000);
setQuality(1,'max_fps',45);
assert.equal(multi.getChoice('id-2').max_fps,45,'45 FPS independent selection');
setQuality(1,'max_fps',55);
assert.equal(multi.getChoice('id-1').video_bit_rate,20000000);
assert.equal(multi.getChoice('id-1').max_fps,60);
select(0);select(1);
assert.equal(startButton.disabled,false);
startButton.fire('click');assert.equal(sockets.length,3,'both selected sessions open before either phone initializes');
const b=sockets[1],c=sockets[2];
assert.equal(multi.cards.size,2,'all batch cards reserved immediately');
b.open();assert.equal(JSON.parse(b.sent[0]).profile,'custom');
b.emit('starting',{session_id:'second-a'});
assert.equal(sockets.length,3,'neither phone waits for the other first frame');
c.open();
assert.equal(JSON.parse(c.sent[0]).profile,'custom');
assert.equal(JSON.parse(c.sent[0]).quality.video_bit_rate,18000000);
assert.equal(JSON.parse(c.sent[0]).quality.max_fps,55);
assert.equal(JSON.parse(c.sent[0]).quality.max_size,960);
c.emit('starting',{session_id:'second-b'});init(c,'second-b');
init(b,'second-a'); // slower A may initialize AFTER B without blocking it
const cb=multi.cards.get('id-1'),cc=multi.cards.get('id-2');
assert.equal(cc.toggle.disabled,false);
cb.toggle.fire('click');b.emit('control_enabled',{session_id:'second-a'});
cc.toggle.fire('click');c.emit('touch_error',{session_id:'second-b',message:'not ready'});
assert.equal(cc.pending,false);assert.equal(cc.toggle.disabled,false);
cc.toggle.fire('click');c.emit('control_enabled',{session_id:'second-b'});
assert.equal(cc.enabled,true);
cb.input.value='Hello';cb.form.fire('submit');
assert.equal(JSON.parse(b.sent.at(-1)).text,'Hello');
assert.equal(c.sent.filter(x=>x.includes('"text":"Hello"')).length,0);
c.emit('diagnostic',{session_id:'second-b',phone_packets:5,mux_chunks:2,media_fragments:1,stage:'streaming'});
assert.equal(JSON.parse(c.sent.at(-1)).session_id,'second-b');
c.emit('diagnostic',{session_id:'second-b',stage:'streaming',
 control_warning:'android_input_permission'});
assert.equal(cc.permissionWarningShown,true);
assert.equal(cc.enabled,false,'Android denial disables only this device control');
assert.equal(cc.nav.slice(0,3).every(b=>b.hidden),true,'input denial hides nav');
assert.equal(cc.form.hidden,true,'input denial closes text entry');
assert.equal(cc.toggle.disabled,true,'do not imply refused Android input still works');
assert(c.sent.some(msg=>msg.includes('"type":"control_disable"')));
c.emit('control_disabled',{session_id:'second-b'});
assert.match(cc.keyStatus.textContent,/INJECT_EVENTS/,'do not overwrite permission explanation');
assert.equal(cb.enabled,true,'other device is unaffected');
assert.equal(grid.children.length,2,'two selected devices create exactly two visible cards');
// BUG regression: stop all, wait for actual cleanup acknowledgments, then
// start the same selection again. No old window may remain behind.
multi.stopAll();
assert.equal(b.sent.at(-1),'stop');assert.equal(c.sent.at(-1),'stop');
assert.equal(multi.stopBatch.total,2,'batch stop dispatches both WS before first ack');
c.emit('ended',{session_id:'second-b',cleanup_complete:true});
assert.equal(multi.stopBatch.pending.has('id-1'),true,'slow A cannot block C cleanup');
assert.equal(multi.cards.get('id-1').state,'stopping');
b.emit('ended',{session_id:'second-a',cleanup_complete:true});
assert.equal(multi.stopBatch,null,'independent acknowledgements settle progress');
assert.equal(grid.children.length,0,'stop-all must clear ALL old windows');
assert.equal(multi.cards.size,0);
assert.equal(batchSelected.size,2,'selection is retained but restart remains manual');
assert.equal(startButton.disabled,false);
startButton.fire('click');
assert.equal(grid.children.length,2,'parallel restart reserves two NEW cards immediately');
assert.equal(sockets.length,5);
const d=sockets[3],e=sockets[4];
e.open();e.emit('starting',{session_id:'restart-b'});init(e,'restart-b');
assert.equal(multi.cards.get('id-1').state,'connecting','slow peer A must not block B');
d.open();d.emit('starting',{session_id:'restart-a'});init(d,'restart-a');
assert.equal(grid.children.length,2,'no stale/duplicate windows after second init');
multi.stopAll();
d.emit('ended',{session_id:'restart-a',cleanup_complete:true});
e.emit('ended',{session_id:'restart-b',cleanup_complete:true});
assert.equal(grid.children.length,0);
assert.equal(multi.cards.size,0);
// preflight and probe on a chosen device are independent and explicit.
multi.closeAll();assert.equal(multi.cards.size,0);
const preButton=picker.children[1].children[1].children[0];
async function waitForCheck(id){
 // Each explicit check updates the picker asynchronously; don't test a stale
 // detached button while the previous request still has checking=true.
 for(let i=0;i<16&&multi.checking.has(id);i++)await Promise.resolve();
 assert.equal(multi.checking.has(id),false,'device check must settle before next click');
}
(async()=>{
 preButton.fire('click');
 await waitForCheck('id-2');
 assert.equal(calls[0][0],'preflight');
 assert.equal(calls[0][1],'id-2');
 assert.match(multi.probeResults.get('id-2'),/M2 能力预检/);
 // updatePicker() replaces the DOM; choose the button on the CURRENT card.
 const probeButton=picker.children[1].children[1].children[1];
 assert.equal(probeButton.disabled,false);
 probeButton.fire('click');
 await waitForCheck('id-2');
 assert.equal(calls[1][0],'probe');
 assert.equal(calls[1][1],'id-2');
 assert.match(multi.probeResults.get('id-2'),/视频实验/);
 assert.match(multi.probeResults.get('id-2'),/M2 能力预检/,'probe retains earlier log');
 assert.equal(multi.probeResults.has('id-1'),false,'device logs stay isolated');
 for(let i=0;i<4;i++)select(i);
 select(4);assert.equal(startButton.disabled,true,'five selected streams exceed four slots');
 batchSelected.delete(devices[4].id);multi.updatePicker();
 assert.equal(startButton.disabled,false);
 // A live device must NOT impose a whole-page lock. Start one, add another
 // logical device to the loaded list, then append it without touching A.
 batchSelected.clear();multi.updatePicker();
 select(0);startButton.fire('click');
 const liveA=sockets.at(-1);liveA.open();liveA.emit('starting',{session_id:'append-A'});
 init(liveA,'append-A');
 const liveCardA=multi.cards.get('id-1'),originalPlayer=liveCardA.player;
 liveCardA.toggle.fire('click');liveA.emit('control_enabled',{session_id:'append-A'});
 assert.equal(liveCardA.enabled,true);
 assert.equal(startButton.disabled,true,'no new selected device: do not restart A');
 const socketCount=sockets.length;multi.start();
 assert.equal(sockets.length,socketCount,'start with existing-only selection is inert');
 // Simulate POST /api/devices followed by load(true) without closing A.
 devices.push({id:'id-6',name:'Phone 6',status:'connected',
  selected_serial:'10.10.0.6:5555',active_serial:'10.10.0.6:5555'});
 multi.updatePicker();
 assert.equal(multi.isBusyFor('id-1'),true,'active A cannot restart mid-stream');
 assert.equal(multi.cards.size<4,true,'new device can be selected while A runs');
 select(5);
 assert.equal(startButton.disabled,false);
 assert.match(startButton.textContent,/追加投屏/);
 startButton.fire('click');
 assert.equal(sockets.length,socketCount+1,'append opens exactly ONE new WS');
 const liveF=sockets.at(-1);liveF.open();
 assert.equal(JSON.parse(liveF.sent[0]).selected_serial,devices[5].selected_serial);
 liveF.emit('starting',{session_id:'append-F'});init(liveF,'append-F');
 assert.equal(multi.cards.size,2);
 assert.equal(grid.children.length,2);
 assert.equal(multi.cards.get('id-1'),liveCardA,'existing A card identity never changes');
 assert.equal(liveCardA.player,originalPlayer,'existing A MSE never reinitializes');
 assert.equal(liveCardA.enabled,true,'append preserves existing remote control');
 assert.equal(liveA.readyState,WS.OPEN,'existing WS was not closed');
 assert.equal(liveA.sent.filter(x=>x.includes('"type":"control_disable"')).length,0);
 // Appending B+C opens both simultaneously, without changing A/F sessions.
 select(1);select(2);
 const appendIndex=sockets.length;startButton.fire('click');
 assert.equal(sockets.length,appendIndex+2,'both append WS opened without waiting for init');
 assert.equal(multi.cards.size,4,'all four server slots are immediately reserved');
 const liveB=sockets[appendIndex],liveC=sockets[appendIndex+1];
 liveC.open();liveC.emit('starting',{session_id:'append-C'});init(liveC,'append-C');
 liveB.open();liveB.emit('starting',{session_id:'append-B'});init(liveB,'append-B');
 assert.equal(multi.cards.size,4);
 assert.equal(grid.children.length,4);
 assert.equal(multi.cards.size,4,'fifth concurrent device unavailable');
 assert.equal(liveButton(4).disabled,true,'no per-device fifth stream when pool is full');
 assert.equal(startButton.disabled,true,'full four-slot pool');
 multi.start();assert.equal(multi.cards.size,4,'cannot duplicate any running card');
 // A single confirmed stop frees ONE slot; the three others remain intact.
 multi.stopFor('id-6');assert.equal(liveF.sent.at(-1),'stop');
 liveF.emit('ended',{session_id:'append-F',cleanup_complete:true});
 assert.equal(multi.cards.size,3);
 assert.equal(multi.cards.get('id-1'),liveCardA);
 assert.equal(batchSelected.has('id-6'),false,
  'single stop unchecks F so a later append never silently restarts F');
 select(3);assert.equal(startButton.disabled,false);
 startButton.fire('click');
 const liveD=sockets.at(-1);liveD.open();liveD.emit('starting',{session_id:'append-D'});
 init(liveD,'append-D');
 assert.equal(multi.cards.size,4);
 assert.equal(multi.cards.get('id-1'),liveCardA);
 assert.equal(grid.children.length,4);
 multi.stopAll();
 for(const [ws,sid] of [[liveA,'append-A'],[liveB,'append-B'],[liveC,'append-C'],[liveD,'append-D']])
  ws.emit('ended',{session_id:sid,cleanup_complete:true});
 assert.equal(multi.cards.size,0);
 assert.equal(grid.children.length,0,'full stop removes every owned live DOM card');
 assert.equal(sockets.length,socketCount+4,'only four additional sessions ever created');
 // Per-device buttons target ONLY their own session, never the batch's other
 // checked devices and never an already-running WS or MSE player.
 batchSelected.clear();multi.updatePicker();
 const aloneCount=sockets.length;
 liveButton(0).fire('click');
 assert.equal(sockets.length,aloneCount+1,'one row starts exactly its own stream');
 assert.equal(multi.cards.size,1);
 assert.equal(batchSelected.has('id-1'),false,'independent row start does not alter bulk selection');
 assert.match(liveStatus(0),/启动中/);
 assert.match(liveStatus(1),/未开启|已停止/);
 assert.match(liveButton(0).title,/关闭此设备投屏/);
 assert.match(liveButton(0).className,/starting/);
 const ownA=sockets.at(-1);ownA.open();ownA.emit('starting',{session_id:'own-A'});
 init(ownA,'own-A');assert.match(liveStatus(0),/等待画面/);
 multi.cards.get('id-1').player.triggerPlaying();
 assert.match(liveStatus(0),/播放中/);
 const ownACard=multi.cards.get('id-1'),ownAPlayer=ownACard.player;
 liveButton(1).fire('click');
 assert.equal(sockets.length,aloneCount+2,'row B starts without restarting A');
 assert.equal(multi.cards.get('id-1'),ownACard);
 assert.equal(multi.cards.get('id-1').player,ownAPlayer);
 const ownB=sockets.at(-1);ownB.open();ownB.emit('starting',{session_id:'own-B'});init(ownB,'own-B');
 assert.equal(multi.cards.size,2);
 liveButton(0).fire('click');
 assert.equal(ownA.sent.at(-1),'stop');
 assert.match(liveStatus(0),/停止中/);
 assert.equal(liveButton(0).disabled,true,'do not create another stream before confirmed cleanup');
 assert.equal(multi.cards.get('id-2').closed,false);
 assert.equal(ownB.sent.filter(x=>x==='stop').length,0,'row A stop cannot stop B');
 ownA.emit('ended',{session_id:'own-A',cleanup_complete:true});
 assert.equal(multi.cards.size,1);
 assert.match(liveStatus(0),/已停止/);
 assert.equal(liveButton(0).disabled,false);
 const restartCount=sockets.length;
 liveButton(0).fire('click');
 assert.equal(sockets.length,restartCount+1,'row A may restart after confirmed cleanup');
 const ownARestart=sockets.at(-1);ownARestart.open();
 ownARestart.emit('starting',{session_id:'own-A2'});init(ownARestart,'own-A2');
 assert.equal(multi.cards.size,2);
 assert.equal(multi.cards.get('id-2').closed,false);
 multi.stopAll();
 ownB.emit('ended',{session_id:'own-B',cleanup_complete:true});
 ownARestart.emit('ended',{session_id:'own-A2',cleanup_complete:true});
 assert.equal(grid.children.length,0);
 // Parallel start has no waiting queue: stopping D must not affect C.
 batchSelected.clear();multi.updatePicker();select(2);select(3);
 const queueCount=sockets.length;startButton.fire('click');
 assert.equal(sockets.length,queueCount+2,'C and D both start, no queued device');
 const ownC=sockets[queueCount],ownD=sockets[queueCount+1];
 assert.match(liveStatus(3),/启动中/);
 ownD.open();ownD.emit('starting',{session_id:'own-D'});
 liveButton(3).fire('click');assert.equal(ownD.sent.at(-1),'stop');
 assert.match(liveStatus(3),/停止中/);
 assert.equal(multi.cards.get('id-3').closed,false,'D stop cannot cancel C');
 ownC.open();ownC.emit('starting',{session_id:'own-C'});init(ownC,'own-C');
 ownD.emit('ended',{session_id:'own-D',cleanup_complete:true});
 assert.equal(multi.cards.size,1,'D acknowledgement leaves C running');
 multi.stopAll();ownC.emit('ended',{session_id:'own-C',cleanup_complete:true});
 assert.equal(grid.children.length,0);
 // The batch stop button must only stop selected devices, not all live cards.
 batchSelected.clear();multi.updatePicker();
 liveButton(0).fire('click');
 const batchA=sockets.at(-1);batchA.open();batchA.emit('starting',{session_id:'batch-A'});init(batchA,'batch-A');
 liveButton(1).fire('click');
 const batchB=sockets.at(-1);batchB.open();batchB.emit('starting',{session_id:'batch-B'});init(batchB,'batch-B');
 assert.equal(multi.cards.size,2);
 assert.equal(stopButton.disabled,true,'no selected live devices => batch stop disabled');
 batchSelected.add('id-2');multi.updatePicker();
 assert.equal(stopButton.disabled,false);
 assert.match(stopButton.textContent,/批量停止投屏（1 台）/);
 stopButton.fire('click');
 assert.equal(batchB.sent.at(-1),'stop');
 assert.equal(batchA.sent.filter(x=>x==='stop').length,0,'unselected live A stays untouched');
 batchB.emit('ended',{session_id:'batch-B',cleanup_complete:true});
 assert.equal(multi.cards.size,1);
 assert.equal(multi.cards.get('id-1').closed,false);
 batchSelected.add('id-1');multi.updatePicker();
 stopButton.fire('click');
 assert.equal(batchA.sent.at(-1),'stop');
 batchA.emit('ended',{session_id:'batch-A',cleanup_complete:true});
 assert.equal(grid.children.length,0);
 // Explicit one-shot reconnect: must wait for acknowledged cleanup, preserve B,
 // target the same serial and frozen quality/screen-off without adb connect.
 batchSelected.clear();multi.updatePicker();
 const base=sockets.length;
 liveButton(0).fire('click');
 const reboot=sockets.at(-1);reboot.open();reboot.emit('starting',{session_id:'user-restart'});
 init(reboot,'user-restart');
 const oldCard=multi.cards.get('id-1');
 assert.equal(oldCard.reconnectButton.disabled,false);
 liveButton(1).fire('click');
 const peer=sockets.at(-1);peer.open();peer.emit('starting',{session_id:'peer'});init(peer,'peer');
 const peerCard=multi.cards.get('id-2'),peerSocket=peer;
 const beforeReconnect=sockets.length;
 oldCard.reconnectButton.fire('click');
 assert.equal(reboot.sent.at(-1),'stop');
 assert.equal(sockets.length,beforeReconnect,'must not create a duplicate before cleanup ack');
 assert.equal(oldCard.reconnectButton.disabled,true,'only one click accepted');
 reboot.emit('ended',{session_id:'user-restart',cleanup_complete:true});
 assert.equal(sockets.length,beforeReconnect+1,'one new session only after cleanup ack');
 const newSocket=sockets.at(-1);newSocket.open();
 const newRequest=JSON.parse(newSocket.sent[0]);
 assert.equal(newRequest.selected_serial,devices[0].selected_serial);
 assert.equal(newRequest.screen_off,true);
 assert.equal(multi.cards.get('id-2'),peerCard);
 assert.equal(peerCard.ws,peerSocket);
 assert.equal(peerSocket.sent.includes('stop'),false,'peer session was not interrupted');
 newSocket.emit('starting',{session_id:'restarted'});init(newSocket,'restarted');
 assert.equal(multi.cards.size,2);
 multi.stopAll();
 peer.emit('ended',{session_id:'peer',cleanup_complete:true});
 newSocket.emit('ended',{session_id:'restarted',cleanup_complete:true});
 assert.equal(multi.cards.size,0);
 // Failure/unclean cleanup must not silently restart.
 liveButton(0).fire('click');
 const failed=sockets.at(-1);failed.open();failed.emit('starting',{session_id:'fail-restart'});init(failed,'fail-restart');
 const failedCard=multi.cards.get('id-1');
 failedCard.reconnectButton.fire('click');
 const countOnFailure=sockets.length;
 failed.emit('ended',{session_id:'fail-restart',cleanup_complete:false});
 assert.equal(sockets.length,countOnFailure,'dirty cleanup may not open replacement');
 assert.equal(multi.cards.size,0);
 assert.equal(sockets.length>=base+3,true);

 // Real WebRTC stop regression: hiding a black screen/FAB must not depend on
 // an indefinite server wait, but timeout cannot claim cleanup or reconnect.
 root.EasyADBWebRTC={create:(_video,cbs)=>({
  async start(){},initialize(){cbs.onState('ready');},
  diagnostics(){return{queueBytes:0,sourceState:'connected',sourceRanges:0,
   rangeEnd:null,currentTime:0,queueChunks:0,appendCalls:0,completedUpdates:0,
   videoError:null,webrtcBytes:0,webrtcFrames:0};},
  pollStats(){},resume(){},destroy(){this.destroyed=true;}
 })};
 multi.videoEngine='webrtc';multi.engineReady=true;multi.engineSupported=true;
 batchSelected.clear();multi.updatePicker();
 const webrtcCount=sockets.length;
 liveButton(0).fire('click');
 const rtcWS=sockets.at(-1);rtcWS.open();
 assert.equal(JSON.parse(rtcWS.sent[0]).player,'webrtc');
 rtcWS.emit('starting',{session_id:'webrtc-stop'});
 init(rtcWS,'webrtc-stop');
 const rtcCard=multi.cards.get('id-1');
 rtcCard.main.fire('click');
 rtcCard.stop.fire('click');
 assert.equal(rtcWS.sent.at(-1),'stop');
 assert.equal(rtcCard.fab.hidden,true,'stop immediately hides floating controls');
 assert.equal(rtcCard.logPanel.hidden,true,'stop hides diagnostic overlay');
 assert.equal(rtcCard.closed,false,'do not claim cleanup on stop request');
 assert([...timers.values()].some(t=>t.ms===40000),'WebRTC stop has bounded no-ack wait');
 advanceStopTimers(); // server never acknowledged cleanup: no indefinite black card
 assert.equal(rtcCard.closed,true);
 assert.equal(multi.cards.size,0);
 assert.equal(grid.children.length,0);
 assert.equal(sockets.length,webrtcCount+1,'a timeout must NOT auto-reconnect');
 assert.equal(multi.lastLiveStatus.get('id-1'),'异常结束',
  'timeout must NOT report cleanup_complete or falsely mark clean stop');
 assert.match(info.textContent,/资源已释放|资源未释放|资源未确认释放/);
 assert.equal(timers.size,0,'teardown cancels WebRTC stop timeout');
 const resolution=quality(0,'max_size');
 resolution.value='exp:1920x1080';resolution.fire('change');
 assert.equal(multi.getChoice('id-1').experimental_resolution,'1920x1080');
 assert.equal(multi.getChoice('id-1').screen_off,false);
 assert.equal(quality(0,'max_size').value,'exp:1920x1080');
 assert.equal(playback(0).children[1].children[0].disabled,true);
 assert.equal(quality(0,'dpi').disabled,false,'virtual resolution enables DPI');
 const virtualDpi=quality(0,'dpi');virtualDpi.value='360';virtualDpi.fire('change');
 assert.equal(multi.getChoice('id-1').dpi,360);
 assert.equal(multi.getChoice('id-2').dpi,240);
 assert.equal(multi.getChoice('id-2').experimental_resolution,null);
 multi.videoEngine='mse';
 const experimentalSocketCount=sockets.length;
 assert.equal(multi.startFor('id-1'),true);
 assert.equal(drawerEvents.at(-1),'collapsed','single device projection collapses management');
 assert.equal(sockets.length,experimentalSocketCount+1);
 const virtual=sockets.at(-1);virtual.open();
 const request=JSON.parse(virtual.sent[0]);
 assert.equal(request.profile,'custom');
 assert.equal(request.quality.max_size,0);
 assert.equal(request.display_experiment.mode,'new_resolution');
 assert.equal(request.display_experiment.width,1920);
 assert.equal(request.display_experiment.height,1080);
 assert.equal(request.display_experiment.dpi,360);
 assert.equal(request.screen_off,false);
 assert.match(multi.cards.get('id-1').qualityLine.textContent,/实验性虚拟屏幕 1920×1080/);
 const virtualCard=multi.cards.get('id-1');
 virtualCard.fullscreenButton.fire('click');
 assert.equal(root.document.fullscreenElement,virtualCard.screen);
 assert.equal(fullscreenEvents.size,1);
 virtual.emit('starting',{session_id:'virtual'});
 assert.equal(virtualCard.closeStreamButton.disabled,false);
 assert.match(virtualCard.closeStreamButton.title,/关闭当前投屏/);
 virtualCard.main.fire('click');
 virtualCard.closeStreamButton.fire('click');
 assert.equal(virtual.sent.at(-1),'stop','close icon stops this stream');
 assert.equal(drawerEvents.at(-1),'collapsed','wait for stop acknowledgement before opening');
 virtual.emit('ended',{session_id:'virtual',cleanup_complete:true});
 // Native exitFullscreen() resolves asynchronously, then its completion
 // callback reopens the drawer. Flush the bounded promise chain in this mock.
 for(let i=0;i<6&&drawerEvents.at(-1)!=='opened';i++)await Promise.resolve();
 assert.equal(drawerEvents.at(-1),'opened','fullscreen stop exits first, then opens management');
 assert.equal(root.document.fullscreenElement,null,'stopping a fullscreen stream must exit fullscreen');
 assert.equal(fullscreenEvents.size,0,'no stale listeners after terminal session');
 assert.equal(multi.cards.size,0);
 const regular=quality(0,'max_size');regular.value='1600';regular.fire('change');
 assert.equal(multi.getChoice('id-1').experimental_resolution,null);
 assert.equal(multi.getChoice('id-1').max_size,1600);
 assert.equal(playback(0).children[1].children[0].disabled,false);
 assert.equal(quality(0,'dpi').disabled,false,'normal mode retains selectable DPI preference');
 console.log('M2 fullscreen video controls, close-to-management and startup collapse: OK');
 console.log('M2 experimental resolutions use per-session virtual display and keep regular modes: OK');
  console.log('M2 WebRTC stop/no-ack black-card teardown is bounded without false-clean restart: OK');
 console.log('M2 panel-off, early wake, explicit reconnect isolation: OK');
 console.log('M2 parallel batch launch and out-of-order stop acknowledgements: OK');
 console.log('M2 selected-only batch stop preserves unselected live/control: OK');
 console.log('M2 per-device title projection control/start/stop/queue-cancel: OK');
 console.log('M2 append selected-only / active-control isolation / four-slot cap: OK');
 console.log('M2 per-device quality/diagnostics and selected-only launch: OK');
console.log('M2 aspect-correct video and 5s radial floating controls: OK');
})().catch(error=>{console.error(error);process.exitCode=1;});
