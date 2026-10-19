'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict');
const source=fs.readFileSync('htdocs/luci-static/resources/view/avahi-web/overview.js','utf8');
assert.ok(!source.includes("'require poll'")&&!source.includes('poll.add('));
let modal,scanCalls=0,authCalls=0,applyCalls=0,failStatusOnce=false,browseInstalled=false;
const running={avahi:true,dbus:true,umdns:true},boot={avahi:true,dbus:true,umdns:true};
function E(tag,attrs,kids) {
 if(Array.isArray(attrs)||attrs==null||typeof attrs==='string'){kids=attrs;attrs={};}
 const n={tag,props:attrs||{},children:kids==null?[]:Array.isArray(kids)?kids:[kids],
  disabled:attrs&&attrs.disabled!=null&&attrs.disabled!==false};
 n.replaceChildren=function(...items){assert.ok(items.every(i=>!Array.isArray(i)));this.children=items;};
 n.appendChild=function(i){this.children.push(i);};return n;
}
function walk(v,fn){if(Array.isArray(v))return v.forEach(x=>walk(x,fn));if(v==null||typeof v!=='object')return;if(v.tag)fn(v);walk(v.children,fn);}
function txt(v){if(Array.isArray(v))return v.map(txt).join(' ');if(v==null)return '';if(typeof v!=='object')return String(v);return txt(v.children);}
function btn(v,label){const r=[];walk(v,n=>{if(n.tag==='button'&&txt(n)===label)r.push(n);});return r;}
function packages(){return ['avahi-dbus-daemon\tinstalled\t1.1-r1','avahi-utils\t'+(browseInstalled?'installed\t1.1-r1':'absent\t-'),'dbus\tinstalled\t1.0-r1','umdns\tinstalled\t1.0-r1'].join('\n');}
function status(){return [
 'running='+(running.avahi?'yes':'no'),'dbus='+(running.dbus?'yes':'no'),'umdns='+(running.umdns?'yes':'no'),
 'avahi-daemon-bin=yes','avahi-browse-bin='+(browseInstalled?'yes':'no'),'umdns-bin=yes','dbus-bin=yes',
 'avahi-daemon-init=yes','dbus-init=yes','umdns-init=yes',
 'avahi-daemon-enabled='+(boot.avahi?'yes':'no'),'umdns-enabled='+(boot.umdns?'yes':'no'),'dbus-enabled='+(boot.dbus?'yes':'no')].join('\n');}
const calls=[],snapshot=JSON.stringify({status:'ok',scanned_at:1792400000,count:1,devices:[{instance:'adb-1',iface:'br-lan',address:'192.168.1.5',port:37555}]});
const rpc={exec:function(program,args){
 calls.push([program,args]);
 if(program.includes('luci-avahi-scan')){
  if(args[0]==='scan'){scanCalls++;return Promise.resolve({code:0,stdout:snapshot});}
  assert.equal(args[0],'last');return Promise.resolve(scanCalls?{code:0,stdout:snapshot}:{code:1,stderr:'No snapshot'});
 }
 if(program.includes('luci-avahi-auth')){
  if(args[0]==='status')return Promise.resolve({code:0,stdout:'state=absent\n'});
  authCalls++;return Promise.resolve({code:1,stderr:'mock denied'});
 }
 if(args[0]==='status'){
  if(failStatusOnce){failStatusOnce=false;return Promise.resolve({code:1,stderr:'模拟失败'});}
  return Promise.resolve({code:0,stdout:status()});
 }
 if(args[0]==='service'){
  const name=args[1],key=name.startsWith('umdns-')?'umdns':name.startsWith('dbus-')?'dbus':'avahi';
  const op=name.includes('-')?name.slice(name.indexOf('-')+1):name;
  if(op==='start')running[key]=true;
  else if(op==='stop')running[key]=false;
  else if(op==='enable')boot[key]=true;
  else if(op==='disable')boot[key]=false;
  else throw Error(name);
  return Promise.resolve({code:0,stdout:'OK'});
 }
 if(args[0]==='package'){
  if(args[1]==='list')return Promise.resolve({code:0,stdout:packages()});
  if(args[1]==='plan')return Promise.resolve({code:0,stdout:'SIMULATION'});
  if(args[1]==='apply'){applyCalls++;if(args[2]==='install'&&args[3]==='avahi')browseInstalled=true;return Promise.resolve({code:0,stdout:'OK'});}
  if(args[1]==='refresh')return Promise.resolve({code:0,stdout:'OK'});
 }
 throw Error('Unknown call '+args.join(' '));
}};
const view=new Function('view','fs','ui','E','_',source)({extend:x=>x},rpc,{
 showModal(title,children){modal=E('modal',{title},children);},hideModal(){modal=undefined;}
},E,x=>x);
function confirm(){assert.ok(modal);const b=btn(modal,'确认').concat(btn(modal,'确认执行'));assert.equal(b.length,1);return b[0].props.click();}
(async function(){
 const data=await view.load();assert.equal(calls.length,4);
 const page=view.render(data);assert.equal(scanCalls,0);
 const cards=[];walk(page,n=>{if(String(n.props?.class||'').includes('avahi-component-card'))cards.push(n);});
 assert.equal(cards.length,3);
 assert.ok(!txt(page).includes('avahi-dbus-daemon'),'Installed packages should not be expanded');
 assert.ok(txt(page).includes('缺少软件包：avahi-utils'));
 assert.ok(txt(page).includes('这不等于已经发生 UDP 5353'));
 for(const label of ['补齐安装','更新','停止','关闭自启','卸载','立即发现 ADB'])
  assert.ok(btn(page,label).some(b=>!b.disabled),'Must be clickable: '+label);
 assert.ok(btn(page,'停止').every(b=>b.props.disabled===null),'Boolean attribute false must be absent');
 await btn(page,'立即发现 ADB')[0].props.click();
 assert.equal(scanCalls,1);assert.ok(txt(page).includes('37555'));
 failStatusOnce=true;await btn(page,'手动刷新组件状态')[0].props.click();
 assert.ok(txt(page).includes('模拟失败'));assert.ok(!btn(page,'手动刷新组件状态')[0].disabled);
 btn(page,'停止')[0].props.click();assert.ok(running.avahi);await confirm();assert.equal(running.avahi,false);
 assert.ok(btn(page,'启动').some(b=>!b.disabled),'Runtime control should switch label');
 const bootOff=btn(page,'关闭自启')[0];bootOff.props.click();await confirm();assert.equal(boot.avahi,false);
 assert.ok(btn(page,'启用自启').length>0);
 await btn(page,'补齐安装')[0].props.click();assert.equal(applyCalls,0);
 modal=undefined;assert.ok(!btn(page,'补齐安装')[0].disabled,'Dialog dismiss should unlock');
 await btn(page,'补齐安装')[0].props.click();
 const c=btn(modal,'确认执行')[0],a=c.props.click(),b=c.props.click();await Promise.all([a,b]);
 assert.equal(applyCalls,1);assert.ok(txt(page).includes('安装完整'));assert.equal(btn(page,'补齐安装').length,0);
 btn(page,'创建专用账号')[0].props.click();await confirm();
 assert.equal(authCalls,1);assert.ok(!btn(page,'创建专用账号')[0].disabled);
 assert.equal(scanCalls,1);console.log('LuCI unified actions and manual scan interactions passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
