import test from 'node:test'
import assert from 'node:assert/strict'
import {createQueuedPaperAnalysis} from '../src/harness/paper-analysis-queue.mjs'

const tick=()=>new Promise(resolve=>setTimeout(resolve,2))
async function until(fn){for(let i=0;i<500;i++){if(await fn())return;await tick()}assert.fail('Queue checkpoint not reached')}
function fixture(){
  const records=new Map(),jobs=new Map(),calls=[],waits=new Map(),listeners=new Set()
  let auto=true,fill=true,busy=false,reads=[]
  const store={async get(key){reads.push(key);return structuredClone(records.get(key)||{key,value:null,revision:0})},async put(key,value,expected){assert.equal(expected,records.get(key)?.revision??0);const saved={key,value:structuredClone(value),revision:expected+1};records.set(key,saved);return structuredClone(saved)}}
  const settings={async get(){return {available:true,value:{auto_analysis:auto,analysis_fill:fill}}},subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn)}}
  const analysis=async input=>{
    if(input.action==='paper_analysis_get'){const job=jobs.get(input.id);return job&&(input.request_id===undefined||job.request_id===input.request_id)?job:{status:'idle'}}
    if(input.action==='paper_analysis_cancel'){const job=jobs.get(input.id);if(!job||input.request_id!==undefined&&job.request_id!==input.request_id)throw Error('No matching job');waits.get(input.id)?.();jobs.set(input.id,{id:input.id,request_id:job.request_id,status:'cancelled'});return jobs.get(input.id)}
    if(input.action==='paper_analysis_start'){
      if(jobs.has(input.id))return jobs.get(input.id)
      assert.equal(busy,false,'Only one paper may run');busy=true;calls.push(input)
      let resolve;const promise=new Promise(done=>resolve=done);waits.set(input.id,()=>{busy=false;jobs.set(input.id,{id:input.id,request_id:input.request_id,status:'complete'});resolve()});waits.get(input.id).promise=promise
      const job={id:input.id,request_id:input.request_id,status:'generating'};jobs.set(input.id,job);return job
    }
    throw Error('Unexpected analysis call')
  }
  analysis.wait=async id=>waits.get(id)?.promise;analysis.busy=()=>busy;analysis.dispose=()=>{}
  const options={analysis,store,settings},handle=createQueuedPaperAnalysis(options)
  return {records,jobs,calls,waits,reads,options,handle,setAuto(value){auto=value;for(const fn of listeners)fn()},setFill(value){fill=value},done(id){waits.get(id)?.()}}
}
test('import events persist a serial queue; duplicate selection and metadata-only items add no extra work',async t=>{
  const f=fixture();t.after(()=>f.handle.dispose())
  await f.handle.imported([{id:'paper-a',pdf:true},{id:'paper-b',pdf:true},{id:'dataset_a',pdf:true},{id:'metadata-only',pdf:false}])
  await until(()=>f.calls.length===1);assert.equal(f.calls[0].id,'paper-a');assert.equal(f.calls[0].apply_metadata,true)
  assert.equal(f.calls[0].pages,undefined,'Default queue scope is all pages')
  await f.handle({action:'paper_analysis_start',id:'paper-b',request_id:'selected-b',reuse:true})
  assert.equal((await f.handle({action:'paper_analysis_get',id:'paper-b'})).status,'queued')
  f.done('paper-a');await until(()=>f.calls.length===2);f.done('paper-b');await until(()=>f.records.get('analysis.queue:v1').value.entries.length===0)
  assert.deepEqual(f.calls.map(x=>x.id),['paper-a','paper-b']);assert.equal(f.reads.some(x=>!x.startsWith('analysis.')),false)
})
test('turning automation off pauses pending work; re-enabling honors the latest metadata choice',async t=>{
  const f=fixture();t.after(()=>f.handle.dispose());await f.handle.imported([{id:'paper-a',pdf:true},{id:'paper-b',pdf:true}]);await until(()=>f.calls.length===1)
  f.setAuto(false);f.done('paper-a');await until(()=>f.records.get('analysis.queue:v1').value.entries.length===1);await tick();assert.equal(f.calls.length,1)
  f.setFill(false);f.setAuto(true);await until(()=>f.calls.length===2);assert.equal(f.calls[1].apply_metadata,false);f.done('paper-b')
})
test('pending work survives a new host wrapper and interrupted generations never replay',async t=>{
  const f=fixture();await f.handle.imported([{id:'paper-a',pdf:true},{id:'paper-b',pdf:true}]);await until(()=>f.calls.length===1)
  f.handle.dispose();f.done('paper-a');f.jobs.set('paper-a',{id:'paper-a',status:'interrupted'})
  const restored=createQueuedPaperAnalysis(f.options);t.after(()=>restored.dispose());await until(()=>f.calls.length===2)
  assert.equal(f.calls[1].id,'paper-b');assert.equal(f.calls.filter(v=>v.id==='paper-a').length,1);f.done('paper-b')
})
test('cancelling a waiting paper is durable and later selection does not requeue it',async t=>{
  const f=fixture();t.after(()=>f.handle.dispose());await f.handle.imported([{id:'paper-a',pdf:true},{id:'paper-b',pdf:true}]);await until(()=>f.calls.length===1)
  assert.equal((await f.handle({action:'paper_analysis_cancel',id:'paper-b'})).status,'cancelled')
  f.done('paper-a');await until(()=>f.records.get('analysis.queue:v1').value.entries.length===0)
  const result=await f.handle({action:'paper_analysis_start',id:'paper-b',request_id:'new-b',reuse:true});assert.equal(result.status,'cancelled');assert.equal(f.calls.length,1)
})
test('disabled defaults overridden by the user stay disabled and malformed queued input never runs',async t=>{
  const f=fixture();t.after(()=>f.handle.dispose());f.setAuto(false)
  const result=await f.handle.imported([{id:'paper-a',pdf:true}]);assert.equal(result[0].status,'idle')
  for(const input of [{id:'../x',request_id:'x'},{id:'paper-a',request_id:'x',pages:[1,1]},{id:'paper-a',request_id:'x',source_session_id:'bad\n'}])await assert.rejects(f.handle({action:'paper_analysis_start',reuse:true,...input}))
  assert.equal(f.calls.length,0)
})
test('a stale request cannot inspect or cancel a different queued request',async t=>{
  const f=fixture();t.after(()=>f.handle.dispose());await f.handle.imported([{id:'paper-a',pdf:true},{id:'paper-b',pdf:true}]);await until(()=>f.calls.length===1)
  const queued=await f.handle({action:'paper_analysis_get',id:'paper-b'})
  assert.equal((await f.handle({action:'paper_analysis_get',id:'paper-b',request_id:'stale-b'})).status,'idle')
  await assert.rejects(f.handle({action:'paper_analysis_cancel',id:'paper-b',request_id:'stale-b'}),/No matching job/)
  assert.equal((await f.handle({action:'paper_analysis_get',id:'paper-b'})).request_id,queued.request_id)
  const cancelled=await f.handle({action:'paper_analysis_cancel',id:'paper-b',request_id:queued.request_id})
  assert.equal(cancelled.request_id,queued.request_id)
  assert.equal((await f.handle({action:'paper_analysis_get',id:'paper-b',request_id:'stale-b'})).status,'idle')
  assert.equal((await f.handle({action:'paper_analysis_get',id:'paper-b',request_id:queued.request_id})).status,'cancelled')
  f.done('paper-a');await until(()=>f.records.get('analysis.queue:v1').value.entries.length===0);assert.equal(f.calls.length,1)
})
