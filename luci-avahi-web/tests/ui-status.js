'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict');
const source=fs.readFileSync('htdocs/luci-static/resources/view/avahi-web/overview.js','utf8');
assert.ok(!source.includes("'require poll'")&&!source.includes('poll.add('));
let modal,scanCalls=0,authCalls=0,applyCalls=0,failStatusOnce=false,failScanOnce=false,browseInstalled=false;
let authManaged=false, authSuccess=false, clipboardValue='';
const SECRET='a'.repeat(64), SECRET_ROTATED='b'.repeat(64);
let nextSecret=SECRET;
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:function(v){clipboardValue=v;return Promise.resolve();}}}});
const running={avahi:true,dbus:true},boot={avahi:true,dbus:true};
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
function packages(){return ['avahi-dbus-daemon\tinstalled\t1.1-r1','avahi-utils\t'+(browseInstalled?'installed\t1.1-r1':'absent\t-'),'dbus\tinstalled\t1.0-r1'].join('\n');}
function status(){return [
 'running='+(running.avahi?'yes':'no'),'dbus='+(running.dbus?'yes':'no'),
 'avahi-daemon-bin=yes','avahi-browse-bin='+(browseInstalled?'yes':'no'),'dbus-bin=yes',
 'avahi-daemon-init=yes','dbus-init=yes',
 'avahi-daemon-enabled='+(boot.avahi?'yes':'no'),'dbus-enabled='+(boot.dbus?'yes':'no')].join('\n');}
const calls=[],endpoint={instance:'adb-1',iface:'br-lan',address:'192.168.1.5',port:37555};
const snapshot=JSON.stringify({status:'ok',scanned_at:1792400000,count:2,devices:[endpoint,Object.assign({},endpoint)]});
const rpc={exec:function(program,args){
 calls.push([program,args]);
 if(program.includes('luci-avahi-scan')){
  if(args[0]==='scan'){
   scanCalls++;
   if(failScanOnce){failScanOnce=false;return Promise.resolve({code:1,stderr:'Scan state directory owner UID 100 differs from scanner UID 0'});}
   return Promise.resolve({code:0,stdout:snapshot});
  }
  assert.equal(args[0],'last');return Promise.resolve(scanCalls?{code:0,stdout:snapshot}:{code:1,stderr:'No snapshot'});
 }
 if(program.includes('luci-avahi-auth')){
  if(args[0]==='status')return Promise.resolve({code:0,stdout:'state='+(authManaged?'managed':'absent')+'\n'});
  authCalls++;
  if(!authSuccess)return Promise.resolve({code:1,stderr:'mock denied'});
  if(args[0]==='revoke'){authManaged=false;return Promise.resolve({code:0,stdout:'state=absent\n'});}
  authManaged=true;
  return Promise.resolve({code:0,stdout:'state=managed\nusername=easyadb\nrole=luci-avahi-easyadb\npassword='+nextSecret+'\n'});
 }
 if(args[0]==='status'){
  if(failStatusOnce){failStatusOnce=false;return Promise.resolve({code:1,stderr:'模拟失败'});}
  return Promise.resolve({code:0,stdout:status()});
 }
 if(args[0]==='service'){
  const name=args[1],key=name.startsWith('dbus-')?'dbus':'avahi';
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
 assert.equal(cards.length,2);
 const grids=[];walk(page,n=>{if(n.props?.class==='avahi-service-grid')grids.push(n);});
 assert.equal(grids.length,1);assert.equal(grids[0].children.length,2,'Both components should share one row on desktop');
 const sections=[];walk(page,n=>{if(n.tag==='section'&&n.props?.class==='avahi-panel')sections.push(n);});
 assert.equal(sections.length,3);assert.ok(txt(sections[0]).includes('组件与服务管理'));
 assert.ok(txt(sections[1]).includes('ADB 设备发现'));assert.ok(txt(sections[2]).includes('NAS 接口授权'));
 assert.ok(source.includes('repeat(2,minmax(0,1fr))')&&source.includes('@media (max-width:800px)'));
 assert.ok(!source.includes('refreshIndex')&&!source.includes('operationDetails'));
 assert.ok(!txt(page).includes('查看最近一次软件包操作输出'));
 assert.ok(!txt(page).includes('刷新 APK 软件源索引'));
 assert.ok(!txt(page).includes('安装完整'));
 for(const label of ['立即发现 ADB','刷新结果','创建专用账号'])
  assert.ok(btn(page,label).every(n=>String(n.props.class).includes('avahi-action')),'Button needs visible boundary: '+label);
 assert.ok(!source.includes('umdns'),'No umdns front-end code should remain');
 assert.ok(!txt(page).includes('avahi-dbus-daemon'),'Installed packages should not be expanded');
 assert.ok(txt(page).includes('缺少软件包：avahi-utils'));
 for(const label of ['补齐安装','更新','停止','关闭自启','卸载','立即发现 ADB'])
  assert.ok(btn(page,label).some(b=>!b.disabled),'Must be clickable: '+label);
 assert.ok(btn(page,'停止').every(b=>b.props.disabled===null),'Boolean attribute false must be absent');
 await btn(page,'立即发现 ADB')[0].props.click();
 assert.equal(scanCalls,1);assert.ok(txt(page).includes('37555'));
 assert.ok(txt(page).includes('发现完成：本次检测到 1 个 ADB 端点'));
 const tables=[];walk(page,n=>{if(n.tag==='table'&&n.props?.class==='avahi-result-table')tables.push(n);});
 assert.equal(tables.length,1);
 const table=tables[0];const head=[],body=[],cols=[];
 walk(table,n=>{if(n.tag==='thead')head.push(n);if(n.tag==='tbody')body.push(n);if(n.tag==='col')cols.push(n);});
 assert.equal(cols.length,4);assert.equal(head.length,1);assert.equal(body.length,1);
 assert.equal(body[0].children.length,1,'Duplicated endpoint must occupy only one row');
 assert.equal(head[0].children[0].children.length,4);
 assert.ok(String(table.props.class).includes('avahi-result-table'));
 failScanOnce=true;
 await btn(page,'立即发现 ADB')[0].props.click();
 assert.ok(txt(page).includes('发现失败：Scan state directory owner UID 100 differs from scanner UID 0'),
  'RPCD stderr must appear alongside discovery controls, not only at the page top');
 assert.equal(scanCalls,2);
 assert.ok(!btn(page,'立即发现 ADB')[0].disabled,'Scan failure must re-enable discovery');
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
 assert.equal(applyCalls,1);assert.ok(!txt(page).includes('缺少软件包：avahi-utils'));assert.equal(btn(page,'补齐安装').length,0);
 btn(page,'创建专用账号')[0].props.click();await confirm();
 assert.equal(authCalls,1);assert.ok(!btn(page,'创建专用账号')[0].disabled);
 // A successful account creation must show the generated key visibly, not
 // as a textarea value attribute (which rendered a giant blank box).
 authSuccess=true;
 btn(page,'创建专用账号')[0].props.click();await confirm();
 assert.equal(authCalls,2);assert.ok(authManaged);
 assert.ok(txt(page).includes(SECRET),'One-time generated secret must be visible in selectable text');
 assert.ok(!txt(page).includes('创建专用账号'),'Hide unavailable create action once managed');
 assert.ok(btn(page,'重新生成密钥').length===1&&btn(page,'撤销授权').length===1);
 const credentialRows=[],passwordAreas=[];walk(page,n=>{
  if(n.props?.class==='avahi-credential-row')credentialRows.push(n);
  if(n.tag==='textarea')passwordAreas.push(n);
 });
 assert.equal(passwordAreas.length,0,'Never render an inert readonly textarea');
 assert.equal(credentialRows.length,1);
 const secretCodes=[];walk(credentialRows[0],n=>{if(n.tag==='code')secretCodes.push(n);});
 assert.equal(secretCodes.length,1);assert.equal(txt(secretCodes[0]),SECRET);
 await btn(page,'复制密钥')[0].props.click();
 assert.equal(clipboardValue,SECRET,'Copy button should copy the actual generated credential');
 assert.ok(txt(page).includes('密钥已复制'));
 // HTTP-only OpenWrt pages may not expose navigator.clipboard. Test the
 // manual-selection fallback so users can still copy their one-time key.
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{}});
 let selected=false;
 globalThis.window={getSelection:function(){return {removeAllRanges:function(){},addRange:function(){selected=true;}};}};
 globalThis.document={createRange:function(){return {selectNodeContents:function(node){assert.equal(txt(node),SECRET);}};},execCommand:function(cmd){assert.equal(cmd,'copy');return false;}};
 await btn(page,'复制密钥')[0].props.click();
 assert.ok(selected);assert.ok(txt(page).includes('Ctrl+C'));
 // A failed rotation must leave the earlier visible key intact.
 authSuccess=false;
 btn(page,'重新生成密钥')[0].props.click();await confirm();
 assert.equal(authCalls,3);assert.ok(txt(page).includes(SECRET));
 // On successful rotation, replace the old key and retain the new one.
 authSuccess=true;nextSecret=SECRET_ROTATED;
 btn(page,'重新生成密钥')[0].props.click();await confirm();
 assert.equal(authCalls,4);assert.ok(txt(page).includes(SECRET_ROTATED));
 assert.ok(!txt(page).includes(SECRET),'Old key must no longer be shown');
 btn(page,'撤销授权')[0].props.click();await confirm();
 assert.equal(authCalls,5);assert.ok(!authManaged);
 assert.ok(!txt(page).includes(SECRET_ROTATED),'Revocation should clear visible secret');
 assert.equal(btn(page,'创建专用账号').length,1);
 assert.equal(scanCalls,2);console.log('Two-component LuCI actions, credential copy and one-time secret lifecycle passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
