/* Local bounded diagnostics, sampled at transitions, never on pointermove. */
(function(){
  'use strict';
  const EVENTS=new Set(['stroke_start','stroke_end','stroke_cancel','input_blocked','draft_clear','draft_restore','overlay_update','overlay_retire','page_install','page_defer','draft_changed','batch_freeze','batch_accepted','batch_saved','queue_status','queue_error']);
  function create({api,exportTimeoutMs=2000}) {
    const client=window.crypto.randomUUID(), recent=[];
    let pending=[],timer=null,inFlight=null,inFlightCount=0,lastError=null,disposed=false;
    function schedule(){if(!disposed&&timer===null&&pending.length)timer=setTimeout(()=>{timer=null;void flush();},2000);}
    function record(value){
      try {
        if(disposed||!value||!EVENTS.has(value.event))return;
        const event={event:value.event,client,time:Date.now()};
        for(const key of ['paperId','annotationId'])if(typeof value[key]==='string'&&/^[a-f0-9-]{8,64}$/.test(value[key]))event[key]=value[key];
        for(const key of ['page','strokes','points','revision','count'])if(Number.isSafeInteger(value[key])&&value[key]>=0&&value[key]<=10000000)event[key]=value[key];
        for(const key of ['reason','status'])if(typeof value[key]==='string'&&/^[a-zA-Z0-9_-]{1,64}$/.test(value[key]))event[key]=value[key];
        if(['pen','mouse','touch','unknown'].includes(value.pointerType))event.pointerType=value.pointerType;
        recent.push(event);if(recent.length>256)recent.shift();pending.push(event);if(pending.length>128)pending.shift();schedule();
      }catch{/* Diagnostics must never interrupt drawing. */}
    }
    function flush(){
      if(inFlight)return inFlight;if(!pending.length)return Promise.resolve();
      const events=pending.splice(0,32);inFlightCount=events.length;
      inFlight=Promise.resolve().then(()=>api('ink_diagnostics_append',{events})).then(()=>{lastError=null;},error=>{lastError=error;pending=[...events,...pending].slice(-128);}).finally(()=>{inFlight=null;inFlightCount=0;schedule();});
      return inFlight;
    }
    async function exportReport(){
      let host=null,timeout;
      try{host=await Promise.race([(async()=>{await flush();return api('ink_diagnostics_get');})(),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('诊断主机暂未响应，已导出本机记录。')),Number.isFinite(exportTimeoutMs)?Math.max(10,Math.min(10000,exportTimeoutMs)):2000);})]);if(!pending.length&&!inFlight)lastError=null;}
      catch(error){lastError=error;}finally{clearTimeout(timeout);}
      return {schema:1,exportedAt:new Date().toISOString(),host,client:{id:client,events:recent.map(event=>({...event})),pending:pending.length+inFlightCount,hostAvailable:!lastError}};
    }
    return {record,flush,exportReport,dispose(){disposed=true;if(timer!==null)clearTimeout(timer);timer=null;}};
  }
  window.PaperInkDiagnostics=Object.freeze({create});
})();
