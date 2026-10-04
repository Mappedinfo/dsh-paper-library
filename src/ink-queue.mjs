/** Recoverable staging, never an authoritative annotation catalog.
 * The manifest is CAS-written; 32 reusable payload slots bound private disk
 * usage. Only a manifest entry with a verified immutable payload can be run.
 * The worker deliberately receives no browser AbortSignal.
 */
import { createHash, randomUUID } from 'node:crypto';

const INDEX = 'ink-queue:index', SLOT = 'ink-queue:slot:';
const UUID = /^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/;
const activeOwners = new Set();
export const INK_QUEUE_LIMITS = Object.freeze({ batch_strokes:64, batch_points:4096, batch_bytes:128*1024,
  paper_batches:8, paper_bytes:256*1024, papers:4, batches:16, bytes:1024*1024,
  parent_objects:64, parent_strokes:128, parent_points:8192, parent_bytes:256*1024,
  saved_receipts:16, response_geometry_bytes:1024*1024 });
const size = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => structuredClone(value);
const idValue = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\u0000-\u001f]/.test(value);
function fail(message, code='INK_QUEUE_INVALID', status=400) { throw Object.assign(new Error(message), {code,status}); }
function limits(message) { fail(message, 'INK_QUEUE_LIMIT', 413); }
function batchValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !idValue(value.paperId) || value.parentId !== undefined && !idValue(value.parentId)) fail('笔迹需要有效的论文和父批注身份。');
  if (!Number.isSafeInteger(value.page) || value.page < 1 || value.page > 2000 || !UUID.test(value.annotation_id || '') || !Number.isSafeInteger(value.revision) || value.revision < 0) fail('笔迹页面、修订或保存身份无效。');
  if (!Number.isFinite(value.width) || value.width < .5 || value.width > 8 || !/^#[a-f0-9]{6}$/i.test(value.color || '')) fail('笔迹颜色或粗细无效。');
  if (value.attempted !== undefined && typeof value.attempted !== 'boolean') fail('笔迹重试状态无效。');
  if (!Array.isArray(value.paths) || !value.paths.length || value.paths.length > 64) limits('每批笔迹最多 64 笔。');
  let points=0;
  for (const stroke of value.paths) {
    if (!Array.isArray(stroke) || stroke.length < 2 || (points+=stroke.length)>4096) limits('每笔至少两个点，每批最多 4096 点。');
    if (stroke.some(point=>!Array.isArray(point)||point.length!==2||point.some(v=>!Number.isFinite(v)||v<0||v>100000))) fail('笔迹坐标必须是页面内的有限数值。');
  }
  const batch={paperId:value.paperId,...(value.parentId?{parentId:value.parentId}:{}),page:value.page,annotation_id:value.annotation_id,
    revision:value.revision,paths:clone(value.paths),width:value.width,color:value.color,...(value.attempted?{attempted:true}:{})};
  if(size(batch)>INK_QUEUE_LIMITS.batch_bytes) limits('单批笔迹超过 128 KiB，请保留原稿并分批保存。');
  return batch;
}
function fingerprint(batch) { const {attempted,revision,...request}=batch; return hash(request); }
function empty() { return {schema:1,jobs:[]}; }
function manifest(value) {
  if(value===null)return empty();
  if(value?.schema!==1 || !Array.isArray(value.jobs) || value.jobs.length>32)fail('手写队列记录损坏，已保留原记录。','INK_QUEUE_CORRUPT');
  const slots=new Set(),ids=new Set();
  for(const job of value.jobs){
    if(!UUID.test(job.annotation_id)||!idValue(job.paperId)||!Number.isInteger(job.slot)||job.slot<0||job.slot>=32||slots.has(job.slot)||ids.has(job.annotation_id)
      ||!['staging','queued','writing','saved','uncertain'].includes(job.status)||!/^[a-f0-9]{64}$/.test(job.hash)||!Number.isSafeInteger(job.bytes)||job.bytes<1||job.bytes>128*1024+256)fail('手写队列身份或状态损坏，已保留原记录。','INK_QUEUE_CORRUPT');
    slots.add(job.slot);ids.add(job.annotation_id);
  }
  return clone(value);
}
function usage(jobs) {
  const pending=jobs.filter(job=>job.status!=='saved'),papers=[...new Set(pending.map(job=>job.paperId))];
  return {papers:papers.length,batches:pending.length,bytes:pending.reduce((sum,job)=>sum+job.bytes,0),
    per_paper:papers.map(id=>({id,batches:pending.filter(job=>job.paperId===id).length,bytes:pending.filter(job=>job.paperId===id).reduce((sum,job)=>sum+job.bytes,0)}))};
}
function alive(job) {
  if(job.pid===process.pid)return activeOwners.has(job.owner);
  if(!Number.isSafeInteger(job.pid)||job.pid<1)return false;
  try{process.kill(job.pid,0);return true;}catch(error){return error.code==='EPERM';}
}

export function createInkQueue({store,dispatch,library,python,autoStart=true}={}) {
  if(!store?.get||!store?.put||typeof dispatch!=='function')throw new Error('Ink queue requires a CAS store and PDF dispatcher');
  const owner=randomUUID();activeOwners.add(owner);
  let serial=Promise.resolve(),worker=null,timer=null,stopped=false,lastError=null,inflightId=null,wakeRequested=false;
  const exclusive=fn=>{const promise=serial.catch(()=>{}).then(fn);serial=promise.catch(()=>{});return promise;};
  async function read(){const record=await store.get(INDEX);return {...record,value:manifest(record.value)};}
  async function change(fn){
    for(let attempt=0;attempt<8;attempt++){
      const record=await read(),next=clone(record.value),result=await fn(next);
      if(result===false)return {state:record.value,result};
      try{await store.put(INDEX,next,record.revision);return {state:next,result};}
      catch(error){if(error.code!=='STATE_CONFLICT'||attempt===7)throw error;}
    }
  }
  async function payload(job,optional=false){
    const record=await store.get(SLOT+job.slot),value=record.value;
    if(!value||value.annotation_id!==job.annotation_id||value.hash!==job.hash){if(optional)return null;fail('已暂存笔迹与队列身份不一致，原记录已保留。','INK_QUEUE_CORRUPT');}
    const batch=batchValue(value.batch);
    if(fingerprint(batch)!==job.hash||batch.paperId!==job.paperId||batch.page!==job.page||batch.parentId!==job.parentId)fail('暂存笔迹内容校验失败，原记录已保留。','INK_QUEUE_CORRUPT');
    return batch;
  }
  async function project(job){return {...Object.fromEntries(Object.entries(job).filter(([key])=>!['slot','hash','bytes','owner','pid'].includes(key))),batch:await payload(job)};}
  function reserveCapacity(jobs,batch){
    const current=usage([...jobs,{paperId:batch.paperId,status:'queued',bytes:size(batch)+256}]),paper=current.per_paper.find(v=>v.id===batch.paperId);
    if(current.papers>4||current.batches>16||current.bytes>1024*1024||paper.batches>8||paper.bytes>256*1024)limits('手写暂存队列已满；请先处理待保存笔迹，原笔迹不会被覆盖。');
  }
  async function validateParent(jobs,batch){
    const layout=await dispatch({action:'page_layout',id:batch.paperId},{library,python});
    const page=layout.pages?.find(value=>value.page===batch.page);
    if(!page||batch.paths.some(stroke=>stroke.some(([x,y])=>x>page.width||y>page.height)))fail('笔迹必须位于当前论文的有效页面内。');
    if(!batch.parentId)return;
    const {annotation}=await dispatch({action:'handwriting_get',id:batch.paperId,annotation_id:batch.parentId},{library,python});
    if(annotation?.page!==batch.page)fail('笔迹与父批注必须位于同一页。');
    const group=annotation.linked_ink;
    if(group?.truncated)limits('原关联笔迹超过完整读取上限，请先整理笔迹。');
    const combined=group?.annotations||[],ids=new Set(combined.map(value=>value.id));
    let objects=combined.length,strokes=combined.reduce((n,a)=>n+a.paths.length,0),points=combined.reduce((n,a)=>n+a.paths.reduce((p,s)=>p+s.length,0),0),bytes=size(combined);
    const pending=jobs.filter(job=>job.status!=='saved'&&job.paperId===batch.paperId&&job.parentId===batch.parentId);
    for(const job of pending){if(ids.has(job.annotation_id))continue;objects++;strokes+=job.strokes;points+=job.points;bytes+=job.nativeBytes;ids.add(job.annotation_id);}
    if(!ids.has(batch.annotation_id)){const counts=stats(batch);objects++;strokes+=counts.strokes;points+=counts.points;bytes+=counts.nativeBytes;}
    if(objects>64||strokes>128||points>8192||bytes>256*1024)limits('这条批注的已存与待存笔迹达到上限：64 组、128 笔、8192 点、256 KiB。');
  }
  function asNative(batch){return {id:batch.annotation_id,page:batch.page,paths:batch.paths,width:batch.width,color:{stroke:[1,3,5].map(i=>parseInt(batch.color.slice(i,i+2),16)/255),fill:[]}};}
  function stats(batch){const points=batch.paths.reduce((sum,stroke)=>sum+stroke.length,0);return {strokes:batch.paths.length,points,
    // Reserve for native float roundoff expansion, not merely short input ints.
    nativeBytes:Math.max(size(asNative(batch))+1,points*48+batch.paths.length*2+256)};}
  async function recover(){
    await change(async state=>{
      let changed=false;
      for(const job of state.jobs){
        if(job.status==='writing'&&(!alive(job)||job.owner===owner&&job.annotation_id!==inflightId)){Object.assign(job,{status:'uncertain',updatedAt:Date.now(),error:{code:'INK_WRITE_INTERRUPTED',message:'上次写入结果待确认，请按原身份重试。'}});delete job.owner;delete job.pid;changed=true;}
        if(job.status==='staging'){
          const batch=await payload(job,true);
          if(batch){job.status=batch.attempted?'uncertain':'queued';job.updatedAt=Date.now();if(batch.attempted)job.error={code:'INK_LEGACY_UNCONFIRMED',message:'原保存结果待确认，请重试核对。'};changed=true;}
        }
      }
      return changed||false;
    });
  }
  function finished(){worker=null;if(wakeRequested){wakeRequested=false;kick();}}
  function kick(delay=0){if(stopped)return;if(worker){wakeRequested=true;return;}if(timer)return;timer=setTimeout(()=>{timer=null;worker=run().catch(error=>{lastError={code:error.code||'INK_QUEUE_STORAGE',message:String(error.message).slice(0,600)};}).finally(finished);},delay);timer.unref?.();}
  async function run(){
    while(!stopped){
      const selected=await exclusive(async()=>{
        await recover();let selected;
        await change(state=>{
          selected=undefined;
          if(state.jobs.some(job=>job.status==='writing'&&alive(job)))return false;
          selected=state.jobs.find((job,index)=>job.status==='queued'&&!state.jobs.slice(0,index).some(earlier=>earlier.paperId===job.paperId&&earlier.status!=='saved'));
          if(!selected)return false;
          Object.assign(selected,{status:'writing',owner,pid:process.pid,updatedAt:Date.now()});return true;
        });inflightId=selected?.annotation_id||null;return selected;
      });
      if(!selected)break;
      let result,error;
      try{
        const batch=await payload(selected);
        result=await dispatch({action:'annotate',id:batch.paperId,page:batch.page,type:'ink',paths:batch.paths,width:batch.width,color:batch.color,
          author:'Reader',annotation_id:batch.annotation_id,...(batch.parentId?{parent_id:batch.parentId}:{})},{library,python});
        if(result?.annotation?.id!==batch.annotation_id)throw new Error('PDF 未返回相同的笔迹保存身份。');
      }catch(cause){error={code:cause.code||'INK_WRITE_UNCONFIRMED',message:String(cause.message||cause).slice(0,600)};}
      try{await exclusive(()=>change(state=>{
        const job=state.jobs.find(value=>value.annotation_id===selected.annotation_id);
        if(!job||job.status!=='writing'||job.owner!==owner)fail('手写队列写入所有权已变化，保留待确认状态。','STATE_CONFLICT',409);
        job.status=error?'uncertain':'saved';job.updatedAt=Date.now();delete job.owner;delete job.pid;
        if(error)job.error=error;
        else{delete job.error;job.annotation=Object.fromEntries(Object.entries(result.annotation).filter(([key,value])=>value!==undefined&&['id','page','type','kind','parent_id','rect','rects','width','color','created','modified','source'].includes(key)));}
        const completed=state.jobs.filter(value=>value.status==='saved');
        if(completed.length>16){const oldest=[...completed].sort((a,b)=>a.updatedAt-b.updatedAt).slice(0,completed.length-16);state.jobs=state.jobs.filter(value=>!oldest.includes(value));}
      }));lastError=null;}finally{inflightId=null;}
    }
    const state=(await read()).value;
    // Another host instance may own a write. Poll only while runnable work is
    // pending; uncertain papers remain paused until an explicit retry.
    if(!stopped&&state.jobs.some(job=>job.status==='queued')&&state.jobs.some(job=>job.status==='writing'))setTimeout(()=>kick(),250).unref?.();
  }
  async function enqueue(input){
    const batch=batchValue(input.batch),digest=fingerprint(batch);
    let result;
    try{result=await exclusive(async()=>{
      let duplicate=false;
      const reserved=await change(async state=>{
        const existing=state.jobs.find(job=>job.annotation_id===batch.annotation_id);
        if(existing){if(existing.hash!==digest)fail('保存身份已用于另一份笔迹，不能覆盖。','INK_QUEUE_ID_CONFLICT',409);duplicate=true;return false;}
        reserveCapacity(state.jobs,batch);await validateParent(state.jobs,batch);
        if(state.jobs.length>=32){const oldest=state.jobs.filter(job=>job.status==='saved').sort((a,b)=>a.updatedAt-b.updatedAt)[0];if(!oldest)limits('手写队列没有空闲位置。');state.jobs=state.jobs.filter(job=>job!==oldest);}
        const slots=new Set(state.jobs.map(job=>job.slot));let slot=0;while(slots.has(slot))slot++;
        const now=Date.now();state.jobs.push({annotation_id:batch.annotation_id,paperId:batch.paperId,...(batch.parentId?{parentId:batch.parentId}:{}),page:batch.page,
          slot,hash:digest,bytes:size(batch)+256,...stats(batch),status:'staging',createdAt:now,updatedAt:now});
      });
      let job=reserved.state.jobs.find(value=>value.annotation_id===batch.annotation_id);
      if(job.status==='staging'){
        const key=SLOT+job.slot,previous=await store.get(key);
        if(previous.value?.annotation_id===batch.annotation_id){if(previous.value.hash!==digest)fail('暂存身份与原笔迹不一致。','INK_QUEUE_ID_CONFLICT',409);}
        else try{await store.put(key,{annotation_id:batch.annotation_id,hash:digest,batch},previous.revision);}
        catch(error){
          // No acceptance was returned. Release an empty reservation only when
          // readback proves there is no durable payload; an unknown disk result
          // stays reserved and recoverable under the same immutable identity.
          try{if(!await payload(job,true))await change(state=>{const entry=state.jobs.find(v=>v.annotation_id===batch.annotation_id);if(entry?.status!=='staging')return false;state.jobs=state.jobs.filter(v=>v!==entry);});}catch{}
          throw error;
        }
        const frozen=await payload(job);
        const updated=await change(state=>{const saved=state.jobs.find(value=>value.annotation_id===batch.annotation_id);if(saved.status!=='staging')return false;saved.status=frozen.attempted?'uncertain':'queued';saved.updatedAt=Date.now();if(frozen.attempted)saved.error={code:'INK_LEGACY_UNCONFIRMED',message:'原保存结果待确认，请重试核对。'};});
        job=updated.state.jobs.find(value=>value.annotation_id===batch.annotation_id);
      }
      return {job:await project(job),...(duplicate?{duplicate:true}:{}),limits:INK_QUEUE_LIMITS};
    });}finally{kick();}
    return result;
  }
  async function list({id}={}){
    if(id!==undefined&&!idValue(id))fail('论文身份无效。');
    const result=await exclusive(async()=>{
      await recover();
      for(let attempt=0;attempt<8;attempt++){
        const record=await read(),state=record.value,all=state.jobs.filter(job=>id===undefined||job.paperId===id);
        // Pending jobs take priority over bounded recent completion receipts.
        const ordered=[...all.filter(job=>job.status!=='saved'),...all.filter(job=>job.status==='saved').sort((a,b)=>b.updatedAt-a.updatedAt)],jobs=[];let bytes=0;
        try{
          for(const job of ordered){const batch=await payload(job,job.status==='staging');if(!batch)continue;if(bytes+size(batch)>1024*1024)break;jobs.push({...Object.fromEntries(Object.entries(job).filter(([key])=>!['slot','hash','bytes','owner','pid'].includes(key))),batch});bytes+=size(batch);}
          // Receipts are complete even when the geometry budget omits older
          // saved batches. A client retaining that immutable geometry can still
          // confirm PDF completion without mistaking omission for deletion.
          const receipts=all.map(job=>({annotation_id:job.annotation_id,paperId:job.paperId,status:job.status,updatedAt:job.updatedAt,...(job.error?{error:clone(job.error)}:{})}));
          return {jobs,receipts,limits:INK_QUEUE_LIMITS,usage:usage(state.jobs),truncated:jobs.length!==all.length,...(lastError?{error:lastError}:{})};
        }catch(error){
          // A second host can retire a saved receipt and reuse its slot during
          // this read. Retry from its newer manifest, but retain real corruption.
          if(error.code!=='INK_QUEUE_CORRUPT'||attempt===7||(await read()).revision===record.revision)throw error;
        }
      }
    });kick();return result;
  }
  async function retry({annotation_id}){
    if(!UUID.test(annotation_id||''))fail('重试需要原笔迹保存身份。');
    const result=await exclusive(async()=>{
      const changed=await change(async state=>{
        const job=state.jobs.find(value=>value.annotation_id===annotation_id);if(!job)fail('暂存笔迹不存在，请保留原稿。','INK_QUEUE_MISSING',404);
        await payload(job);if(['queued','writing','saved'].includes(job.status))return false;
        job.status='queued';job.updatedAt=Date.now();delete job.error;
      });return {job:await project(changed.state.jobs.find(value=>value.annotation_id===annotation_id)),limits:INK_QUEUE_LIMITS};
    });kick();return result;
  }
  async function handle(input){if(input.action==='ink_queue_enqueue')return enqueue(input);if(input.action==='ink_queue_list')return list(input);if(input.action==='ink_queue_retry')return retry(input);fail('未知笔迹队列操作。');}
  async function dispose(){stopped=true;if(timer)clearTimeout(timer);timer=null;try{await worker;}finally{activeOwners.delete(owner);}}
  async function idle(){if(timer){clearTimeout(timer);timer=null;}if(!worker&&!stopped)worker=run().finally(finished);await worker;await serial;}
  if(autoStart)kick();
  return {handle,enqueue,list,retry,dispose,idle};
}
