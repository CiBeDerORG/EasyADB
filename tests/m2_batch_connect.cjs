/* Exercise the real parallel batch worker from EasyADB's inline UI script.
 * Assert simultaneous launch, bounded concurrency, isolated failures and
 * per-index result aggregation, not just source-code grep matching.
 */
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const html=fs.readFileSync('web/index.html','utf8');
const start=html.indexOf('async function runDeviceBatch(');
const end=html.indexOf('\nfunction select(id)',start);
assert(start>=0&&end>start,'parallel helper is present in the actual page');
const worker=vm.runInNewContext(html.slice(start,end)+'\nrunDeviceBatch',{Promise,Array,Math});
const requests=[],pending=new Map(),progress=[];
const items=['A','B','C','D','E','F'];
let active=0,maxActive=0;
const task=id=>{
 requests.push(id);active++;maxActive=Math.max(maxActive,active);
 return new Promise((resolve,reject)=>pending.set(id,{
  done(value,error){
   active--;if(error)reject(new Error(error));else resolve(value);
  }
 }));
};
(async()=>{
 const run=worker(items,task,(done,total,item)=>progress.push([done,total,item]),4);
 assert.deepEqual(requests,['A','B','C','D'],'four requests issued immediately');
 assert.equal(active,4,'no serial ADB connect loop');
 pending.get('C').done(null,'offline');await Promise.resolve();await Promise.resolve();
 assert(requests.includes('E'),'E starts as soon as failed C settles; A remains pending');
 pending.get('B').done('ok-B');await Promise.resolve();await Promise.resolve();
 assert(requests.includes('F'),'F starts without waiting for slow A');
 for(const id of ['A','D','E','F'])pending.get(id).done('ok-'+id);
 const result=await run;
 assert.equal(result.length,6);
 assert.equal(result[2].status,'rejected');
 assert.match(result[2].reason.message,/offline/);
 for(const i of [0,1,3,4,5])assert.equal(result[i].status,'fulfilled');
 assert.equal(maxActive,4);
 assert.equal(progress.length,6);
 assert.equal(progress.at(-1)[0],6);
 assert.equal(active,0);
 const connectBody=html.slice(html.indexOf("$('bulkConnect').addEventListener"),
  html.indexOf("$('bulkDelete').addEventListener"));
 assert.match(connectBody,/await runDeviceBatch\(candidates/);
 assert.match(connectBody,/\/'\+encodeURIComponent\(d.id\)\+'\/connect'/);
 assert.doesNotMatch(connectBody,/for\(const d of candidates\)/,'no serial per-device await');
 console.log('Parallel batch connect: 4 simultaneous, next-on-settle, failure isolated: OK');
})().catch(e=>{console.error(e);process.exitCode=1;});
