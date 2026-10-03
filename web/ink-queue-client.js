'use strict';

/** The browser freezes input; only the host owns the PDF write lifecycle. */
window.PaperInkQueueClient = (() => {
  const copy = value => JSON.parse(JSON.stringify(value));
  const labels = {staging:'正在暂存，请暂勿关闭',stage_failed:'尚未暂存，笔迹已保留',queued:'笔迹已暂存，等待写入 PDF',writing:'笔迹已暂存，正在写入 PDF',uncertain:'保存待确认，笔迹已保留',saved:'已保存到 PDF'};
  function create({api,persistence,onChange,onAccepted,onSaved,onError}) {
    const jobs=new Map(), notified=new Set(),acceptances=new Map();let unaccepted=null,stagePromise=null,stageId=null,pollPromise=null,timer=null,disposed=false,lastPublished='',ready=false;
    const normalize=job=>({...copy(job.batch),status:job.status,...(job.error?{error:job.error}:{}),updatedAt:job.updatedAt});
    const records=()=>[...jobs.values()].map(copy);
    const emit=()=>{const value=records(),key=JSON.stringify(value);if(key===lastPublished)return;lastPublished=key;try{onChange?.(value);}catch(error){onError?.(error);}};
    function schedule(){clearTimeout(timer);if(!disposed&&[...jobs.values()].some(job=>['queued','writing'].includes(job.status)))timer=setTimeout(()=>void refresh().catch(onError),700);}
    function accept(job){
      const value=normalize(job),previous=jobs.get(value.annotation_id);
      if(previous?.status==='saved'&&value.status!=='saved'||previous?.updatedAt&&value.updatedAt&&previous.updatedAt>value.updatedAt)return;
      jobs.set(value.annotation_id,value);
      if(value.status==='saved'&&!notified.has(value.annotation_id)){notified.add(value.annotation_id);while(notified.size>64)notified.delete(notified.values().next().value);queueMicrotask(()=>Promise.resolve().then(()=>onSaved?.(copy(value))).catch(error=>{notified.delete(value.annotation_id);onError?.(error);}));}
    }
    async function refresh(){
      if(pollPromise)return pollPromise;
      pollPromise=(async()=>{
        const result=await api('ink_queue_list'),full=result.receipts||result.jobs;
        const keep=new Set(full.map(job=>job.annotation_id)),bodies=new Set(result.jobs.map(job=>job.annotation_id));
        for(const [id,job] of jobs)if(!keep.has(id)&&id!==unaccepted?.annotation_id&&!result.truncated){if(job.status==='saved')jobs.delete(id);else jobs.set(id,{...job,status:'uncertain',error:{message:'保存回执待核对，请按原身份重试。'}});}
        // A previous enqueue acknowledgement may have been lost. Do not clear
        // the local handoff until the host confirms the exact frozen request.
        const acceptedBody=unaccepted&&result.jobs.find(job=>job.annotation_id===unaccepted.annotation_id);
        if(acceptedBody)await settleAccepted(acceptedBody);
        for(const job of result.jobs)accept(job);
        for(const receipt of full)if(!bodies.has(receipt.annotation_id)&&jobs.has(receipt.annotation_id)&&receipt.annotation_id!==unaccepted?.annotation_id)accept({...receipt,batch:jobs.get(receipt.annotation_id)});
        ready=true;
        if(result.error)onError?.(new Error(`暂存任务状态待确认：${result.error.message}`));
        emit();schedule();return records();
      })().finally(()=>{pollPromise=null;});
      return pollPromise;
    }
    function settleAccepted(job){
      if(acceptances.has(job.annotation_id))return acceptances.get(job.annotation_id);
      if(!unaccepted||job.annotation_id!==unaccepted.annotation_id)return Promise.resolve();
      const sent=unaccepted, remote=job.batch;
      for(const key of ['paperId','parentId','page','annotation_id','revision','paths','width','color'])if(JSON.stringify(sent[key])!==JSON.stringify(remote[key]))return Promise.reject(new Error('暂存身份冲突，原笔迹已保留，请导出后核对。'));
      // Queue acceptance is durable. Invoke cleanup before allowing another
      // draft so clearing the legacy slot cannot race a newer stroke.
      const promise=Promise.resolve().then(()=>onAccepted?.(copy(sent))).then(()=>{if(unaccepted===sent)unaccepted=null;accept(job);}).finally(()=>acceptances.delete(job.annotation_id));
      acceptances.set(job.annotation_id,promise);return promise;
    }
    function stage(){
      if(!unaccepted)return Promise.resolve(true);
      if(stagePromise&&stageId===unaccepted.annotation_id)return stagePromise;
      const batch=copy(unaccepted);jobs.set(batch.annotation_id,{...batch,status:'staging'});emit();
      stageId=batch.annotation_id;
      stagePromise=(async()=>{
        try{
          const draft={paperId:batch.paperId,page:batch.page,paths:batch.paths,width:batch.width,color:batch.color,revision:batch.revision,...(batch.parentId?{parentId:batch.parentId}:{})};
          await persistence?.put('reader:ink-draft',{draft,annotation_id:batch.annotation_id,attempted:batch.attempted===true,frozen:true,updatedAt:batch.frozenAt});
          const {frozenAt,...request}=batch;
          const result=await api('ink_queue_enqueue',{batch:request});await settleAccepted(result.job);emit();schedule();return true;
        }catch(error){if(unaccepted?.annotation_id===batch.annotation_id){jobs.set(batch.annotation_id,{...batch,status:'stage_failed',error:{message:error.message}});emit();onError?.(error);}return false;}
      })().finally(()=>{if(stageId===batch.annotation_id){stagePromise=null;stageId=null;}});return stagePromise;
    }
    function freeze(draft,annotationId,{attempted=false,updatedAt=Date.now()}={}){
      if(unaccepted)throw new Error('上一份笔迹尚未暂存，请重试或导出；仍可继续阅读。');
      if(!draft?.paths?.length)return false;
      const batch=copy({...draft,annotation_id:annotationId,attempted,frozenAt:updatedAt});
      if(new TextEncoder().encode(JSON.stringify(batch)).byteLength>128*1024)throw new Error('本批笔迹超过 128 KiB，请保留草稿后分批保存。');
      unaccepted=batch;jobs.set(annotationId,{...batch,status:'staging'});emit();
      // Let the completion event restore the tool and publish the handoff first.
      queueMicrotask(()=>void stage());return true;
    }
    async function retry(annotationId){
      if(unaccepted?.annotation_id===annotationId)return stage();
      let result;try{result=await api('ink_queue_retry',{annotation_id:annotationId});}catch(error){
        const existing=jobs.get(annotationId);if(error.code!=='INK_QUEUE_MISSING'||!existing)throw error;
        const {paperId,parentId,page,annotation_id,revision,paths,width,color}=existing;
        result=await api('ink_queue_enqueue',{batch:{paperId,...(parentId?{parentId}:{}),page,annotation_id,revision,paths,width,color}});
      }accept(result.job);emit();schedule();return true;
    }
    const handoff=()=>unaccepted?{draft:{paperId:unaccepted.paperId,page:unaccepted.page,paths:copy(unaccepted.paths),width:unaccepted.width,color:unaccepted.color,revision:unaccepted.revision,...(unaccepted.parentId?{parentId:unaccepted.parentId}:{})},annotation_id:unaccepted.annotation_id,attempted:unaccepted.attempted===true,frozen:true,updatedAt:unaccepted.frozenAt}:null;
    return {records,refresh,freeze,retry,handoff,blocked:()=>Boolean(unaccepted),hasPending:(paperId,parentId)=>!ready||[...jobs.values()].some(job=>job.paperId===paperId&&(!parentId||job.parentId===parentId)&&job.status!=='saved'),
      references:()=>[...jobs.values()].filter(job=>!['staging','stage_failed'].includes(job.status)).map(job=>({paperId:job.paperId,annotation_id:job.annotation_id})),
      dispose(){disposed=true;clearTimeout(timer);}};
  }
  return {create,label:status=>labels[status]||'笔迹已保留'};
})();
