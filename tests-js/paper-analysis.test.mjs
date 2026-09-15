import test from 'node:test'
import assert from 'node:assert/strict'
import { createPaperAnalysis } from '../src/harness/paper-analysis.mjs'

const request = { action:'paper_analysis_start', id:'paper-a', request_id:'run-a', apply_metadata:false }
function gate() { let resolve; const promise=new Promise(done=>{resolve=done}); return {promise,resolve} }
async function until(predicate) {
  for(let count=0;count<200;count++){if(await predicate())return;await new Promise(resolve=>setImmediate(resolve))}
  assert.fail('Synthetic background operation did not reach its expected checkpoint')
}
function assertPlainTree(value,seen=new WeakSet()) {
  if(value&&typeof value==='object'){
    assert.equal(seen.has(value),false,'LocalState rejects repeated object aliases');seen.add(value)
    for(const item of Object.values(value))assertPlainTree(item,seen)
  }
}
function fixture() {
  const f={records:new Map(),drafts:new Map(),kernel:[],writes:[],calls:[],routes:[],readGate:null,routeGate:null,agentGate:null,applyGate:null,applyError:null,failComplete:false}
  f.paper={id:'paper-a',title:'Synthetic paper',pdf:true,modified:'revision-a',analysis_metadata_sources:{private:'UNSELECTED_METADATA_INTERNAL'}}
  const source=(id,page,text)=>({id,entity:{kind:'paper',id:'paper-a'},kind:'source-note',verification:'source-note',text,locator:{page},content_hash:`hash-${id}`})
  f.sources=[source('source-a',2,'Selected exact evidence from Synthetic Journal.'),source('source-b',5,'UNSELECTED_PRIVATE_BODY')]
  f.pack={paper:f.paper,expected_modified:'revision-a',sources:f.sources,source_ids:f.sources.map(s=>s.id),coverage:{read_pages:[2,5],requested_pages:[2,5],full_document:false,page_count:20}}
  f.output={title:'Synthetic graph',body:'Bounded reading only.',nodes:[
    {id:'same',type:'evidence',label:'Selected finding',source_id:'source-a',quote:'Selected exact evidence'},
    {id:'same',type:'claim',label:'Selected bounded claim'},
    {id:'other',type:'evidence',label:'Other finding',source_id:'source-b',quote:'UNSELECTED_PRIVATE_BODY'},
    {id:'other',type:'claim',label:'UNSELECTED_CLAIM'},
  ],edges:[],assertions:[
    {subject:'evidence:same',object:'claim:same',relation:'supports',source_id:'source-a',surface:'Selected relation'},
    {subject:'evidence:other',object:'claim:other',relation:'supports',source_id:'source-b',surface:'Unselected relation'},
  ],metadata:{'container-title':'Synthetic Journal'},field_sources:{'container-title':[{source_id:'source-a',quote:'Synthetic Journal'}]}}
  f.route={provider:'synthetic-provider',model:'paper-model',reasoningEffort:'high',prompt:'FORGED_ROUTE_PROMPT'}
  let revision=0
  f.options={library:'/synthetic/library',python:'/synthetic/python',
    store:{
      async get(key){return structuredClone(f.records.get(key)??{key,value:null,revision:0})},
      async put(key,value,expected){
        assertPlainTree(value)
        if(f.failComplete&&value.status==='complete')throw new Error('Synthetic completion checkpoint failure')
        assert.equal(expected,f.records.get(key)?.revision??0,'State writes must use CAS')
        const record={key,value:structuredClone(value),revision:++revision}
        f.records.set(key,record);f.writes.push(record);return structuredClone(record)
      },
    },
    async dispatch(input,options){
      f.kernel.push(structuredClone(input))
      assert.equal(options.library,'/synthetic/library');assert.equal(options.python,'/synthetic/python')
      if(input.action==='get')return {...f.paper,id:input.id}
      if(input.action==='paper_analysis_batch'){await f.readGate?.promise;const pack=structuredClone(f.batchPacks?f.batchPacks.shift():f.pack);if(input.id!=='paper-a'){pack.paper={...pack.paper,id:input.id};pack.sources=pack.sources.map(s=>({...s,entity:{kind:'paper',id:input.id}}))}return pack}
      if(input.action==='knowledge_draft_put'){
        const draft={...structuredClone(input),id:f.drafts.size?`draft-${f.drafts.size}`:'draft-a',revision:1,status:'needs-review'}
        f.drafts.set(draft.id,draft);return structuredClone(draft)
      }
      if(input.action==='knowledge_draft_get')return structuredClone(f.drafts.get(input.id))
      if(input.action==='knowledge_source_get')return structuredClone(f.sources.find(s=>s.id===input.id))
      if(input.action==='paper_analysis_apply_metadata'){
        await f.applyGate?.promise
        if(f.applyError)throw f.applyError
        return {paper:{...f.paper,modified:'revision-b'},applied_fields:Object.keys(input.metadata),skipped_fields:[]}
      }
      throw new Error(`Unexpected kernel operation ${input.action}`)
    },
    async paperChat(input,options){f.routes.push(input);await f.routeGate?.promise;return {model:f.route}},
    async agent(input){f.calls.push(input);await f.agentGate?.promise;const value=f.outputFor?await f.outputFor(input):f.output;return typeof value==='string'?value:JSON.stringify(value)},
  }
  f.handle=createPaperAnalysis(f.options)
  f.record=()=>[...f.records.values()].find(r=>r.value.id==='paper-a'&&r.value.request_id==='run-a')
  f.done=async()=>{await until(()=>f.record()&&!['queued','reading','generating','committing'].includes(f.record().value.status));return f.handle({action:'paper_analysis_get',id:'paper-a',request_id:'run-a'})}
  return f
}

test('simultaneous duplicate clicks and completed restart never replay a generation',async()=>{
  const f=fixture();f.agentGate=gate()
  const [first,duplicate]=await Promise.all([f.handle(request),f.handle(request)])
  assert.deepEqual(first,duplicate)
  await until(()=>f.calls.length===1)
  const active=await f.handle(request)
  assert.equal(active.status,'generating')
  f.agentGate.resolve();const result=await f.done()
  assert.equal(result.status,'complete')
  const restarted=createPaperAnalysis(f.options)
  assert.equal((await restarted(request)).status,'complete')
  assert.equal(f.calls.length,1)
  assert.equal(f.kernel.filter(c=>c.action==='paper_analysis_batch').length,1)
  assert.equal(f.kernel.filter(c=>c.action==='knowledge_draft_put').length,1)
  await assert.rejects(restarted({...request,pages:[7]}),e=>e.code==='ANALYSIS_CONFLICT')
  assertPlainTree(f.record().value)
})

test('restart reports an uncertain pending run without new work or a model replay',async()=>{
  const f=fixture();f.agentGate=gate();await f.handle(request)
  await until(()=>f.calls.length===1)
  const restarted=createPaperAnalysis(f.options),before=f.kernel.length,writes=f.writes.length
  assert.equal((await restarted(request)).status,'interrupted')
  assert.equal((await restarted({action:'paper_analysis_get',id:'paper-a'})).status,'interrupted')
  assert.equal(f.calls.length,1);assert.equal(f.kernel.length,before);assert.equal(f.writes.length,writes)
  f.agentGate.resolve();assert.equal((await f.done()).status,'complete')
})

test('up to two documents run in parallel, a third waits, and changed duplicate options fail before more work',async()=>{
  const f=fixture();f.readGate=gate();await f.handle(request)
  await until(()=>f.kernel.some(c=>c.action==='paper_analysis_batch'))
  const second=await f.handle({...request,id:'paper-b',request_id:'run-b'})
  assert.equal(second.status,'queued','A second distinct paper admits within the concurrency bound')
  await until(()=>f.kernel.some(c=>c.action==='paper_analysis_batch'&&c.id==='paper-b'))
  await assert.rejects(f.handle({...request,id:'paper-c',request_id:'run-c'}),e=>e.code==='ANALYSIS_BUSY')
  await assert.rejects(f.handle({...request,apply_metadata:true}),e=>e.code==='ANALYSIS_CONFLICT')
  assert.equal(f.kernel.some(c=>c.action==='get'&&c.id==='paper-c'),false)
  f.readGate.resolve();await f.done()
  await until(()=>[...f.records.values()].some(record=>record.value.id==='paper-b'&&record.value.request_id==='run-b'&&record.value.status==='complete'))
  const next=await f.handle({...request,request_id:'run-a2'})
  assert.equal(next.status,'queued')
  await until(()=>f.calls.length===3)
  await until(()=>[...f.records.values()].some(record=>record.value.request_id==='run-a2'&&record.value.status==='complete'))
})

test('the concurrency bound is configurable and validated',async()=>{
  const f=fixture()
  assert.throws(()=>createPaperAnalysis({...f.options,maxConcurrency:0}))
  assert.throws(()=>createPaperAnalysis({...f.options,maxConcurrency:5}))
  const single=createPaperAnalysis({...f.options,maxConcurrency:1})
  try{
    f.readGate=gate();await single(request)
    await until(()=>f.kernel.some(c=>c.action==='paper_analysis_batch'))
    assert.equal(single.slots(),0)
    await assert.rejects(single({...request,id:'paper-b',request_id:'run-b'}),e=>e.code==='ANALYSIS_BUSY')
    f.readGate.resolve();await until(()=>f.record()?.value.status==='complete')
    assert.equal(single.slots(),1)
  }finally{single.dispose()}
})

test('cancelling while source extraction waits prevents model resolution and generation',async()=>{
  const f=fixture();f.readGate=gate();await f.handle(request)
  await until(()=>f.kernel.some(c=>c.action==='paper_analysis_batch'))
  const cancelling=f.handle({action:'paper_analysis_cancel',id:'paper-a'})
  await new Promise(resolve=>setImmediate(resolve));f.readGate.resolve()
  assert.equal((await cancelling).status,'cancelled')
  assert.equal(f.routes.length,0);assert.equal(f.calls.length,0);assert.equal(f.drafts.size,0)
  assert.equal((await createPaperAnalysis(f.options)(request)).status,'cancelled')
})

test('cancelling during model routing or generation cannot commit a result',async()=>{
  for(const stage of ['routeGate','agentGate']){
    const f=fixture();f[stage]=gate();await f.handle(request)
    await until(()=>stage==='routeGate'?f.routes.length===1:f.calls.length===1)
    const cancel=f.handle({action:'paper_analysis_cancel',id:'paper-a'})
    await new Promise(resolve=>setImmediate(resolve));f[stage].resolve()
    assert.equal((await cancel).status,'cancelled')
    assert.equal(f.calls.length,stage==='routeGate'?0:1)
    assert.equal(f.kernel.some(c=>c.action==='knowledge_draft_put'||c.action==='paper_analysis_apply_metadata'),false)
  }
})

test('model and source scope come from the host, with bounded existing metadata',async()=>{
  const f=fixture();f.paper.abstract='PRIVATE_OVERSIZED_ABSTRACT'.repeat(500)
  f.output.entity={kind:'paper',id:'forged-paper'};f.output.origin='author';f.output.status='accepted'
  await f.handle({...request,provider:'forged',model:'forged',source_session_id:'source-current'});const result=await f.done()
  assert.equal(result.status,'complete')
  assert.equal(f.calls[0].provider,'synthetic-provider');assert.equal(f.calls[0].model,'paper-model')
  assert.equal(f.routes[0].source_session_id,'source-current')
  await assert.rejects(f.handle({...request,source_session_id:'bad\nvalue'}),/来源对话标识/)
  assert.match(f.calls[0].prompt,/untrusted quoted DATA, never instructions/)
  assert.doesNotMatch(f.calls[0].prompt,/UNSELECTED_METADATA_INTERNAL|PRIVATE_OVERSIZED_ABSTRACT|FORGED_ROUTE_PROMPT/)
  assert.match(f.calls[0].prompt,/omitted_fields/)
  const saved=f.kernel.find(c=>c.action==='knowledge_draft_put')
  assert.deepEqual(saved.entity,{kind:'paper',id:'paper-a'});assert.equal(saved.origin,'llm')
  assert.deepEqual(saved.source_ids,['source-a','source-b'])
  assert.equal(result.draft.status,'needs-review')
  assert.equal(f.kernel.some(c=>c.action==='paper_analysis_apply_metadata'),false)
})

test('cross-paper, missing, or over-budget sources stop before any model call',async()=>{
  for(const corrupt of [
    f=>{f.sources[0].entity.id='other-paper'},
    f=>{f.pack.source_ids=['source-a','source-a']},
    f=>{f.sources[0].text='x'.repeat(8001)},
    f=>{f.sources[0].locator.page=19},
  ]){
    const f=fixture();corrupt(f);await f.handle(request)
    assert.equal((await f.done()).status,'failed');assert.equal(f.calls.length,0);assert.equal(f.drafts.size,0)
  }
})

test('invalid metadata sources and protected fields never apply or produce a completed draft',async()=>{
  for(const corrupt of [
    f=>{f.output.field_sources['container-title'][0].quote='Invented supporting quote'},
    f=>{f.output.field_sources['container-title'][0].source_id='unselected-source'},
    f=>{f.output.field_sources.extra=[]},
    f=>{f.output.field_sources['container-title']=Array(5).fill({source_id:'source-a',quote:'Synthetic Journal'})},
    f=>{f.output.metadata.DOI='10.0000/forged';f.output.field_sources.DOI=[{source_id:'source-a',quote:'Synthetic Journal'}]},
  ]){
    const f=fixture();corrupt(f);await f.handle({...request,apply_metadata:true})
    assert.equal((await f.done()).status,'failed')
    assert.equal(f.kernel.some(c=>c.action==='paper_analysis_apply_metadata'||c.action==='knowledge_draft_put'),false)
  }
})

test('explicit automatic fill keeps source evidence and a pending graph; no user review is forged',async()=>{
  const f=fixture();await f.handle({...request,apply_metadata:true});const result=await f.done()
  assert.equal(result.status,'complete');assert.deepEqual(result.metadata_result.applied_fields,['container-title'])
  const apply=f.kernel.find(c=>c.action==='paper_analysis_apply_metadata')
  assert.equal(apply.expected_modified,'revision-a')
  assert.deepEqual(apply.field_sources,f.output.field_sources)
  assert.deepEqual(result.field_sources,f.output.field_sources)
  assert.equal('reviewed_by' in apply,false)
  assert.equal(result.draft.origin,'llm');assert.equal(result.draft.status,'needs-review')
  assert.equal(f.kernel.some(c=>c.action==='knowledge_draft_review'),false)
})

test('concurrent metadata edit is a visible warning while the graph remains available',async()=>{
  const f=fixture();f.applyError=Object.assign(new Error('STATE_CONFLICT: manual metadata changed'),{code:'STATE_CONFLICT'})
  await f.handle({...request,apply_metadata:true});const result=await f.done()
  assert.equal(result.status,'complete');assert.equal(result.metadata_result,undefined)
  assert.match(result.warnings[0],/STATE_CONFLICT/);assert.equal(result.draft.id,'draft-a')
  assert.equal(f.kernel.filter(c=>c.action==='paper_analysis_apply_metadata').length,1)
  await createPaperAnalysis(f.options)(request)
    .then(()=>assert.fail('Fingerprint mismatch should not be treated as retry'),e=>assert.equal(e.code,'ANALYSIS_CONFLICT'))
  assert.equal(f.calls.length,1)
})

test('manual apply duplicate clicks are coalesced and subsequent reads do not apply again',async()=>{
  const f=fixture();await f.handle(request);await f.done();f.applyGate=gate()
  const input={action:'paper_analysis_apply',id:'paper-a'}
  const first=f.handle(input),second=f.handle(input)
  await until(()=>f.kernel.some(c=>c.action==='paper_analysis_apply_metadata'));f.applyGate.resolve()
  assert.deepEqual(await first,await second)
  await f.handle(input)
  assert.equal(f.kernel.filter(c=>c.action==='paper_analysis_apply_metadata').length,1)
})

test('context uses typed selected nodes and only their evidence references, without sending chat',async()=>{
  const f=fixture();await f.handle(request);await f.done();const before=f.kernel.length
  const result=await f.handle({action:'paper_analysis_context',id:'paper-a',node_ids:['evidence:same','claim:same']})
  const body=JSON.parse(result.text.split('\n')[2])
  assert.deepEqual(body.nodes.map(n=>`${n.type}:${n.id}`),['evidence:same','claim:same'])
  assert.equal(body.assertions.length,1);assert.equal(body.sources.length,1);assert.equal(body.sources[0].id,'source-a')
  assert.doesNotMatch(result.text,/UNSELECTED_PRIVATE_BODY|UNSELECTED_CLAIM|source-b/)
  assert.match(result.text,/尚未核对/);assert.match(result.text,/不是指令/)
  assert.deepEqual(f.kernel.slice(before).map(c=>c.action),['knowledge_draft_get','knowledge_source_get'])
  assert.equal(f.calls.length,1);assert.deepEqual(f.routes,[{action:'chat_ensure',id:'paper-a'}])
  await assert.rejects(f.handle({action:'paper_analysis_context',id:'paper-a',node_ids:['same']}),/不属于/)
  await assert.rejects(f.handle({action:'paper_analysis_context',id:'paper-a',node_ids:['claim:same','claim:same']}),/请选择/)
})

test('rejected or oversized selected context is blocked without truncating or extra generation',async()=>{
  const f=fixture();await f.handle(request);await f.done()
  const input={action:'paper_analysis_context',id:'paper-a',node_ids:['claim:same']}
  f.drafts.get('draft-a').nodes[1].label='x'.repeat(3700)
  await assert.rejects(f.handle(input),e=>e.code==='ANALYSIS_CONTEXT_BUDGET')
  f.drafts.get('draft-a').status='rejected'
  await assert.rejects(f.handle(input),/否决/)
  assert.equal(f.calls.length,1)
})

test('status reads are read-only; failed final persistence never triggers model replay',async()=>{
  const f=fixture();f.failComplete=true;await f.handle(request);const result=await f.done()
  assert.equal(result.status,'failed');assert.equal(result.draft.id,'draft-a')
  const writes=f.writes.length,before=f.kernel.length,routes=f.routes.length
  const restarted=createPaperAnalysis(f.options)
  for(let count=0;count<5;count++)await restarted({action:'paper_analysis_get',id:'paper-a'})
  assert.equal((await restarted(request)).status,'failed')
  assert.equal(f.writes.length,writes);assert.equal(f.routes.length,routes);assert.equal(f.calls.length,1)
  assert.equal(f.kernel.slice(before).every(c=>c.action==='knowledge_draft_get'),true)
})

test('reuse opens an existing result during another active job without new work',async()=>{
  const f=fixture();await f.handle(request);await f.done();f.readGate=gate()
  await f.handle({...request,id:'paper-b',request_id:'run-b'})
  await until(()=>f.kernel.some(c=>c.action==='paper_analysis_batch'&&c.id==='paper-b'))
  const before=f.kernel.length,writes=f.writes.length
  const reused=await f.handle({...request,request_id:'view-existing',reuse:true})
  assert.equal(reused.status,'complete');assert.equal(reused.request_id,'run-a')
  assert.equal(f.writes.length,writes)
  assert.equal(f.kernel.slice(before).every(c=>c.action==='knowledge_draft_get'),true)
  const cancel=f.handle({action:'paper_analysis_cancel',id:'paper-b',request_id:'run-b'})
  await new Promise(resolve=>setImmediate(resolve));f.readGate.resolve();await cancel
  assert.equal(f.calls.length,1)
})

test('unavailable saved graph remains a visible read error without erasing metadata suggestions',async()=>{
  const f=fixture();await f.handle(request);await f.done()
  const dispatch=f.options.dispatch
  f.options.dispatch=async(input,options)=>{if(input.action==='knowledge_draft_get')throw new Error('Synthetic saved graph missing');return dispatch(input,options)}
  const handle=createPaperAnalysis(f.options),writes=f.writes.length
  const result=await handle({action:'paper_analysis_get',id:'paper-a'})
  assert.match(result.draft_error,/saved graph missing/);assert.match(result.warnings.at(-1),/saved graph missing/)
  assert.deepEqual(result.metadata,f.output.metadata);assert.deepEqual(result.field_sources,f.output.field_sources)
  assert.equal(f.writes.length,writes);assert.equal(f.calls.length,1)
})

test('invalid typed identities and page selections cause no state or kernel work',async()=>{
  const f=fixture()
  for(const input of [{...request,id:'dataset_a'},{...request,id:'../paper'}, {...request,request_id:''}, {...request,pages:[1,1]}, {...request,pages:[0]}, {...request,pages:[true]}, {...request,apply_metadata:'true'}])await assert.rejects(f.handle(input))
  assert.equal(f.records.size,0);assert.equal(f.kernel.length,0);assert.equal(f.calls.length,0)
})

function multiBatch(f){
  f.sources=Array.from({length:13},(_,i)=>({id:`source-${i+1}`,entity:{kind:'paper',id:'paper-a'},kind:'source-note',verification:'source-note',text:`Evidence on page ${i+1}.`,locator:{page:i+1},content_hash:`hash-${i+1}`}))
  f.batchPacks=[f.sources.slice(0,8),f.sources.slice(8)].map((sources,index)=>({paper:f.paper,expected_modified:'revision-a',file_version:{bytes:1},sources,source_ids:sources.map(s=>s.id),next_cursor:index===0?{index:8,offset:0}:null,
    coverage:{read_pages:sources.map(s=>s.locator.page),completed_pages:sources.map(s=>s.locator.page),requested_pages:Array.from({length:13},(_,i)=>i+1),page_count:13,characters:sources.reduce((n,s)=>n+s.text.length,0),blank_pages:[],truncated_pages:[],omitted_pages:[]}}))
  f.outputFor=({prompt})=>{const input=JSON.parse(prompt.split('LIBRARY_KNOWLEDGE_JSON:\n')[1].split('\nAdditionally return metadata')[0]),s=input.sources[0];return {title:'Batch graph',body:'Source bounded.',nodes:[{id:'e',type:'evidence',label:`Selected ${s.id}`,source_id:s.id,quote:s.text}],edges:[],assertions:[],metadata:{},field_sources:{}}}
}
test('all thirteen pages are read serially in bounded batches and prior batch context remains inspectable',async()=>{
  const f=fixture();multiBatch(f);await f.handle({...request,pages:Array.from({length:13},(_,i)=>i+1)});const result=await f.done()
  assert.equal(result.status,'complete');assert.equal(result.batch_count,2);assert.equal(result.coverage.full_document,true)
  assert.deepEqual(result.coverage.read_pages,Array.from({length:13},(_,i)=>i+1));assert.equal(f.calls.length,2)
  assert.equal(f.drafts.size,2);assert.equal(f.routes.length,1)
  const reads=f.kernel.filter(x=>x.action==='paper_analysis_batch');assert.deepEqual(reads[1].cursor,{index:8,offset:0});assert.deepEqual(reads[1].file_version,{bytes:1})
  assert.equal(f.calls[0].prompt.includes('Evidence on page 13.'),false);assert.equal(f.calls[1].prompt.includes('Evidence on page 1.'),false)
  const first=await f.handle({action:'paper_analysis_get',id:'paper-a',batch_index:0});assert.equal(first.draft.id,'draft-a')
  const context=await f.handle({action:'paper_analysis_context',id:'paper-a',batch_index:0,node_ids:['evidence:e']});assert.match(context.text,/source-1/);assert.doesNotMatch(context.text,/source-9/)
  await assert.rejects(f.handle({action:'paper_analysis_get',id:'paper-a',batch_index:2}),/批次/)
  const restart=createPaperAnalysis(f.options);assert.equal((await restart({...request,pages:Array.from({length:13},(_,i)=>i+1)})).status,'complete')
})
test('failure in a later batch retains earlier graph and never replays automatically on restart',async()=>{
  const f=fixture();multiBatch(f);const respond=f.outputFor;f.outputFor=input=>{if(f.calls.length===2)throw Error('Synthetic later model failure');return respond(input)}
  await f.handle(request);const result=await f.done();assert.equal(result.status,'failed');assert.equal(result.batch_count,1)
  assert.equal(result.draft.id,'draft-a');assert.equal((await f.handle({action:'paper_analysis_get',id:'paper-a',batch_index:0})).draft.id,'draft-a')
  const restarted=createPaperAnalysis(f.options);assert.equal((await restarted(request)).status,'failed');assert.equal(f.calls.length,2)
})
