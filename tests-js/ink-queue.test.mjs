import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createInkQueue} from '../src/ink-queue.mjs';
import {createLocalStateStore} from '../src/local-state.mjs';

const batch=(extra={})=>({paperId:'paper',parentId:'parent',page:1,annotation_id:randomUUID(),revision:1,paths:[[[20,30],[40,50]]],width:2,color:'#2455a4',...extra});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function fixture(t,{write,parent,storeWrap}={}){
  const root=await mkdtemp(join(tmpdir(),'ink-queue-')),library=join(root,'library');await mkdir(library);
  const store=createLocalStateStore({library,home:join(root,'home')}),queues=[],calls=[],saved=new Map();
  const dispatch=async(input,options)=>{
    assert.equal(options.signal,undefined,'Host writes are independent of browser cancellation');
    if(input.action==='page_layout')return {pages:[{page:1,width:500,height:700},{page:2,width:500,height:700}]};
    if(input.action==='handwriting_get')return parent?parent(input):{annotation:{id:input.annotation_id,page:1,linked_ink:{annotations:[...saved.values()].filter(a=>a.parent_id===input.annotation_id&&a.paperId===input.id)}}};
    assert.equal(input.action,'annotate');calls.push(structuredClone(input));
    if(write)await write(input);
    const existing=saved.get(input.annotation_id),annotation=existing||{id:input.annotation_id,paperId:input.id,page:input.page,paths:input.paths,width:input.width,color:{stroke:[.1,.2,.3],fill:[]},parent_id:input.parent_id,type:'ink'};
    saved.set(input.annotation_id,annotation);return {annotation,...(existing?{duplicate:true}:{})};
  };
  const make=(extra={})=>{const queue=createInkQueue({store:storeWrap?storeWrap(store):store,dispatch,library,autoStart:false,...extra});queues.push(queue);return queue;};
  t.after(async()=>{await Promise.all(queues.map(queue=>queue.dispose()));await rm(root,{recursive:true,force:true});});
  return {root,library,store,make,calls,saved,dispatch};
}

test('enqueue confirms immutable durable staging before a detached slow write finishes',async t=>{
  const gate=deferred(),started=deferred(),f=await fixture(t,{write:async()=>{started.resolve();await gate.promise;}}),queue=f.make(),value=batch();
  const accepted=await queue.enqueue({batch:value});assert.equal(accepted.job.status,'queued');assert.deepEqual(accepted.job.batch,value);
  value.paths[0][0][0]=99;
  const running=queue.idle();await started.promise;
  assert.equal((await queue.list({id:'paper'})).jobs[0].status,'writing');
  assert.equal(f.calls[0].paths[0][0][0],20);gate.resolve();await running;
  assert.equal((await queue.list({id:'paper'})).jobs[0].status,'saved');
  const retry=await queue.enqueue({batch:accepted.job.batch});assert.equal(retry.duplicate,true);await queue.idle();assert.equal(f.calls.length,1);
  await assert.rejects(queue.enqueue({batch:{...accepted.job.batch,color:'#ffffff'}}),error=>error.code==='INK_QUEUE_ID_CONFLICT');
});

test('one global writer serializes papers; unknown outcome blocks only its paper',async t=>{
  let failed=false,active=0,max=0;const f=await fixture(t,{write:async input=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,5));active--;if(input.id==='paper'&&!failed){failed=true;throw new Error('Lost acknowledgment');}}}),queue=f.make();
  const a=batch(),b=batch(),c=batch({paperId:'other'});
  await queue.enqueue({batch:a});await queue.enqueue({batch:b});await queue.enqueue({batch:c});await queue.idle();
  let jobs=(await queue.list({})).jobs;
  assert.equal(jobs.find(j=>j.annotation_id===a.annotation_id).status,'uncertain');
  assert.equal(jobs.find(j=>j.annotation_id===b.annotation_id).status,'queued');
  assert.equal(jobs.find(j=>j.annotation_id===c.annotation_id).status,'saved');assert.equal(max,1);
  await queue.retry({annotation_id:a.annotation_id});await queue.idle();jobs=(await queue.list({})).jobs;
  assert.ok(jobs.every(job=>job.status==='saved'));assert.deepEqual(f.calls.filter(v=>v.annotation_id===a.annotation_id)[0],f.calls.filter(v=>v.annotation_id===a.annotation_id)[1]);
});

test('queued work resumes after host reconstruction; interrupted writes require same-ID retry',async t=>{
  const f=await fixture(t),first=f.make(),value=batch();await first.enqueue({batch:value});await first.dispose();
  const restarted=f.make();await restarted.idle();assert.equal((await restarted.list({})).jobs[0].status,'saved');
  const next=batch({attempted:true});await restarted.enqueue({batch:next});await restarted.dispose();
  let record=await f.store.get('ink-queue:index');record.value.jobs.find(j=>j.annotation_id===next.annotation_id).status='writing';
  Object.assign(record.value.jobs.find(j=>j.annotation_id===next.annotation_id),{pid:99999999,owner:'stopped-host'});
  await f.store.put(record.key,record.value,record.revision);
  const again=f.make();const restored=await again.list({});assert.equal(restored.jobs.find(j=>j.annotation_id===next.annotation_id).status,'uncertain');
  await again.idle();assert.equal(f.calls.length,1);await again.retry({annotation_id:next.annotation_id});await again.idle();assert.equal(f.calls.length,2);
});

test('two queue owners use CAS and preserve both browsers batches without concurrent writes',async t=>{
  let active=0,max=0;const f=await fixture(t,{write:async()=>{max=Math.max(max,++active);await new Promise(r=>setTimeout(r,5));active--;}}),a=f.make(),b=f.make();
  const values=[batch(),batch(),batch({paperId:'other'}),batch({paperId:'other'})];
  await Promise.all(values.map((value,i)=>(i%2?a:b).enqueue({batch:value})));await Promise.all([a.idle(),b.idle()]);
  await a.idle();assert.equal(new Set(f.calls.map(v=>v.annotation_id)).size,4);assert.equal(f.calls.length,4);assert.equal(max,1);
});

test('batch, paper, global and parent reservations reject without replacing prior jobs',async t=>{
  const f=await fixture(t),queue=f.make();
  for(const extra of [{paths:[]},{paths:[[[NaN,1],[2,3]]]},{width:9},{page:3},{paths:Array.from({length:65},()=>[[1,2],[3,4]])},{paths:[Array.from({length:4097},()=>[1,2])]}])await assert.rejects(queue.enqueue({batch:batch(extra)}));
  for(let i=0;i<8;i++)await queue.enqueue({batch:batch({attempted:true})});
  await assert.rejects(queue.enqueue({batch:batch({attempted:true})}),error=>error.code==='INK_QUEUE_LIMIT');
  for(let i=0;i<8;i++)await queue.enqueue({batch:batch({paperId:'other',attempted:true})});
  await assert.rejects(queue.enqueue({batch:batch({paperId:'third'})}),error=>error.code==='INK_QUEUE_LIMIT');
  assert.equal((await queue.list({})).usage.batches,16);
  const g=await fixture(t),second=g.make();for(let i=0;i<4;i++)await second.enqueue({batch:batch({paperId:'paper'+i,attempted:true})});
  await assert.rejects(second.enqueue({batch:batch({paperId:'fifth'})}),error=>error.code==='INK_QUEUE_LIMIT');
});

test('parent quota includes saved geometry and all accepted pending batches',async t=>{
  const annotation={page:1,linked_ink:{annotations:[{id:'existing',paths:Array.from({length:127},()=>[[1,2],[3,4]]),width:2,color:{stroke:[0,0,0]}}]}};
  const f=await fixture(t,{parent:()=>({annotation})}),queue=f.make();
  await queue.enqueue({batch:batch({attempted:true})});
  await assert.rejects(queue.enqueue({batch:batch({attempted:true})}),error=>error.code==='INK_QUEUE_LIMIT');
  assert.equal((await queue.list({})).usage.batches,1);
});

test('failed staging never starts a PDF write and same-ID retry recovers its reservation',async t=>{
  let refuse=true;const f=await fixture(t,{storeWrap:store=>({...store,put:async(key,...args)=>{if(key.startsWith('ink-queue:slot:')&&refuse)throw new Error('Disk unavailable');return store.put(key,...args);}})}),queue=f.make(),value=batch();
  await assert.rejects(queue.enqueue({batch:value}),/Disk unavailable/);await queue.idle();assert.equal(f.calls.length,0);
  refuse=false;await queue.enqueue({batch:value});await queue.idle();assert.equal(f.calls.length,1);
});

test('PDF completion with failed receipt remains reconcilable with original request',async t=>{
  let refuse=true;const f=await fixture(t,{storeWrap:store=>({...store,put:async(key,value,revision)=>{if(key==='ink-queue:index'&&value.jobs.some(j=>j.status==='saved')&&refuse)throw new Error('Receipt disk error');return store.put(key,value,revision);}})}),queue=f.make(),value=batch();
  await queue.enqueue({batch:value});await assert.rejects(queue.idle(),/Receipt disk error/);
  assert.equal(f.saved.size,1);refuse=false;assert.equal((await queue.list({})).jobs[0].status,'uncertain');
  await queue.retry({annotation_id:value.annotation_id});await queue.idle();assert.equal(f.saved.size,1);assert.equal(f.calls.length,2);
});

test('saved receipts and payload slots are bounded and outside browser state namespace',async t=>{
  const f=await fixture(t),queue=f.make();for(let i=0;i<35;i++){await queue.enqueue({batch:batch({parentId:undefined})});await queue.idle();}
  const listed=await queue.list({});assert.equal(listed.jobs.length,16);assert.equal(listed.usage.batches,0);
  const index=await f.store.get('ink-queue:index');assert.ok(index.value.jobs.length<=16);
  const all=await f.store.list({prefix:'ink-queue:',limit:50});assert.ok(all.total<=33);
});

test('listing retries when another host retires a receipt and reuses its payload slot',async t=>{
  const f=await fixture(t),writer=f.make();
  for(let i=0;i<16;i++){await writer.enqueue({batch:batch({parentId:undefined})});await writer.idle();}
  const index=await f.store.get('ink-queue:index'),oldest=[...index.value.jobs].sort((a,b)=>a.updatedAt-b.updatedAt)[0];
  const next=batch({attempted:true});delete next.parentId;let replaced=false;
  const reader=f.make({store:{...f.store,get:async key=>{
    if(key==='ink-queue:slot:'+oldest.slot&&!replaced){
      replaced=true;await writer.enqueue({batch:batch({parentId:undefined})});await writer.idle();
      await writer.enqueue({batch:next});
    }
    return f.store.get(key);
  }}});
  const listed=await reader.list({});assert.equal(replaced,true);
  assert.equal(listed.jobs.some(job=>job.annotation_id===oldest.annotation_id),false);
  assert.deepEqual(listed.jobs.find(job=>job.annotation_id===next.annotation_id).batch,next);
  assert.equal(listed.jobs.length,17);
});

test('geometry-limited listing retains all pending batches and complete compact saved receipts',async t=>{
  const f=await fixture(t),queue=f.make(),paths=[Array.from({length:4000},()=>[10.123,20.567])];
  for(let i=0;i<16;i++){await queue.enqueue({batch:batch({parentId:undefined,paths})});await queue.idle();}
  const pending=[];
  for(let i=0;i<16;i++){
    const value=batch({paperId:'pending-'+Math.floor(i/4),parentId:undefined,paths,attempted:true});
    pending.push(value.annotation_id);await queue.enqueue({batch:value});
  }
  await assert.rejects(queue.enqueue({batch:batch({paperId:'pending-0',parentId:undefined})}),error=>error.code==='INK_QUEUE_LIMIT');
  const listed=await queue.list({});assert.equal(listed.truncated,true);
  assert.equal(listed.usage.batches,16);assert.deepEqual(listed.jobs.map(job=>job.annotation_id),pending);
  assert.equal(listed.receipts.length,32);assert.equal(listed.receipts.filter(receipt=>receipt.status==='saved').length,16);
  assert.ok(listed.receipts.every(receipt=>Object.keys(receipt).every(key=>['annotation_id','paperId','status','updatedAt','error'].includes(key))));
  assert.ok(Buffer.byteLength(JSON.stringify(listed.jobs.map(job=>job.batch)))<=1024*1024);
  const scoped=await queue.list({id:'pending-0'});assert.equal(scoped.receipts.length,4);
  assert.ok(scoped.receipts.every(receipt=>receipt.paperId==='pending-0'));
});
