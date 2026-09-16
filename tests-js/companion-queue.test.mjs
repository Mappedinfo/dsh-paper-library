import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createLocalStateStore} from '../src/local-state.mjs'
import {createCompanionQueue,companionQuestion} from '../src/harness/companion-queue.mjs'

async function fixture(t){
  t.mock.timers.enable({apis:['setTimeout']})
  const root=await mkdtemp(join(tmpdir(),'companion-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const store=createLocalStateStore({library:root,home:join(root,'home')});let enabled=true,failSend=false,feedback=[],running=true
  const calls=[],queues=[],notes=new Map(),contexts=[],sends=[]
  const settings={get:async()=>({available:true,value:{'auto-paper-conversation':enabled}})}
  async function paperChat(r){calls.push(r.action);if(r.action==='chat_catalog')return {annotations:[...notes.values()]};if(r.action==='chat_context'){contexts.push(r);return{snapshot_id:String(contexts.length).padStart(64,'a')}};if(r.action==='chat_send'){sends.push(r);if(failSend)throw Error('uncertain native admission');return{sessionId:'paper-session'}};if(r.action==='chat_history')return{feedback,running,queued:0};if(r.action==='chat_save_feedback')return{saved:{annotation_id:'reply'}};throw Error(r.action)}
  const make=()=>{const q=createCompanionQueue({store,settings,paperChat,dispatch:async r=>{calls.push(r.action);return{page:r.page,text:'Selected source only'}},library:root,delay:0});queues.push(q);return q}
  t.after(()=>queues.forEach(q=>q.dispose()))
  const note=(id,comment='A question')=>{const value={id,comment,text:'Source words',page:2,type:'note',version:comment.padEnd(64,'a').slice(0,64),identity_reliable:true};notes.set(id,value);return value}
  return{store,make,note,calls,contexts,sends,setEnabled:v=>enabled=v,setFail:v=>failSend=v,setFeedback:v=>feedback=v,setRunning:v=>running=v}
}
test('human save coalesces versions, ignores bare marks and AI replies, and preserves each distinct note',async t=>{
  const f=await fixture(t),q=f.make();
  await q.saved('paper-a',f.note('one','first'));await q.saved('paper-a',f.note('one','latest'));await q.saved('paper-a',f.note('two'));
  await q.saved('paper-a',{...f.note('ai'),kind:'ai-feedback'});await q.saved('paper-a',f.note('empty',''));
  await q.drain();assert.equal(f.sends.length,1);await q.feedback('paper-a',{status:'saved',message_id:'1',source_snapshot_ids:[f.sends[0].snapshot_id]});await q.drain();assert.equal(f.sends.length,2);assert.equal(f.contexts[0].annotation_refs[0].version,f.note('one','latest').version);
  assert.equal(f.contexts[0].selection.page,2);assert.match(f.contexts[0].question,/待验证/);assert.match(companionQuestion,/不执行实验/);
})
test('unstarted durable jobs survive a browser-independent service restart; paused settings suppress work',async t=>{
  const f=await fixture(t),q=f.make();await q.saved('paper-a',f.note('one'));q.dispose();f.setEnabled(false);
  const recovered=f.make();await recovered.drain();assert.equal(f.sends.length,0);f.setEnabled(true);await recovered.drain();assert.equal(f.sends.length,1)
})
test('uncertain admission is not retried automatically, explicit retry keeps snapshot and native request identity',async t=>{
  const f=await fixture(t),q=f.make();f.setFail(true);const row=await q.saved('paper-a',f.note('one'));await q.drain();await q.drain();assert.equal(f.sends.length,1);
  const failed=await q.handle({action:'companion_status',id:'paper-a'});assert.equal(failed.entries[0].status,'failed');
  f.setFail(false);await q.handle({action:'companion_retry',id:'paper-a',request_id:row.request_id});await q.drain();
  assert.deepEqual(f.sends[0],f.sends[1]);assert.equal(f.contexts.length,1)
})
test('saved feedback settles durable work, duplicate saves do not regenerate; PDF failures have explicit write-only retry',async t=>{
  const f=await fixture(t),q=f.make(),note=f.note('one');const row=await q.saved('paper-a',note);await q.drain();
  await q.feedback('paper-a',{status:'failed',message_id:'7',error:'PDF locked',source_snapshot_ids:[f.sends[0].snapshot_id]});
  await q.handle({action:'companion_retry',id:'paper-a',request_id:row.request_id});
  assert.equal((await q.saved('paper-a',note)).status,'saved');await q.drain();assert.equal(f.sends.length,1);assert.ok(f.calls.includes('chat_save_feedback'));
  assert.equal((await q.handle({action:'companion_status',id:'paper-a'})).entries[0].status,'saved')
})
test('interrupted preparing state remains visible after restart and does not auto-call the model',async t=>{
  const f=await fixture(t);await f.store.put('companion.queue:v1',{entries:[{id:'paper-a',annotation_id:'one',request_id:'interrupted',status:'preparing'}]},0);
  const q=f.make();await q.drain();assert.equal(f.sends.length,0);assert.equal((await q.handle({action:'companion_status',id:'paper-a'})).entries[0].status,'preparing')
})
test('completion from another snapshot cannot settle a pending note; cancellation only removes unsent work',async t=>{
  const f=await fixture(t),q=f.make();const row=await q.saved('paper-a',f.note('one'));
  await q.feedback('paper-a',{status:'saved',source_snapshot_ids:['unrelated']});
  await q.handle({action:'companion_cancel',id:'paper-a',request_id:row.request_id});await q.drain();assert.equal(f.sends.length,0)
})
test('a stopped native turn is visible, releases the queue, and only explicit regeneration creates a new request',async t=>{
  const f=await fixture(t),q=f.make(),row=await q.saved('paper-a',f.note('one'));await q.drain();
  await q.turnFailed('paper-a',[f.sends[0].snapshot_id],'aborted');await q.drain();assert.equal(f.sends.length,1);
  const state=await q.handle({action:'companion_status',id:'paper-a'});assert.equal(state.entries[0].status,'failed');
  await q.handle({action:'companion_retry',id:'paper-a',request_id:row.request_id});await q.drain();
  assert.notEqual(f.sends[0].request_id,f.sends[1].request_id);assert.equal(f.sends[0].snapshot_id,f.sends[1].snapshot_id)
})
test('restart reconciles already accepted replies without browser polling and admits the next note once',async t=>{
  const f=await fixture(t),q=f.make();await q.saved('paper-a',f.note('one'));await q.saved('paper-a',f.note('two'));await q.drain();q.dispose();
  f.setFeedback([{status:'saved',message_id:'1',source_snapshot_ids:[f.sends[0].snapshot_id]}]);
  const recovered=f.make();await recovered.drain();assert.equal(f.sends.length,2);assert.equal(f.contexts[1].annotation_refs[0].id,'two');
  assert.equal((await recovered.handle({action:'companion_status',id:'paper-a'})).entries.find(v=>v.annotation_id==='one').status,'saved')
})
test('restart exposes an idle interrupted turn for explicit retry without replaying its model request',async t=>{
  const f=await fixture(t),q=f.make();await q.saved('paper-a',f.note('one'));await q.drain();q.dispose();f.setRunning(false);
  const recovered=f.make();await recovered.drain();assert.equal(f.sends.length,1);
  const state=await recovered.handle({action:'companion_status',id:'paper-a'});assert.equal(state.entries[0].status,'failed');assert.equal(state.entries[0].regenerate,true)
})
test('clearing an unsent comment cancels it even while automation is paused',async t=>{
  const f=await fixture(t),q=f.make();await q.saved('paper-a',f.note('one'));f.setEnabled(false);
  await q.saved('paper-a',f.note('one',''));f.setEnabled(true);await q.drain();assert.equal(f.sends.length,0);
  assert.deepEqual((await q.handle({action:'companion_status',id:'paper-a'})).entries,[])
})
