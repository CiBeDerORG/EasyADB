// Bounded per-page startup queue; never owns server sessions or media resources.
export function createLiveBatchScheduler({launch,onLaunchFailure,onIdle,onChange,
 maxStarting=3,opening=false,launchQueue=[],launchInFlight=0,launchGeneration=0}) {
 const state={maxStarting,opening,launchQueue,launchInFlight,launchGeneration};
 const scheduler={
  get maxStarting(){return state.maxStarting;},set maxStarting(v){state.maxStarting=v;},
  get opening(){return state.opening;},set opening(v){state.opening=v;},
  get launchQueue(){return state.launchQueue;},set launchQueue(v){state.launchQueue=v;},
  get launchInFlight(){return state.launchInFlight;},set launchInFlight(v){state.launchInFlight=v;},
  get launchGeneration(){return state.launchGeneration;},set launchGeneration(v){state.launchGeneration=v;},
  begin(batch) {
   if(state.opening) return false;
   state.opening=true;
   state.launchGeneration++;
   state.launchInFlight=0;
   state.launchQueue=[...batch];
   return true;
  },
  pump(){
   if(!state.opening)return;
   const generation=state.launchGeneration;
   while(state.launchInFlight<state.maxStarting&&state.launchQueue.length){
    const next=state.launchQueue.shift();
    state.launchInFlight++;
    let settled=false;
    const finished=()=>{
     if(settled)return;
     settled=true;
     if(generation!==state.launchGeneration)return;
     state.launchInFlight=Math.max(0,state.launchInFlight-1);
     scheduler.pump();
    };
    try {launch(next,finished);}
    catch(error){onLaunchFailure(next,error);finished();}
   }
   if(!state.launchQueue.length&&!state.launchInFlight){
    state.opening=false;
    onIdle();
   }
   onChange();
  }
 };
 return scheduler;
}
