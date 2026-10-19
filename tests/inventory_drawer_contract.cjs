/* The drawer controller extracted from the real inline page script.
 * Fake clocks prove the 5s interaction timer, manual collapse, safety holds
 * and saved transparency without requiring a browser or network.
 */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync('web/index.html','utf8');
const inline=html.split('<script>',2)[1].split('</script>',1)[0];
const source=inline.slice(inline.indexOf("const inventoryDrawer=$("),inline.indexOf('function adbStatusBadge(d)'));
assert(source.startsWith('const inventoryDrawer='));
assert(source.includes('inventoryOpacity.addEventListener'));
class Element {
 constructor(){this.events={};this.attrs={};this.inert=true;this.value='';this.style={setProperty:(key,value)=>{this.css[key]=value;}};this.css={};
  const names=new Set();this.classList={add:x=>names.add(x),remove:x=>names.delete(x),contains:x=>names.has(x)};}
 addEventListener(type,callback){(this.events[type]??=[]).push(callback);}
 setAttribute(key,value){this.attrs[key]=value;}
 fire(type){for(const cb of this.events[type]||[])cb();}
}
const elements=Object.fromEntries(['inventoryDrawer','inventoryPanel','inventoryToggle','inventoryOpacity','inventoryOpacityValue'].map(id=>[id,new Element()]));
const dialogs=[{open:false}];
const storage=new Map();
let busy=false,scans=0,next=1;
const timers=new Map(),set=(fn,ms)=>{assert.equal(ms,5000);const id=next++;timers.set(id,fn);return id;};
const body=new Element(),documentEvents=new Map();
body.classList.toggle=(name,state)=>{if(state)body.classList.add(name);else body.classList.remove(name);};
const doc={getElementById:id=>elements[id],querySelectorAll:()=>dialogs,activeElement:null,
 fullscreenElement:null,body,
 addEventListener:(event,handler)=>documentEvents.set(event,handler)};
const ctx={document:doc,
 localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)},
 setTimeout:set,clearTimeout:id=>timers.delete(id)};
vm.runInNewContext("const $=id=>document.getElementById(id);let loading=false;const scanningGroups=new Set();\n"+source+
 "\nthis.api={setBusy:v=>loading=v,setScanning:v=>v?scanningGroups.add('home'):scanningGroups.clear()};",ctx);
const drawer=elements.inventoryDrawer,panel=elements.inventoryPanel,toggle=elements.inventoryToggle,slider=elements.inventoryOpacity;
const tick=()=>{const t=[...timers.values()];timers.clear();for(const fn of t)fn();};
assert.equal(drawer.classList.contains('is-open'),false);
assert.equal(slider.value,'20');assert.equal(panel.css['--inventory-panel-opacity'],'0.8');
toggle.fire('click');
assert.equal(drawer.classList.contains('is-open'),true);assert.equal(panel.inert,false);
assert.equal(toggle.attrs['aria-expanded'],'true');assert.equal(timers.size,1);
panel.fire('pointerdown');assert.equal(timers.size,1,'interaction resets, never multiplies timers');
panel.fire('input');assert.equal(timers.size,1);
drawer.fire('pointerenter');
assert.equal(timers.size,0,'pointer hovering the management drawer pauses the timer');
panel.fire('pointerdown');panel.fire('wheel');
assert.equal(timers.size,0,'interaction while hovered must not restart the timer');
tick();assert.equal(drawer.classList.contains('is-open'),true,'stationary mouse never closes the drawer');
drawer.fire('pointerleave');
assert.equal(timers.size,1,'leaving starts a new five-second countdown');
tick();assert.equal(drawer.classList.contains('is-open'),false);
assert.equal(panel.inert,true);assert.equal(timers.size,0,'collapsed drawer has no background polling');
toggle.fire('click');dialogs[0].open=true;tick();
assert.equal(drawer.classList.contains('is-open'),true,'do not hide an open modal');assert.equal(timers.size,1);
dialogs[0].open=false;ctx.api.setBusy(true);tick();
assert.equal(drawer.classList.contains('is-open'),true,'do not hide active operations');
ctx.api.setBusy(false);ctx.api.setScanning(true);tick();
assert.equal(drawer.classList.contains('is-open'),true,'do not hide an active discovery');
ctx.api.setScanning(false);tick();assert.equal(drawer.classList.contains('is-open'),false);
// Focused inline editing must not disappear; focusout re-arms the idle check.
const field={tagName:'INPUT',id:'token'};
panel.contains=node=>node===field;
toggle.fire('click');ctx.document.activeElement=field;panel.fire('focusin');tick();
assert.equal(drawer.classList.contains('is-open'),true,'do not hide a focused input');
ctx.document.activeElement=null;panel.fire('focusout');tick();
assert.equal(drawer.classList.contains('is-open'),false);
toggle.fire('click');slider.value='45';slider.fire('input');
assert.equal(elements.inventoryOpacityValue.textContent,'45%');
assert.equal(panel.css['--inventory-panel-opacity'],'0.55');
assert.equal(storage.get('easyadb.inventory-transparency'),'45');
drawer.fire('pointerenter');
toggle.fire('click');
assert.equal(drawer.classList.contains('is-open'),false,'manual collapse overrides hover');
assert.equal(timers.size,0);
drawer.fire('pointerleave');
// An open inventory drawer disappears immediately on video fullscreen and
// only its collapsed half-hidden handle comes back on browser Escape.
toggle.fire('click');
assert.equal(drawer.classList.contains('is-open'),true);
doc.fullscreenElement={id:'phone-stream'};
documentEvents.get('fullscreenchange')();
assert.equal(body.classList.contains('video-fullscreen-active'),true);
assert.equal(toggle.disabled,true);
assert.equal(drawer.classList.contains('is-open'),false);
assert.equal(panel.inert,true);
assert.equal(timers.size,0,'entering fullscreen cancels auto-collapse timer');
toggle.fire('click');
assert.equal(drawer.classList.contains('is-open'),false,'cannot expand while video is fullscreen');
doc.fullscreenElement=null;
documentEvents.get('fullscreenchange')();
assert.equal(body.classList.contains('video-fullscreen-active'),false);
assert.equal(toggle.disabled,false);
assert.equal(drawer.classList.contains('is-open'),false,'Escape restores the collapsed handle, not the open drawer');
toggle.fire('click');assert.equal(drawer.classList.contains('is-open'),true);
toggle.fire('click');
console.log('Inventory drawer hover pause, leave reset, manual override, fullscreen protection and transparency: OK');
