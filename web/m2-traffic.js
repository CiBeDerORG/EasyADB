/* Session-only live video traffic meter.
 * Counts ONLY actual received WebSocket binary video payload bytes; no
 * HTTP, ADB, framing, TCP/IP overhead, or other NAS/device traffic.
 * Reads from the existing one-second diagnostic messages: no background timer.
 */
(function(root){
'use strict';
const MIB = 1024 * 1024;
class Meter {
  constructor(now=0){
    this.totalBytes=0;
    this.sampleBytes=0;
    this.lastSampleAt=now;
    this.lastBytesPerSecond=0;
  }
  record(byteLength){
    if(!Number.isSafeInteger(byteLength)||byteLength<0){
      throw Error('视频数据字节数无效');
    }
    this.totalBytes+=byteLength;
    this.sampleBytes+=byteLength;
  }
  sample(now){
    if(!Number.isFinite(now))throw Error('统计时间无效');
    const seconds=(now-this.lastSampleAt)/1000;
    if(seconds>=0.25){
      this.lastBytesPerSecond=this.sampleBytes/seconds;
      this.lastSampleAt=now;
      this.sampleBytes=0;
    }
    return this.snapshot();
  }
  snapshot(){
    return {
      totalBytes:this.totalBytes,
      bytesPerSecond:this.lastBytesPerSecond,
      mbps:this.lastBytesPerSecond*8/1_000_000,
      mibPerSecond:this.lastBytesPerSecond/MIB,
      totalMib:this.totalBytes/MIB
    };
  }
}
function size(bytes){
  if(bytes>=MIB*1024)return (bytes/(MIB*1024)).toFixed(2)+' GiB';
  return (bytes/MIB).toFixed(2)+' MiB';
}
function format(sample,finished=false){
  return '视频接收速度：'+(finished?'0.00':sample.mbps.toFixed(2))+
    ' Mbps（'+(finished?'0.00':sample.mibPerSecond.toFixed(2))+
    ' MiB/s）｜本次投屏累计：'+size(sample.totalBytes)+
    (finished?'（已结束）':'');
}
root.EasyADBTraffic=Object.freeze({Meter,format,size});
})(window);
