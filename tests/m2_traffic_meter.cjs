/* Actual browser traffic meter, isolated from network and timers. */
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../web/m2-traffic.js'),'utf8');
const window={};
vm.runInNewContext(source,{window,Number,Error,Math}, {filename:'m2-traffic.js'});
const {Meter,format,size}=window.EasyADBTraffic;
const MIB=1024*1024;
const meter=new Meter(0);
assert.equal(meter.snapshot().totalBytes,0);
assert.equal(meter.sample(0).mbps,0);
meter.record(MIB);
let sample=meter.sample(1000);
assert.equal(sample.totalBytes,MIB);
assert(Math.abs(sample.mbps-8.388608)<1e-9);
assert.equal(sample.mibPerSecond,1);
assert.equal(sample.totalMib,1);
assert.equal(format(sample),'视频接收速度：8.39 Mbps（1.00 MiB/s）｜本次投屏累计：1.00 MiB');
meter.record(MIB/2);
sample=meter.sample(2000);
assert.equal(sample.mibPerSecond,0.5);
assert.equal(sample.totalBytes,MIB*1.5);
sample=meter.sample(3000); // no new video frames: zero CURRENT speed, cumulative persists
assert.equal(sample.mbps,0);
assert.equal(sample.totalMib,1.5);
assert.equal(format(sample,true),'视频接收速度：0.00 Mbps（0.00 MiB/s）｜本次投屏累计：1.50 MiB（已结束）');
assert.equal(size(2*1024*MIB),'2.00 GiB');
// Sampling too early must not erase pending traffic or create a high rate spike.
meter.record(256);
sample=meter.sample(3010);
assert.equal(sample.mbps,0);
assert.equal(meter.sampleBytes,256);
sample=meter.sample(4000);
assert.equal(sample.totalBytes,MIB*1.5+256);
assert(sample.mbps>0);
assert.throws(()=>meter.record(-1),/无效/);
assert.throws(()=>meter.record(1.5),/无效/);
assert.throws(()=>meter.sample(NaN),/无效/);
// Every manually started stream owns a fresh meter; no global/lifetime tally.
const another=new Meter(5000);
assert.equal(another.snapshot().totalBytes,0);
another.record(2000);
assert.equal(another.sample(6000).totalBytes,2000);
assert.equal(meter.snapshot().totalBytes,MIB*1.5+256);
console.log('Session-local throughput, idle zero, cumulative transfer and reset: OK');
