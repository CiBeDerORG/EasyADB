/* M2-02: explicit single-finger pointer control for ONE already-opened live WS.
 * Layout coordinates are mapped only inside the video image (black bars ignored).
 * No keyboard, arbitrary ADB commands, multi-touch or background gestures.
 */
(function(root){
'use strict';
function mapPoint(video, size, clientX, clientY, clamp=false){
  if(!size||video.videoWidth!==size.width||video.videoHeight!==size.height)return null;
  const rect=video.getBoundingClientRect();
  if(!(rect.width>0&&rect.height>0&&size.width>0&&size.height>0))return null;
  const scale=Math.min(rect.width/size.width,rect.height/size.height);
  const left=rect.left+(rect.width-size.width*scale)/2;
  const top=rect.top+(rect.height-size.height*scale)/2;
  const px=(clientX-left)/scale,py=(clientY-top)/scale;
  if(!Number.isFinite(px)||!Number.isFinite(py))return null;
  if(!clamp&&(px<0||py<0||px>=size.width||py>=size.height))return null;
  const x=Math.max(0,Math.min(size.width-1,Math.floor(px)));
  const y=Math.max(0,Math.min(size.height-1,Math.floor(py)));
  return {x,y,width:size.width,height:size.height};
}
class TouchController{
  constructor(video,send){
    this.video=video;this.send=send;
    this.enabled=false;this.size=null;this.activeId=null;this.last=null;this.lastMoveAt=0;
    this.touchAction=video.style.touchAction;
    this.cursor=video.style.cursor;
    this.onDown=e=>{
      if(!this.enabled||this.activeId!==null||!e.isPrimary||e.button!==0)return;
      const pos=mapPoint(this.video,this.size,e.clientX,e.clientY);
      if(!pos)return;
      e.preventDefault();
      this.activeId=e.pointerId;this.last=pos;this.lastMoveAt=0;
      try{this.video.setPointerCapture(e.pointerId);}catch{}
      this.send({type:'touch',action:'down',...pos});
    };
    this.onMove=e=>{
      if(!this.enabled||this.activeId!==e.pointerId)return;
      e.preventDefault();
      const pos=mapPoint(this.video,this.size,e.clientX,e.clientY,true);
      if(!pos){this.cancel();return;}
      const now=typeof e.timeStamp==='number'?e.timeStamp:0;
      if(this.lastMoveAt&&now-this.lastMoveAt<16)return;
      this.lastMoveAt=now;this.last=pos;
      this.send({type:'touch',action:'move',...pos});
    };
    this.onUp=e=>this.release(e,'up');
    this.onCancel=e=>this.release(e,'cancel');
    this.onLost=e=>{if(this.activeId===e.pointerId)this.cancel();};
    this.onBlur=()=>this.cancel();
    this.onResize=()=>{
      if(this.enabled&&this.size&&(this.video.videoWidth!==this.size.width||
          this.video.videoHeight!==this.size.height))this.cancel({send:false});
    };
    video.addEventListener('pointerdown',this.onDown);
    video.addEventListener('pointermove',this.onMove);
    video.addEventListener('pointerup',this.onUp);
    video.addEventListener('pointercancel',this.onCancel);
    video.addEventListener('lostpointercapture',this.onLost);
    video.addEventListener('resize',this.onResize);
    root.addEventListener('blur',this.onBlur);
  }
  release(e,action){
    if(this.activeId===null||this.activeId!==e.pointerId)return;
    e.preventDefault();
    if(!this.size||this.video.videoWidth!==this.size.width||this.video.videoHeight!==this.size.height){
      this.cancel({send:false});return;
    }
    const pos=mapPoint(this.video,this.size,e.clientX,e.clientY,true)||this.last;
    const pointer=this.activeId;
    this.activeId=null;this.last=null;
    try{this.video.releasePointerCapture(pointer);}catch{}
    if(pos)this.send({type:'touch',action,...pos});
  }
  cancel({send=true}={}){
    if(this.activeId===null)return;
    const pointer=this.activeId,pos=this.last;
    this.activeId=null;this.last=null;
    try{this.video.releasePointerCapture(pointer);}catch{}
    // Decoded dimensions may change before the resize event is delivered.
    // Never finish that old gesture with coordinates for the previous frame.
    if(pos&&send&&this.size&&this.video.videoWidth===this.size.width&&
        this.video.videoHeight===this.size.height)this.send({type:'touch',action:'cancel',...pos});
  }
  setGeometry(size){
    if(!size||!Number.isInteger(size.width)||!Number.isInteger(size.height)||
      size.width<1||size.height<1||size.width>8192||size.height>8192)return false;
    if(this.size&&this.size.width===size.width&&this.size.height===size.height)return true;
    // The server clears its old gesture state before changing geometry. Cancel
    // locally without sending stale coordinates back into the new geometry.
    // Merely learning a new size must never enable remote control.
    this.cancel({send:false});
    this.size={width:size.width,height:size.height};
    this.lastMoveAt=0;
    return true;
  }
  enable(size){
    if(!this.setGeometry(size))throw Error('投屏尺寸无效，无法启用鼠标控制');
    this.enabled=true;
    this.video.style.touchAction='none';this.video.style.cursor='crosshair';
  }
  disable(){
    this.cancel();this.enabled=false;this.size=null;
    this.video.style.touchAction=this.touchAction;this.video.style.cursor=this.cursor;
  }
  destroy(){
    this.disable();
    const v=this.video;
    v.removeEventListener('pointerdown',this.onDown);
    v.removeEventListener('pointermove',this.onMove);
    v.removeEventListener('pointerup',this.onUp);
    v.removeEventListener('pointercancel',this.onCancel);
    v.removeEventListener('lostpointercapture',this.onLost);
    v.removeEventListener('resize',this.onResize);
    root.removeEventListener('blur',this.onBlur);
  }
}
root.EasyADBTouch=Object.freeze({mapPoint,create:(video,send)=>new TouchController(video,send)});
})(window);
