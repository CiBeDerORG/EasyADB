/* Manual per-device display experiments. No auto-connect, polling or hidden retries. */
(function(root){
'use strict';
const $=id=>document.getElementById(id);
const byId=id=>'/api/devices/'+encodeURIComponent(id)+'/display-lab/';
function create({dialog,getDevice,api,multiView}){
 let current=null,working=false,pending=false,castPending=false,ids=[],report=[],excerpt='',castReport=null;
 const status=$('labStatus'),select=$('labDisplayId'),raw=$('labRaw'),logs=$('labLogs');
 function show(message,error=false){status.textContent=message;status.className='status'+(error?' error':' ok');}
 function render(){
  const d=current&&getDevice(current),connected=Boolean(d&&d.status==='connected'&&
   d.selected_serial&&d.active_serial===d.selected_serial&&!d.connect_failed);
  const busy=Boolean(d&&multiView.isBusyFor(d.id));
  const chosen=select.value;
  select.replaceChildren();
  for(const id of ids.filter(id=>id>0)){
   const option=document.createElement('option');option.value=String(id);
   option.textContent='Display '+id;select.append(option);
  }
  if(ids.includes(Number(chosen)))select.value=chosen;
  for(const b of dialog.querySelectorAll('[data-lab-action]')){
   const action=b.dataset.labAction;
   b.disabled=working||!connected||
    (['a1','a2','b1','b3','cast1','cast2','cast3','castrestore'].includes(action)&&busy)||
    (action==='b1'&&(pending||castPending))||(action==='restore'&&(!pending||busy))||
    (action==='cast1'&&(pending||castPending))||
    (['cast2','cast3','castrestore'].includes(action)&&!castPending)||
    (action==='b3'&&(!select.value||Number(select.value)===0));
  }
  $('labStop').disabled=!d||!busy;
  $('labPending').textContent=[pending?'Overlay 副屏待恢复':'',castPending?'Cast+ 实验待恢复':''].filter(Boolean).join('；')||'暂无待恢复设置';
  const output=report.slice(-40).map(x=>'['+x.at+'] '+x.action+' · '+x.detail);
  logs.textContent=output.join('\n')||'暂无操作记录';
  raw.textContent=excerpt||'尚未扫描显示器';
 }
 async function request(action){
  const response=await api(byId(current)+action,{method:'POST'});
  return response.json();
 }
 async function refreshState(){
  const response=await api(byId(current)+'state');
  const state=await response.json();pending=Boolean(state.pending_restore);castPending=Boolean(state.pending_castplus);report=state.logs||[];
  render();
 }
 async function run(action){
  if(working||!current)return;
  const d=getDevice(current);if(!d)return;
  if(action==='a1'||action==='a2'||action==='b3'){
   let payload;
   if(action==='a1')payload={mode:'new'};
   if(action==='a2')payload={mode:'new_settings'};
   if(action==='b3'){
    const id=Number(select.value);
    if(!Number.isInteger(id)||id<1||!ids.includes(id))return;
    payload={mode:'display',display_id:id};
   }
   if(!multiView.startLabFor(current,payload)){
    show('请先连接当前设备并停止其已有画面；同时最多四路投屏。',true);return;
   }
   show('已启动实验视频；请在实时画面区域查看结果，结束后停止此路。');
   dialog.close();return;
  }
  working=true;render();show('正在执行 '+action.toUpperCase()+' …');
  try{
   const route={env:'environment',b1:'overlay',b2:'scan',restore:'restore',
    cast1:'castplus/start',cast2:'castplus/auto',cast3:'castplus/switch',
    cast4:'castplus/verify',castrestore:'castplus/restore'}[action];
   const result=await request(route);
   if(result.display_ids)ids=result.display_ids;
   if(result.display_excerpt)excerpt=result.display_excerpt;
   if(result.cast_display){
    castReport={display:result.cast_display,cast_mode:result.cast_mode,
     selected_proj_mode:result.selected_proj_mode,pc_services_observed:result.pc_services_observed,
     pc_mode_evidence:result.pc_mode_evidence,switch_result:result.switch_result,
     broadcast_response:result.broadcast_response,note:result.note};
    const id=result.cast_display.display_id;
    if(Number.isInteger(id)&&id>0&&!ids.includes(id))ids.push(id);
    $('labCastReport').textContent=JSON.stringify(castReport,null,2);
   }
   if(action==='env'){
    $('labCastReport').textContent=JSON.stringify(result.castplus_capabilities||{},null,2);
    $('labEnvironment').textContent='Android '+result.android_version+
     '（API '+result.api_level+'） · scrcpy-server '+result.scrcpy_server_version+
     ' · 已检测显示器 '+ids.join(', ')+' · 副屏配置：'+result.overlay_setting;
   }
   if(action==='b1')show(result.unchanged?'原本就是此副屏配置，未覆盖原设置。':'模拟副屏指令完成；请继续扫描和预览，不能据此判定已进入华为电脑模式。');
   else if(action==='restore')show('Overlay 已恢复；原始值：'+result.restored);
   else if(action==='cast1')show(result.cast_display?.verified?'已检测到 Type 5 CastPlusDisplay；华为是否接管仍需 B4 验证。':'辅助组件已发起创建，但未验证到符合条件的 Cast+ Display；请导出诊断。',!result.cast_display?.verified);
   else if(action==='cast2')show('已写入模式偏好并重新创建 Cast+；必须继续验证华为 PC Mode，不能仅凭模式值判断。');
   else if(action==='cast3')show(result.switch_result==='permission_denied'?'华为广播权限被拒绝。':result.switch_result==='already_active'?'检测到 PC Mode 已激活，不重复切换。':'广播已发送，但不代表电脑模式启动；继续执行 B4。',result.switch_result==='permission_denied');
   else if(action==='cast4')show(result.pc_mode_evidence?'发现 PC Mode 的系统证据；还需预览原生桌面人工确认。':'尚无完整原生电脑模式证据；请查看诊断，不要将设置横屏误判为桌面。');
   else if(action==='castrestore')show('Cast+ 辅助服务已停止，原始模式设置已恢复：'+result.restored);
   else show('检测到 Display ID：'+ids.join(', ')+'。请选择非零显示源进行预览。');
   await refreshState();
  }catch(e){
   show(e.message||'实验执行失败；如曾启动 B1，请检查待恢复状态。',true);
   try{await refreshState();}catch(_){}
  }finally{working=false;render();}
 }
 async function open(id){
  current=id;pending=false;castPending=false;ids=[];report=[];excerpt='';castReport=null;
  $('labCastReport').textContent='尚未执行华为专项测试';
  $('labEnvironment').textContent='尚未检测设备环境';
  render();dialog.showModal();show('仅针对当前手动连接的设备执行实验。');
  try{await refreshState();}catch(e){show(e.message,true);}
 }
 dialog.addEventListener('click',event=>{
  const target=event.target.closest('[data-lab-action]');
  if(target&&!target.disabled)run(target.dataset.labAction);
 });
 $('labClose').addEventListener('click',()=>dialog.close());
 $('labStop').addEventListener('click',()=>{
  if(current&&multiView.stopFor(current))show('已请求停止当前设备的实验画面；等待会话完成清理。');
  render();
 });
 $('labExport').addEventListener('click',()=>{
  const d=current&&getDevice(current);
  const result={device:d?.name||null,selected_serial:d?.selected_serial||null,
   display_ids:ids,display_excerpt:excerpt,castplus:castReport,logs:report,
   note:'测试现象需用户通过实时画面人工确认；此文件不包含视频帧或访问密钥。'};
  const blob=new Blob([JSON.stringify(result,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download='easyadb-display-lab-'+(current||'device')+'.json';a.click();
  URL.revokeObjectURL(url);
 });
 select.addEventListener('change',render);
 dialog.addEventListener('cancel',event=>{if(working)event.preventDefault();});
 return {open};
}
root.EasyADBDisplayLab=Object.freeze({create});
})(window);
