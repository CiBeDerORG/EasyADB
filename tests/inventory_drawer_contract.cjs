/* Exercise the actual drawer controller: it has no inactivity timer.
 * Clicks inside never dismiss; outside pointer presses do, except while a
 * management dialog is open. Manual/project/fullscreen retract as before.
 */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync('web/index.html','utf8');
const inline=html.split('<script>',2)[1].split('</script>',1)[0];
const source=inline.slice(inline.indexOf("const inventoryDrawer=$("),inline.indexOf('function adbStatusBadge(d)'));
assert(source.startsWith('const inventoryDrawer='));
assert(source.includes('inventoryOpacity.addEventListener'));
assert(!source.includes('setTimeout('),'device management must not auto-collapse on inactivity');
assert(!source.includes('inventoryHovered'),'hover state must not control closure');
class Element {
 constructor(){this.events={};this.attrs={};this.inert=true;this.value='';
  this.style={setProperty:(key,value)=>{this.css[key]=value;}};this.css={};
  this.parent=null;const names=new Set();
  this.classList={add:x=>names.add(x),remove:x=>names.delete(x),contains:x=>names.has(x)};
 }
 addEventListener(type,callback){(this.events[type]??=[]).push(callback);}
 setAttribute(key,value){this.attrs[key]=value;}
 contains(node){for(let p=node;p;p=p.parent)if(p===this)return true;return false;}
 fire(type,arg={}){for(const cb of this.events[type]||[])cb(arg);}
}
const elements=Object.fromEntries(['inventoryDrawer','inventoryPanel','inventoryToggle','inventoryOpacity','inventoryOpacityValue'].map(id=>[id,new Element()]));
const drawer=elements.inventoryDrawer,panel=elements.inventoryPanel,toggle=elements.inventoryToggle,slider=elements.inventoryOpacity;
panel.parent=drawer;toggle.parent=drawer;
const inside=new Element(),outside=new Element(),modalContent=new Element();
inside.parent=panel;
const dialogs=[{open:false}];
const storage=new Map(),body=new Element(),documentEvents=new Map();
body.classList.toggle=(name,state)=>{if(state)body.classList.add(name);else body.classList.remove(name);};
const doc={getElementById:id=>elements[id],querySelectorAll:()=>dialogs,
 fullscreenElement:null,body,
 addEventListener:(event,handler,capture)=>documentEvents.set(event,{handler,capture})};
const ctx={document:doc,
 localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)},
 setTimeout:()=>{throw Error('No auto-collapse timer should exist');},
 clearTimeout:()=>{throw Error('No auto-collapse timer should exist');}};
vm.runInNewContext("const $=id=>document.getElementById(id);"+source,ctx);
const clickOutside=target=>documentEvents.get('pointerdown').handler({target});
const expanded=()=>drawer.classList.contains('is-open');
assert.equal(documentEvents.get('pointerdown').capture,true,'outside listener captures before other actions');
assert.equal(expanded(),false);assert.equal(slider.value,'20');
assert.equal(panel.css['--inventory-panel-opacity'],'0.8');
clickOutside(outside);assert.equal(expanded(),false,'outside click while closed is inert');
toggle.fire('click');assert.equal(expanded(),true);assert.equal(panel.inert,false);
assert.equal(toggle.attrs['aria-expanded'],'true');
clickOutside(inside);clickOutside(panel);clickOutside(toggle);
assert.equal(expanded(),true,'panel, its controls and the handle are all inside');
panel.fire('input');panel.fire('wheel');drawer.fire('pointerleave');
assert.equal(expanded(),true,'scroll, input and mouse leaving never auto-dismiss');
clickOutside(outside);assert.equal(expanded(),false,'outside press retracts immediately');
assert.equal(panel.inert,true);assert.equal(toggle.attrs['aria-expanded'],'false');
toggle.fire('click');dialogs[0].open=true;
clickOutside(modalContent);assert.equal(expanded(),true,'keep drawer available while editing modal is open');
dialogs[0].open=false;clickOutside(outside);assert.equal(expanded(),false);
toggle.fire('click');slider.value='45';slider.fire('input');
assert.equal(elements.inventoryOpacityValue.textContent,'45%');
assert.equal(panel.css['--inventory-panel-opacity'],'0.55');
assert.equal(storage.get('easyadb.inventory-transparency'),'45');
toggle.fire('click');assert.equal(expanded(),false,'manual handle retracts immediately');
toggle.fire('click');assert.equal(expanded(),true);
doc.fullscreenElement={id:'phone-stream'};
documentEvents.get('fullscreenchange').handler();
assert.equal(body.classList.contains('video-fullscreen-active'),true);
assert.equal(toggle.disabled,true);assert.equal(expanded(),false);
toggle.fire('click');assert.equal(expanded(),false,'fullscreen prevents opening');
doc.fullscreenElement=null;documentEvents.get('fullscreenchange').handler();
assert.equal(body.classList.contains('video-fullscreen-active'),false);
assert.equal(toggle.disabled,false);assert.equal(expanded(),false,'Escape restores only collapsed handle');
toggle.fire('click');assert.equal(expanded(),true);
console.log('Inventory drawer outside-click, modal protection, no timeout, fullscreen and transparency: OK');
