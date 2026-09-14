import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFetchHandler } from '../src/http.mjs';
import { createLocalStateStore } from '../src/local-state.mjs';
import { resolveConfig } from '../src/harness/config.mjs';
import { createHash } from 'node:crypto';

async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'paper-state-http-')),library=join(root,'library'),home=join(root,'dsh-home');
  await mkdir(library); t.after(()=>rm(root,{recursive:true,force:true}));
  return {library,home,options:{library,localStateHome:home},store:createLocalStateStore({library,home})};
}
async function call(handler,input,headers={}) {
  const response=await handler(new Request('http://127.0.0.1/api',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(input)}));
  return {status:response.status,...await response.json()};
}

test('HTTP state writes survive handler reload and expose actionable CAS conflicts', async t => {
  const f=await fixture(t), handler=createFetchHandler(f.options);
  for (const key of ['preferences','reader','reader:paper_a','chat:paper_a','metadata:new','language-draft:request_a',`migration:${'a'.repeat(64)}`]) {
    const missing=await call(handler,{action:'state_get',key}); assert.equal(missing.result.revision,0);
    const saved=await call(handler,{action:'state_put',key,value:{text:'preserved',page:3},expected_revision:0});
    assert.equal(saved.status,200); assert.match(saved.result.revision,/^[a-f0-9]{64}$/);
    const recovered=await call(createFetchHandler(f.options),{action:'state_get',key,library:'/ignored-browser-location',home:'/ignored-browser-home'});
    assert.deepEqual(recovered.result,saved.result);
    const conflict=await call(handler,{action:'state_put',key,value:{text:'stale'},expected_revision:0});
    assert.equal(conflict.status,409); assert.equal(conflict.code,'STATE_CONFLICT'); assert.deepEqual(conflict.current,saved.result);
  }
  const missingRevision=await call(handler,{action:'state_put',key:'reader',value:{}});
  assert.equal(missingRevision.status,400); assert.equal(missingRevision.code,'STATE_INVALID');
  const oversized=await call(handler,{action:'state_put',key:'chat:large',value:{text:'x'.repeat(270000)},expected_revision:0});
  assert.equal(oversized.status,413); assert.equal(oversized.code,'STATE_TOO_LARGE');
  assert.equal((await call(handler,{action:'state_list',prefix:'migration:'})).result.total,1);
  assert.equal((await call(handler,{action:'state_put',key:'migration:not-a-hash',value:{},expected_revision:0})).status,403);
});

test('browser state namespaces cannot forge or inspect generated learning or vocabulary records', async t => {
  const f=await fixture(t), handler=createFetchHandler({...f.options,localState:f.store});
  for (const key of ['language.result:paper_a:request_a','vocabulary:word_a','preferences.private','reader.private']) await f.store.put(key,{secret:'not browser writable'},0);
  for (const key of ['language.result:paper_a:request_a','vocabulary:word_a','preferences.private','reader.private','../reader']) {
    for (const action of ['state_get','state_put','state_list']) {
      const result=await call(handler,{action,key,prefix:key,value:{forged:true},expected_revision:0});
      assert.equal(result.status,403); assert.equal(result.code,'STATE_FORBIDDEN');
    }
  }
  assert.equal((await call(handler,{action:'state_list'})).status,403);
  for (const prefix of ['preferences','reader']) assert.deepEqual((await call(handler,{action:'state_list',prefix})).result.records,[]);
  assert.equal((await call(handler,{action:'state_list',prefix:'chat:',limit:1000})).status,400);
  assert.equal((await call(handler,{action:'state_unknown',key:'reader'})).status,400);
  assert.equal((await call(handler,{action:'state_put',key:'reader',value:{},expected_revision:0},{origin:'https://attacker.example'})).status,403);
});

test('state and language capability flags reflect injected handlers; language routes preserve signals and recovery errors', async t => {
  const f=await fixture(t), calls=[];
  const languageLearning=async(input,{signal})=>{
    assert.ok(signal instanceof AbortSignal); calls.push(input.action);
    if (input.fail) throw Object.assign(new Error('saved result needs retry'),{code:'LANGUAGE_COMMIT_RETRY',status:409,generation_status:'committing',retry_with_new_request:false});
    return {action:input.action};
  };
  const handler=createFetchHandler({...f.options,languageLearning});
  const status=await call(handler,{action:'status'});
  assert.equal(status.result.durable_state,true); assert.equal(status.result.language_learning,true); assert.equal(status.result.learning_records,true);
  const standalone=createFetchHandler(f.options), standaloneStatus=await call(standalone,{action:'status'});
  assert.equal(standaloneStatus.result.durable_state,true); assert.equal(standaloneStatus.result.language_learning,false); assert.equal(standaloneStatus.result.learning_records,true);
  const actions=['language_generate','language_history','vocabulary_list','vocabulary_update','vocabulary_delete','vocabulary_export'];
  for (const action of actions) {
    assert.equal((await call(handler,{action})).status,200);
  }
  assert.deepEqual(calls,actions);
  const failure=await call(handler,{action:'language_generate',fail:true});
  assert.equal(failure.status,409); assert.equal(failure.code,'LANGUAGE_COMMIT_RETRY'); assert.equal(failure.generation_status,'committing'); assert.equal(failure.retry_with_new_request,false);
});

test('standalone can inspect and edit durable learning records without model or Session access',async t=>{
  const f=await fixture(t), hash=value=>createHash('sha256').update(value).digest('hex'), id=hash('term');
  const record={id:'result_a',paper_id:'paper_a',status:'complete',mode:'translate',created_at:new Date().toISOString(),result:'saved translation',vocabulary:[]};
  await f.store.put(`language.result:${hash('paper_a')}:${hash('request_a')}`,record,0);
  await f.store.put(`vocabulary:${id}`,{id,term:'term',meaning:'词',status:'learning',encounters:[],suggested_by:'ai'},0);
  // Invalid worker executable proves these routes need neither worker metadata
  // nor the paper Session/model machinery merely to open local records.
  const handler=createFetchHandler({...f.options,python:'/nonexistent/no-model-or-worker',paperChat:()=>assert.fail('record access must not open a paper Session')});
  const history=await call(handler,{action:'language_history',id:'paper_a'});
  assert.equal(history.status,200); assert.equal(history.result.items[0].result,'saved translation');
  const list=await call(handler,{action:'vocabulary_list'});
  assert.equal(list.status,200); assert.equal(list.result.items[0].term,'term');
  const update=await call(handler,{action:'vocabulary_update',id,meaning:'Edited by reader',expected_revision:list.result.items[0].revision});
  assert.equal(update.status,200); assert.equal(update.result.meaning_source,'user');
  const exported=await call(handler,{action:'vocabulary_export',format:'json'});
  assert.equal(exported.status,200); assert.equal(JSON.parse(exported.result.content).vocabulary[0].meaning,'Edited by reader');
  const generation=await call(handler,{action:'language_generate',id:'paper_a',mode:'translate',text:'term',request_id:'new_request'});
  assert.equal(generation.status,400); assert.match(generation.error,/DeepSeek Harness/);
  assert.equal((await f.store.list({prefix:'language.result:'})).total,1,'standalone rejection must not allocate a pending generation');
  assert.equal((await call(handler,{action:'vocabulary_delete',id,expected_revision:update.result.revision})).status,200);
  assert.equal((await call(handler,{action:'vocabulary_list'})).result.total,0);
});

test('deployment-only state-home overrides are validated and retained',()=>{
  assert.equal(resolveConfig({library:'/private/tmp/library',localStateHome:'/private/tmp/state-home'}).localStateHome,'/private/tmp/state-home');
  assert.equal(resolveConfig({library:'/private/tmp/library'}).localStateHome,undefined);
  for (const localStateHome of ['',1,'relative']) assert.throws(()=>resolveConfig({localStateHome}));
});
