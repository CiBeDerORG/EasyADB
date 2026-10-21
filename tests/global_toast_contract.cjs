/* Real inline toast controller: fixed 10-second lifetime, hover/selection
 * pause, progress replacement, independent scan details, and manual dismiss.
 */
'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict'),vm=require('node:vm');
const page=fs.readFileSync('web/index.html','utf8');
const css=fs.readFileSync('web/assets/legacy-page.css','utf8');
const inline=page.split('<script>',2)[1].split('</script>',1)[0];
const source=inline.slice(inline.indexOf("const toastHost=$('toastHost')"),inline.indexOf('async function api('));
assert(source.startsWith("const toastHost=$('toastHost')"));
assert(!page.includes('id="message"'));
assert(page.indexOf('id="toastHost"')>page.indexOf('</main>'),'Toast host is outside the transparent drawer');
assert(css.includes('.toast-host{position:fixed;'),'Toast must overlay the page');
assert(!inline.includes("'/discovery/last'"),'history is not replayed as a fresh toast');
class El{
 constructor(tag='div'){this.tagName=tag.toUpperCase();this.className='';this.children=[];this.parentNode=null;this.listeners={};this.attrs={};this.textContent='';this.type='';}
 setAttribute(k,v){this.attrs[k]=v;}
 addEventListener(k,fn){(this.listeners[k]??=[]).push(fn);}
 fire(k){for(const f of this.listeners[k]||[])f();}
 append(...nodes){for(const node of nodes){this.children.push(node);node.parentNode=this;}}
 prepend(node){this.children.unshift(node);node.parentNode=this;}
 remove(){if(this.parentNode){const a=this.parentNode.children;const i=a.indexOf(this);if(i>=0)a.splice(i,1);this.parentNode=null;}}
 contains(node){for(let p=node;p;p=p.parentNode)if(p===this)return true;return false;}
}
const host=new El(),events={};let selected={isCollapsed:true},now=0,next=1;
const timers=new Map();
const ctx={
 document:{createElement:tag=>new El(tag),addEventListener:(kind,fn)=>events[kind]=fn},
 window:{getSelection:()=>selected},
 Date:{now:()=>now},
 setTimeout:(fn,ms)=>{const id=next++;timers.set(id,{fn,at:now+ms,ms});return id;},
 clearTimeout:id=>timers.delete(id),
};
ctx.document.getElementById=id=>{assert.equal(id,'toastHost');return host;};
function advance(ms){const goal=now+ms;while(true){const due=[...timers].filter(([,t])=>t.at<=goal).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;now=due[1].at;timers.delete(due[0]);due[1].fn();}now=goal;}
vm.runInNewContext("const $=id=>document.getElementById(id);"+source+
 "\nthis.toastApi={showToast,message,dismissToast,toastItems};",ctx);
const {showToast,message,dismissToast,toastItems}=ctx.toastApi;
message('批量连接中','ok');
assert.equal(host.children.length,1);
const a=host.children[0];
assert.equal(a.attrs.role,'status');
assert.equal(a.children[0].textContent,'批量连接中');
assert.equal(timers.size,1);
advance(4000);a.fire('pointerenter');assert.equal(timers.size,0);
advance(30000);assert.equal(host.children.length,1,'hover holds a toast past 10 seconds');
a.fire('pointerleave');assert.equal(timers.size,1);
advance(5999);assert.equal(host.children.length,1);
advance(1);assert.equal(host.children.length,0,'resume uses remaining six seconds');
message('进行中');message('连接完成','ok');
assert.equal(host.children.length,1,'progress replaces, never stacks');
assert.equal(host.children[0].children[0].textContent,'连接完成');
const rich=new El('div');rich.className='group-discovery-status';
const row=new El('div');row.className='discovery-endpoint skipped';rich.append(row);
const scan=showToast(rich,{key:'discovery:上海',kind:'ok'});
assert.equal(host.children.length,2,'independent status and scan results coexist');
assert.equal(scan.children[0].children[0],rich,'discovery detail DOM remains rich and scrollable');
assert.equal(scan.children[0].children[0].children[0].className,'discovery-endpoint skipped');
scan.fire('pointerenter');
selected={isCollapsed:false,anchorNode:row,focusNode:row};
events.selectionchange();scan.fire('pointerleave');
advance(25000);
assert.equal(host.children.includes(scan),true,'selected text stays, even after mouse leaves');
selected={isCollapsed:true};events.selectionchange();advance(10000);
assert.equal(host.children.includes(scan),false,'clearing selection resumes remaining life');
const failed=showToast('发现失败',{key:'discovery:上海',kind:'error'});
assert.equal(failed.attrs.role,'alert');
failed.children[1].fire('click');
assert.equal(host.children.includes(failed),false,'close button dismisses immediately');
assert.equal(toastItems.has('discovery:上海'),false);
dismissToast('status');assert.equal(host.children.length,0);assert.equal(timers.size,0);
console.log('Global toast: 10s, hover/text selection hold, status replacement, rich scan and close: OK');
