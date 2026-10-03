import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createInkQueue} from '../src/ink-queue.mjs';
import {createLocalStateStore} from '../src/local-state.mjs';
import {createFetchHandler} from '../src/http.mjs';
import {dispatch} from '../src/bridge.mjs';

const run=promisify(execFile),digest=value=>createHash('sha256').update(value).digest('hex');
const request=(input,signal)=>new Request('http://localhost/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input),...(signal?{signal}:{})});
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'ink-queue-http-')),library=join(root,'library');await mkdir(library);const store=createLocalStateStore({library,home:join(root,'home')});return {root,library,store};}

test('HTTP stages before delayed work, ignores request abort, protects queue state and advertises capability',async t=>{
  const f=await fixture(t);let release;const gate=new Promise(r=>release=r),calls=[];
  const worker=async(input,options)=>{assert.equal(options.signal,undefined);if(input.action==='page_layout')return {pages:[{page:1,width:500,height:700}]};calls.push(input);await gate;return {annotation:{id:input.annotation_id,page:1,type:'ink'}};};
  const queue=createInkQueue({store:f.store,dispatch:worker,library:f.library,autoStart:false}),handler=createFetchHandler({library:f.library,localState:f.store,inkQueue:queue});
  t.after(async()=>{release();await queue.dispose();await rm(f.root,{recursive:true,force:true});});
  const controller=new AbortController(),batch={paperId:'synthetic',page:1,annotation_id:randomUUID(),revision:1,paths:[[[20,30],[40,50]]],width:2,color:'#ABCDEF'};
  const response=await handler(request({action:'ink_queue_enqueue',batch},controller.signal));assert.equal(response.status,200);
  const accepted=(await response.json()).result;assert.equal(accepted.job.status,'queued');assert.equal(accepted.job.batch.color,'#ABCDEF');controller.abort();
  const running=queue.idle();release();await running;assert.equal(calls.length,1);
  const list=await (await handler(request({action:'ink_queue_list',id:'synthetic'}))).json();assert.equal(list.result.jobs[0].status,'saved');
  const forged=await handler(request({action:'state_put',key:'ink-queue:index',value:null,expected_revision:0}));assert.equal(forged.status,403);
  const status=await (await handler(request({action:'status'}))).json();assert.equal(status.result.durable_ink_queue,true);
  assert.equal((await handler(request({action:'ink_queue_delete',annotation_id:batch.annotation_id}))).status,400);
});

test('native PDF lost acknowledgment retries once without duplicate Ink, preserves source and external annotations',async t=>{
  const f=await fixture(t),source=join(f.root,'synthetic.pdf');
  await run('uv',['run','python','-c',`import pymupdf,sys\ndoc=pymupdf.open();page=doc.new_page(width=500,height=700);page.insert_text((50,60),'Synthetic queued handwriting');page.add_text_annot((200,200),'External note');doc.save(sys.argv[1])`,source]);
  const original=digest(await readFile(source)),options={library:f.library};
  const item=(await dispatch({action:'import',path:source},options)).items[0];
  const parent=(await dispatch({action:'annotate',id:item.id,page:1,type:'highlight',rects:[[50,45,220,65]],text:'Synthetic queued handwriting'},options)).annotation;
  let lose=true,writes=0;
  const worker=async(input,opts)=>{const result=await dispatch(input,opts);if(input.action==='annotate'){writes++;if(lose){lose=false;throw new Error('Synthetic lost native response');}}return result;};
  const queue=createInkQueue({store:f.store,dispatch:worker,library:f.library,autoStart:false});
  t.after(async()=>{await queue.dispose();await rm(f.root,{recursive:true,force:true});});
  const batch={paperId:item.id,parentId:parent.id,page:1,annotation_id:randomUUID(),revision:1,paths:[[[40,90],[80,130],[110,100]]],width:2,color:'#2455a4'};
  await queue.enqueue({batch});await queue.idle();assert.equal((await queue.list({})).jobs[0].status,'uncertain');
  const managed=(await dispatch({action:'export_pdf',id:item.id},options)).path,beforeRetry=digest(await readFile(managed));
  await queue.retry({annotation_id:batch.annotation_id});await queue.idle();
  assert.equal(writes,2);assert.equal(digest(await readFile(managed)),beforeRetry);assert.equal(digest(await readFile(source)),original);
  const annotations=(await dispatch({action:'annotations',id:item.id},options)).annotations;
  assert.equal(annotations.filter(a=>a.id===batch.annotation_id).length,1);
  assert.equal(annotations.find(a=>a.id===batch.annotation_id).parent_id,parent.id);
  assert.ok(annotations.some(a=>a.comment==='External note'));
  assert.equal((await queue.list({})).jobs[0].status,'saved');
});
