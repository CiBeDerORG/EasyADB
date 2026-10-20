/* Group control for the streams visible on this page. No extra ADB or media session:
 * each action uses the live card's existing, session-scoped control path.
 */
(function(root){
'use strict';
const make=(tag,cls='',value='')=>{
 const node=root.document.createElement(tag);
 if(cls)node.className=cls;
 node.textContent=value;
 return node;
};
const icon=(cls,glyph,label)=>{
 const button=make('button','fab-action '+cls,glyph);
 button.type='button';button.title=label;button.setAttribute('aria-label',label);
 return button;
};
const ASCII=/^[\x20-\x7e]{1,300}$/;
class GroupControl{
 constructor({view,host}){
  this.view=view;this.host=host;this.menuOpen=false;this.textOpen=false;this.timer=null;
  const fab=make('div','multi-fab group-fab');
  fab.hidden=true;fab.setAttribute('aria-label','实时画面群控');
  const main=make('button','fab-main','☷');
  main.type='button';main.title='展开群控操作';
  main.setAttribute('aria-label',main.title);main.setAttribute('aria-expanded','false');
  const log=icon('fab-up','☷','查看群控日志');
  const wake=icon('fab-up-wake','☀','唤醒全部可操作设备屏幕');
  const reconnect=icon('fab-up-reconnect','↻','重连全部当前实时画面');
  const stop=icon('fab-up-stop','✕','关闭全部实时画面并展开设备管理');
  const text=icon('fab-text','⌨','群控文字与按键输入');
  const unlock=icon('fab-unlock','🔓','主动解锁当前控制已就绪的画面');
  const form=make('form','multi-text-panel group-text-panel');form.hidden=true;
  form.setAttribute('aria-label','群控文字与按键输入');
  const head=make('div','multi-text-head');
  const textClose=make('button','secondary','×');
  textClose.type='button';textClose.setAttribute('aria-label','关闭群控文字输入');
  head.append(make('span','','群控文字输入'),textClose);
  const entry=make('div','multi-text-entry'),input=make('input'),submit=make('button','','发送');
  input.type='text';input.maxLength=300;input.autocomplete='off';
  input.placeholder='仅 ASCII，发送到控制已就绪的画面';
  submit.type='submit';entry.append(input,submit);
  const keys=make('div','multi-text-keys');
  const nav=[];
  for(const [key,label,glyph,cls] of [
   ['back','返回','↩','fab-nav-back'],['home','主页','⌂','fab-nav-home'],
   ['recents','最近任务','▣','fab-nav-recents'],
   ['enter','回车','↵',''],['backspace','退格','⌫','']
  ]){
   const button=cls?icon('fab-down '+cls,glyph,label):
    make('button','secondary',glyph+' '+label);
   button.type='button';button.disabled=true;button.setAttribute('aria-label','群控'+label);
   if(cls)fab.append(button);else keys.append(button);
   button.addEventListener('click',()=>{if(!button.disabled)this.sendInput('nav_key',{key});this.resetTimer();});
   nav.push(button);
  }
  form.append(head,entry,keys);
  fab.append(log,wake,reconnect,stop,text,unlock,main,form);
  const panel=make('section','group-log-panel');
  panel.hidden=true;panel.setAttribute('role','dialog');panel.setAttribute('aria-label','群控日志');
  const panelHead=make('div','multi-log-head'),panelClose=make('button','secondary multi-log-close','×');
  panelClose.type='button';panelClose.setAttribute('aria-label','关闭群控日志');
  panelHead.append(make('strong','','当前实时画面 · 群控日志'),panelClose);
  const logContent=make('pre','group-log-content');
  panel.append(panelHead,logContent);
  host.append(fab,panel);
  Object.assign(this,{fab,main,log,wake,reconnect,stop,text,unlock,form,input,submit,
   textClose,nav,panel,panelClose,logContent});
  main.addEventListener('click',()=>{
   if(fab.hidden)return;
   if(this.menuOpen)this.collapse();
   else{
    this.menuOpen=true;fab.classList.add('is-open');
    main.title='收起群控操作';main.setAttribute('aria-label',main.title);
    main.setAttribute('aria-expanded','true');this.resetTimer();
   }
  });
  log.addEventListener('click',()=>{
   if(!this.menuOpen||log.disabled)return;
   this.collapse();this.updateLog();panel.hidden=false;
  });
  panelClose.addEventListener('click',()=>{panel.hidden=true;});
  text.addEventListener('click',()=>{
   if(text.disabled||!this.menuOpen)return;
   this.textOpen=!this.textOpen;form.hidden=!this.textOpen;this.resetTimer();
   if(this.textOpen)input.focus();
  });
  textClose.addEventListener('click',()=>{
   this.textOpen=false;form.hidden=true;this.resetTimer();
  });
  for(const e of [form,input,submit,keys]){
   e.addEventListener('pointerdown',()=>this.resetTimer());
   e.addEventListener('keydown',()=>this.resetTimer());
  }
  input.addEventListener('input',()=>this.resetTimer());
  for(const b of [log,wake,reconnect,stop,text,unlock])
   b.addEventListener('pointerdown',()=>this.resetTimer());
  unlock.addEventListener('click',()=>{
   if(unlock.disabled)return;
   const targets=this.targets().filter(c=>c.unlockButton&&!c.unlockButton.disabled);
   let count=0;
   for(const card of targets)if(this.view.requestUnlock(card))count++;
   this.report('已分别向 '+count+' 路画面发出主动解锁请求；每台独立执行，结果见对应会话日志。',
    count===0);
   this.resetTimer();this.refresh();
  });
  wake.addEventListener('click',()=>{
   if(wake.disabled)return;
   const targets=this.targets().filter(c=>!c.wakeButton.disabled);
   for(const card of targets)card.wakeButton.click();
   this.report('已向 '+targets.length+' 路发送屏幕唤醒请求。');this.resetTimer();this.refresh();
  });
  reconnect.addEventListener('click',()=>{
   if(reconnect.disabled)return;
   const targets=this.targets().filter(c=>!c.reconnectButton.disabled);
   let count=0;
   for(const card of targets)if(view.reconnectFor(card.id))count++;
   this.report('已请求重连 '+count+' 路画面，分别等待原会话清理确认。');
   this.collapse();this.refresh();
  });
  stop.addEventListener('click',()=>{
   if(stop.disabled)return;
   const count=this.targets().length;
   this.collapse();panel.hidden=true;
   view.stopAll();view.onOpenManagement?.();
   this.report('已请求关闭 '+count+' 路画面，各路独立等待服务端清理确认。');
   this.refresh();
  });
  form.addEventListener('submit',event=>{
   event.preventDefault();this.resetTimer();
   if(submit.disabled)return;
   if(!ASCII.test(input.value)){
    this.report('群控文字仅支持 1～300 字节 ASCII 可打印字符。',true);return;
   }
   const count=this.sendInput('input_text',{text:input.value});
   if(count)input.value='';
  });
  this.refresh();
 }
 targets(){
  return [...this.view.cards.values()].filter(c=>!c.closed&&c.state!=='stopping');
 }
 canInput(card){
  return !card.textButton.disabled&&card.enabled&&!card.pending&&!card.lastInput&&
   card.session&&card.ws&&card.ws.readyState===root.WebSocket.OPEN&&
   (card.state==='ready'||card.state==='playing');
 }
 sendInput(type,payload){
  const targets=this.targets().filter(card=>this.canInput(card));
  for(const card of targets)this.view.sendInput(card,type,payload);
  this.report('群控指令已尝试发送至 '+targets.length+' 路控制已就绪的画面；其他设备跳过。',
   targets.length===0);
  this.refresh();return targets.length;
 }
 report(message,error=false){this.view.status('群控：'+message,error);}
 updateLog(){
  if(this.panel.hidden)return;
  const targets=this.targets();
  this.logContent.textContent=targets.length?targets.map(card=>
   '【'+card.name+'】'+card.state+' / 远控'+(card.enabled?'已启用':'未启用')+
   '\n'+(card.logLines.slice(-10).join('\n')||'等待本轮会话日志')+
   '\n'+(card.keyStatus?.textContent||'')).join('\n\n'):'当前没有正在投屏的设备';
 }
 collapse(){
  if(this.timer!==null){root.clearTimeout(this.timer);this.timer=null;}
  this.menuOpen=false;this.textOpen=false;this.form.hidden=true;
  this.fab.classList.remove('is-open');
  this.main.title='展开群控操作';this.main.setAttribute('aria-label',this.main.title);
  this.main.setAttribute('aria-expanded','false');
 }
 resetTimer(){
  if(this.timer!==null)root.clearTimeout(this.timer);
  this.timer=null;
  if(this.menuOpen)this.timer=root.setTimeout(()=>{this.timer=null;this.collapse();},5000);
 }
 refresh(){
  const targets=this.targets(),has=targets.length>0;
  this.fab.hidden=!has;
  if(!has){this.collapse();this.panel.hidden=true;}
  this.log.disabled=!has;this.stop.disabled=!has;
  this.wake.disabled=!targets.some(c=>!c.wakeButton.disabled);
  this.reconnect.disabled=!targets.some(c=>!c.reconnectButton.disabled);
  this.unlock.disabled=!targets.some(c=>c.unlockButton&&!c.unlockButton.disabled);
  const canInput=targets.some(c=>this.canInput(c));
  this.text.disabled=!canInput;this.input.disabled=!canInput;this.submit.disabled=!canInput;
  // Navigation stays mounted beneath the main FAB; only the menu's
  // expanded/collapsed state controls its visibility.
  for(const b of this.nav)b.disabled=!canInput;
  if(!canInput){this.textOpen=false;this.form.hidden=true;}
  this.updateLog();
 }
}
root.EasyADBGroup=Object.freeze({create:options=>new GroupControl(options)});
})(window);
