/* Standalone group floating-control contract, no browser/ADB/network required. */
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const page=fs.readFileSync('web/index.html','utf8');
const multiSource=fs.readFileSync('web/m2-multi.js','utf8');
const groupSource=fs.readFileSync('web/m2-group.js','utf8');
const server=fs.readFileSync('server/app.py','utf8');
assert.match(page,/id="groupControlHost"/);
assert.match(page,/src="\/m2-group\.js"/);
assert.match(page,/EasyADBGroup\.create\(\{view:multiView,host:/);
assert.match(page,/\.group-fab\{position:fixed;z-index:28;right:-22px/);
assert.match(page,/body\.video-fullscreen-active \.group-fab/);
assert.match(server,/@app\.get\("\/m2-group\.js"\)/);
assert.match(multiSource,/this\.groupControl\?\.refresh\(\)/);
assert.doesNotMatch(groupSource,/requestFullscreen|fab-fullscreen|exitFullscreen|fab-remote|control_enable|control_disable/);
assert.match(page,/\.multi-fab \.fab-nav-back\{top:48px;right:0\}/);
assert.match(page,/\.multi-fab \.fab-nav-home\{top:94px;right:0\}/);
assert.match(page,/\.multi-fab \.fab-nav-recents\{top:140px;right:0\}/);
class El{
 constructor(tag){
  this.tagName=tag;this.children=[];this.events={};this.hidden=false;
  this.disabled=false;this.value='';this.className='';this.attrs={};this.textContent='';
  this.classList={
   add:name=>{if(!this.className.split(' ').includes(name))this.className+=' '+name;},
   remove:name=>{this.className=this.className.split(' ').filter(v=>v!==name).join(' ');}
  };
 }
 append(...nodes){this.children.push(...nodes);}
 addEventListener(name,fn){(this.events[name]??=[]).push(fn);}
 setAttribute(key,value){this.attrs[key]=value;}
 fire(name){for(const fn of this.events[name]||[])fn({preventDefault(){}});}
 click(){if(!this.disabled)this.fire('click');}
 focus(){this.focused=true;}
}
const timers=new Map();let serial=0;
const root={
 document:{createElement:tag=>new El(tag)},
 WebSocket:{OPEN:1},
 setTimeout(fn,ms){assert.equal(ms,5000);const id=++serial;timers.set(id,fn);return id;},
 clearTimeout(id){timers.delete(id);}
};
root.window=root;
vm.runInNewContext(groupSource,root,{filename:'m2-group.js'});
function card(id,opts={}){
 const c={id,name:id,state:'ready',closed:false,session:'session-'+id,
  ready:true,enabled:true,pending:false,lastInput:false,
  ws:{readyState:1},logLines:['stream started '+id],keyStatus:{textContent:'ready'},
  wakeButton:new El('button'),
  reconnectButton:new El('button'),textButton:new El('button'),
  unlockButton:new El('button'),
  ...opts};
 c.wakeButton.addEventListener('click',()=>{c.woken=(c.woken||0)+1;});
 c.textButton.disabled=!c.enabled;
 return c;
}
const a=card('A'),b=card('B'),denied=card('DENIED');
denied.enabled=false;denied.textButton.disabled=true;denied.permissionWarningShown=true;
denied.unlockButton.disabled=true;
const sent=[],reconnected=[],reported=[],unlocked=[];
const view={
 cards:new Map(),status:(msg,err)=>reported.push([msg,err]),
 reconnectFor:id=>{reconnected.push(id);return true;},
 requestUnlock:c=>{unlocked.push([c.id,c.session]);c.unlockButton.disabled=true;return true;},
 sendInput:(c,type,payload)=>{
  sent.push({id:c.id,type,session:c.session,...payload});c.lastInput=true;
 },
 stopAll(){this.stopped=[...this.cards.keys()];for(const c of this.cards.values())c.state='stopping';},
 onOpenManagement(){this.managementOpened=true;}
};
const host=new El('div');
const group=root.EasyADBGroup.create({view,host});
assert.equal(group.fab.hidden,true,'no group control without live cards');
view.cards.set(a.id,a);view.cards.set(b.id,b);view.cards.set(denied.id,denied);
group.refresh();
assert.equal(group.fab.hidden,false);
assert.equal(host.children.length,2);
assert.equal(group.fab.children.some(node=>node.className.includes('fab-remote')),false,
 'group remote toggle no longer exists');
assert.equal(group.nav.slice(0,3).every(button=>button.hidden!==true),true,
 'navigation is permanently mounted beneath group FAB');
assert.equal(group.menuOpen,false);
assert.equal(group.nav.slice(0,3).every(button=>!button.disabled),true);
assert.match(page,/\.multi-fab \.fab-unlock\{right:104px;top:0/);
assert.equal(group.unlock.disabled,false);
group.main.click();
group.unlock.click();
assert.deepEqual(unlocked,[['A','session-A'],['B','session-B']],
 'group unlock invokes the per-device session entry for each eligible card');
assert.equal(group.unlock.disabled,true,'already-requested devices are not retriggered');
assert.equal(group.menuOpen,true);
assert.equal(group.main.attrs['aria-expanded'],'true');
assert.equal(timers.size,1);
assert.equal(a.enabled,true);assert.equal(b.enabled,true);
assert.equal(denied.enabled,false,'Android-denied card is skipped');
group.refresh();
group.nav[1].click();
assert.deepEqual(sent.map(x=>x.id),['A','B'],'home is sent to both enabled cards');
assert(sent.every(x=>x.type==='nav_key'&&x.key==='home'&&x.session==='session-'+x.id));
a.lastInput=false;b.lastInput=false;group.refresh();
group.text.click();assert.equal(group.form.hidden,false);
group.input.value='中文';group.form.fire('submit');
assert.equal(sent.length,2,'non-ASCII rejected');
group.input.value='hello';group.form.fire('submit');
assert.equal(sent.length,4);
assert.deepEqual(sent.slice(-2).map(x=>x.id),['A','B']);
assert(sent.slice(-2).every(x=>x.type==='input_text'&&x.text==='hello'));
assert.equal(group.input.value,'');
group.panel.hidden=false;group.updateLog();
assert.match(group.logContent.textContent,/【A】/);
assert.match(group.logContent.textContent,/【B】/);
assert.match(group.logContent.textContent,/【DENIED】/);
group.wake.click();
assert.equal(a.woken,1);assert.equal(b.woken,1);assert.equal(denied.woken,1,
 'wake follows the individual wake capability, independent of input permission');
denied.state='stopping';group.refresh();
group.reconnect.click();
assert.deepEqual(reconnected,['A','B'],'stopping session is skipped on reconnect');
assert.equal(group.menuOpen,false,'reconnect collapses floating group menu');
group.main.click();
assert.equal(timers.size,1);
const [timer]=timers.values();timers.clear();timer();
assert.equal(group.menuOpen,false,'menu folds after 5 seconds');
assert.equal(group.nav.slice(0,3).every(button=>button.hidden!==true),true,
 'fixed navigation is hidden by parent menu collapse rather than removed');
group.main.click();
group.stop.click();
assert.deepEqual(view.stopped,['A','B','DENIED']);
assert.equal(view.managementOpened,true);
assert.equal(group.fab.hidden,true,'control disappears after all stop');
assert.equal(group.nav.length,5);
console.log('M2 group floating controls, independent session dispatch and no fullscreen: OK');
