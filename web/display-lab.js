/* Manual per-device display experiments. No auto-connect, polling or hidden retries. */
(function(root){
'use strict';
const $=id=>document.getElementById(id);
const byId=id=>'/api/devices/'+encodeURIComponent(id)+'/display-lab/';
function create({dialog,getDevice,api,multiView,getGeneration=()=>0}){
 let current=null;
 const status=$('labStatus'),select=$('labDisplayId'),raw=$('labRaw'),logs=$('labLogs');
 function isCurrent(context){
  const device=context&&getDevice(context.id);
  return Boolean(context&&context===current&&dialog.open&&context.generation===getGeneration()&&
   device&&device.selected_serial===context.serial);
 }
 function invalidate(context=current){
  if(context!==current)return;
  current=null;
  context?.abortController.abort();
  if(dialog.open)dialog.close();
 }
 function show(context,message,error=false){
  if(!isCurrent(context))return;
  status.textContent=message;status.className='status'+(error?' error':' ok');
 }
 function render(context=current){
  if(!isCurrent(context))return;
  const {working,pending,castPending,ids,report,excerpt}=context;
  const d=getDevice(context.id),connected=Boolean(d&&d.status==='connected'&&
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
    (action==='castrestore'&&!castPending)||
    (action==='b3'&&(!select.value||Number(select.value)===0));
  }
  $('labStop').disabled=!d||!busy;
  $('labPending').textContent=[pending?'Overlay 副屏待恢复':'',castPending?'Cast+ 实验待恢复':''].filter(Boolean).join('；')||'暂无待恢复设置';
  const output=report.slice(-40).map(x=>'['+x.at+'] '+x.action+' · '+x.detail);
  logs.textContent=output.join('\n')||'暂无操作记录';
  raw.textContent=excerpt||'尚未扫描显示器';
 }
 async function request(context,action){
  if(!isCurrent(context))return null;
  const response=await api(byId(context.id)+action,{method:'POST',signal:context.abortController.signal});
  if(!isCurrent(context))return null;
  const result=await response.json();
  return isCurrent(context)?result:null;
 }
 async function refreshState(context){
  if(!isCurrent(context))return;
  const response=await api(byId(context.id)+'state',{signal:context.abortController.signal});
  if(!isCurrent(context))return;
  const state=await response.json();
  if(!isCurrent(context))return;
  context.pending=Boolean(state.pending_restore);context.castPending=Boolean(state.pending_castplus);context.report=state.logs||[];
  render(context);
 }
 async function run(action){
  const context=current;
  if(!isCurrent(context)||context.working)return;
  if(action==='a1'||action==='a2'||action==='b3'){
   let payload;
   if(action==='a1')payload={mode:'new'};
   if(action==='a2')payload={mode:'new_settings'};
   if(action==='b3'){
    const id=Number(select.value);
    if(!Number.isInteger(id)||id<1||!context.ids.includes(id))return;
    payload={mode:'display',display_id:id};
   }
   if(!multiView.startLabFor(context.id,payload)){
    show(context,'请先连接当前设备并停止其已有画面；同时最多四路投屏。',true);return;
   }
   show(context,'已启动实验视频；请在实时画面区域查看结果，结束后停止此路。');
   // A launched preview belongs to MultiView; closing the lab must not stop it.
   invalidate(context);return;
  }
  context.working=true;
  try{
   render(context);show(context,'正在执行 '+action.toUpperCase()+' …');
   const route={env:'environment',b1:'overlay',b2:'scan',restore:'restore',
    cast1:'castplus/start',cast2:'castplus/auto',cast3:'castplus/switch',
    cast4:'castplus/verify',castrestore:'castplus/restore'}[action];
   const result=await request(context,route);
   if(!isCurrent(context))return;
   if(result.display_ids)context.ids=result.display_ids;
   if(result.display_excerpt)context.excerpt=result.display_excerpt;
   if(result.cast_display){
    context.castReport={display:result.cast_display,cast_mode:result.cast_mode,
     selected_proj_mode:result.selected_proj_mode,pc_services_observed:result.pc_services_observed,
     pc_mode_evidence:result.pc_mode_evidence,switch_result:result.switch_result,
     broadcast_response:result.broadcast_response,note:result.note};
    const id=result.cast_display.display_id;
    if(Number.isInteger(id)&&id>0&&!context.ids.includes(id))context.ids.push(id);
    $('labCastReport').textContent=JSON.stringify(context.castReport,null,2);
   }
   if(action==='env'){
    $('labCastReport').textContent=JSON.stringify(result.castplus_capabilities||{},null,2);
    $('labEnvironment').textContent='Android '+result.android_version+
     '（API '+result.api_level+'） · scrcpy-server '+result.scrcpy_server_version+
     ' · 已检测显示器 '+context.ids.join(', ')+' · 副屏配置：'+result.overlay_setting;
   }
   if(action==='b1')show(context,result.unchanged?'原本就是此副屏配置，未覆盖原设置。':'模拟副屏指令完成；请继续扫描和预览，不能据此判定已进入华为电脑模式。');
   else if(action==='restore')show(context,'Overlay 已恢复；原始值：'+result.restored);
   else if(action==='cast1')show(context,result.cast_display?.verified?'已检测到 Type 5 CastPlusDisplay；华为是否接管仍需 B4 验证。':'辅助组件已发起创建，但未验证到符合条件的 Cast+ Display；请导出诊断。',!result.cast_display?.verified);
   else if(action==='cast2')show(context,result.cast_display?.verified
    ?'B2 已重建并验证 Type 5 CastPlusDisplay；仍需 B4 确认华为 PC Mode。'
    :(result.note||'B2 已执行，但未验证到 Type 5 CastPlusDisplay；请检查辅助服务后再试。'),
    !result.cast_display?.verified);
   else if(action==='cast3')show(context,result.switch_result==='permission_denied'?'华为广播权限被拒绝。':result.switch_result==='already_active'?'检测到 PC Mode 已激活，不重复切换。':'广播已发送，但不代表电脑模式启动；继续执行 B4。',result.switch_result==='permission_denied');
   else if(action==='cast4')show(context,result.pc_mode_evidence?'发现 PC Mode 的系统证据；还需预览原生桌面人工确认。':'尚无完整原生电脑模式证据；请查看诊断，不要将设置横屏误判为桌面。');
   else if(action==='castrestore')show(context,'Cast+ 辅助服务已停止，原始模式设置已恢复：'+result.restored);
   else show(context,'检测到 Display ID：'+context.ids.join(', ')+'。请选择非零显示源进行预览。');
   await refreshState(context);
  }catch(e){
   if(!isCurrent(context))return;
   show(context,e.message||'实验执行失败；如曾启动 B1，请检查待恢复状态。',true);
   try{await refreshState(context);}catch(_){}
  }finally{
   if(isCurrent(context)){context.working=false;render(context);}
  }
 }
 async function open(id){
  const device=getDevice(id);if(!device)return;
  invalidate();
  const context={id,serial:device.selected_serial,generation:getGeneration(),abortController:new AbortController(),
   working:false,pending:false,castPending:false,ids:[],report:[],excerpt:'',castReport:null};
  current=context;
  $('labCastReport').textContent='尚未执行华为专项测试';
  $('labEnvironment').textContent='尚未检测设备环境';
  dialog.showModal();render(context);show(context,'仅针对当前手动连接的设备执行实验。');
  try{await refreshState(context);}catch(e){show(context,e.message,true);}
 }
 dialog.addEventListener('click',event=>{
  const target=event.target.closest('[data-lab-action]');
  if(target&&!target.disabled)return run(target.dataset.labAction);
 });
 $('labClose').addEventListener('click',()=>invalidate());
 $('labStop').addEventListener('click',()=>{
  const context=current;
  if(!isCurrent(context))return;
  if(multiView.stopFor(context.id))show(context,'已请求停止当前设备的实验画面；等待会话完成清理。');
  render(context);
 });
 $('labExport').addEventListener('click',()=>{
  const context=current;
  if(!isCurrent(context))return;
  const {ids,excerpt,castReport,report}=context,d=getDevice(context.id);
  const result={device:d?.name||null,selected_serial:d?.selected_serial||null,
   display_ids:ids,display_excerpt:excerpt,castplus:castReport,logs:report,
   note:'测试现象需用户通过实时画面人工确认；此文件不包含视频帧或访问密钥。'};
  const blob=new Blob([JSON.stringify(result,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download='easyadb-display-lab-'+context.id+'.json';a.click();
  URL.revokeObjectURL(url);
 });
 select.addEventListener('change',()=>render());
 dialog.addEventListener('cancel',event=>{
  if(isCurrent(current)&&current.working)event.preventDefault();
  else invalidate();
 });
 // Native close events may arrive after a new device has reopened this dialog.
 dialog.addEventListener('close',()=>{if(!dialog.open)invalidate();});
 return {open,invalidate};
}
root.EasyADBDisplayLab=Object.freeze({create});
})(window);
