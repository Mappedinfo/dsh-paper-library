import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { decode, responseEnvelope, parseModel, quoteCheck, quoteRefs, structure, diagnostic } from '../scripts/diagnose-paper-analysis-run.mjs'

test('bounded unwrap handles nested response_body and message.content JSON strings',()=>{
  const model={nodes:[{id:'n1',type:'claim',quote:'A quote',source_id:'s1'}]}
  const outer=JSON.stringify(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(JSON.stringify(model))}}]}))
  const env=responseEnvelope(outer)
  assert.deepEqual(JSON.parse(env.text),model)
  assert.equal(env.audit_unwrap_layers,4)
  assert.equal(env.model_payload_wrapped,true)
  assert.deepEqual(decode(JSON.stringify(JSON.stringify({x:1}))).value,{x:1})
  assert.equal(parseModel('```json\n{"nodes":[]}\n```').syntax,null)
  assert.equal(parseModel('```json\n{"nodes":[]}\n``` trailing').syntax.kind,'valid_json_fence_with_trailing_text')
  assert.equal(parseModel('{"nodes":').syntax.kind,'unexpected_end')
  assert.equal(parseModel(JSON.stringify('{"nodes":[]}')).syntax.kind,'root_not_object')
  assert.equal(parseModel('{"nodes":[]} trailing').syntax.kind,'trailing_content_after_json')
})

test('quote categories and lightweight structure flags are explicit',()=>{
  const sources=new Map([['s1',{entity:{kind:'paper',id:'paper-1'},text:'First  quote\nsecond excerpt'}],['s2',{entity:{kind:'paper',id:'other'},text:'First quote'}]])
  const cases=[['First  quote','s1','exact'],['second   excerpt','s1','unique-whitespace-equivalent'],['absent','s1','not-found'],['First quote','s2','source-id-wrong'],['x',null,'missing']]
  for(const [quote,source_id,category] of cases)assert.equal(quoteCheck({quote,source_id},sources,'paper-1').category,category)
  const s=structure({nodes:[{type:'claim',fields:{quote:'misplaced',title:4}},{fields:{}}],edges:'bad'})
  assert.ok(s.issues.includes('node_0_quote_inside_fields'))
  assert.ok(s.issues.includes('edges_not_array'))
  assert.ok(structure({nodes:[{type:'evidence',source_id:'s1'}]}).issues.includes('node_0_evidence_quote_missing'))
  assert.ok(!structure({nodes:[{type:'claim',source_id:'s1'}]}).issues.includes('node_0_evidence_quote_missing'))
  assert.equal(quoteCheck({quote:'Ｆirst quote',source_id:'s1'},sources,'paper-1').category,'not-found')
  assert.equal(quoteCheck({quote:' First  quote',source_id:'s1'},sources,'paper-1').category,'not-found')
  const refs=quoteRefs({graph:{nodes:[{type:'evidence',source_id:'s1'},{type:'claim',source_id:'s1',quote:'extra quote',fields:{source_id:'s1',quote:'field quote'}}],edges:[{source_id:'s1'}],assertions:[{source_id:'s1',quote:'relation quote'}]},metadata:{title:'x',author:'y'},field_sources:{title:[{source_id:'s1',quote:'title excerpt'},{source_id:'s1'}]}})
  assert.equal(refs.find(ref=>ref.location==='fields').source_id,'s1')
  assert.equal(refs.filter(ref=>ref.group==='graph'&&ref.quote===null).length,1)
  assert.equal(refs.filter(ref=>ref.group==='metadata').length,3)
  assert.equal(refs.filter(ref=>ref.required).length,4)
  assert.equal(refs.filter(ref=>!ref.required).length,3)
})

test('diagnostic aggregates synthetic receipts and calls only injected readers',async()=>{
  const root=await mkdtemp(join(tmpdir(),'paper-analysis-diagnostic-')),run=join(root,'run'),out=join(root,'out'),library=join(root,'library'),state=join(root,'state'),id='paper-1',routeId='route-request',requestId=`batch-${createHash('sha256').update(JSON.stringify([routeId,id])).digest('hex')}`
  try{
    await mkdir(join(run,'responses'),{recursive:true});await mkdir(library);await mkdir(state)
    const plan={library,localStateHome:state,python:'unused',routes:[{name:'glm',ids:[id]}]}
    await writeFile(join(root,'plan.json'),JSON.stringify(plan))
    await writeFile(join(run,'progress.json'),JSON.stringify({status:'running',papers:[{id,status:'failed',batch_count:1}],routes:[{name:'glm'}]}))
    await writeFile(join(run,'run-manifest.json'),JSON.stringify({routes:[{name:'glm',request_id:routeId}]}))
    const proposal={graph:{nodes:[{id:'c1',type:'claim',label:'x',source_id:'s1',quote:'exact quote'},{id:'c2',type:'claim',label:'y',source_id:'s1',quote:'multi   whitespace'},{id:'c3',type:'claim',label:'z',source_id:'s2',quote:'wrong paper'},{id:'c4',type:'claim',label:'w',fields:{quote:'misplaced',title:3}},{id:'c5',type:'evidence',label:'m',source_id:'s1'},{id:'c6',type:'claim',label:'x',source_id:'s3',quote:'not allowed'}],edges:[{source_id:'s1',subject:'claim:c1',object:'claim:c2'}]},metadata:{title:'Synthetic title',author:'Synthetic author'},field_sources:{title:[{source_id:'s1',quote:'exact quote'},{source_id:'s1'}]}}
    const response={choices:[{finish_reason:'stop',message:{content:JSON.stringify(proposal)}}],usage:{completion_tokens:100,completion_tokens_details:{reasoning_tokens:7}}}
    await writeFile(join(run,'responses','000001-glm.json'),JSON.stringify({call_id:'call1',status:'succeeded',model:'glm-test',returned_model:'glm-returned',analysis_context:{id,request_id:requestId,stage:'batch',batch_index:0,source_ids:['s1','s2']},response_body:JSON.stringify(JSON.stringify(response))}))
    await writeFile(join(run,'responses','000002-glm.json'),JSON.stringify({call_id:'call2',status:'failed',error_code:'DIRECT_MODEL_NETWORK_ERROR',analysis_context:{id,request_id:requestId,stage:'batch',batch_index:1,source_ids:[]},response_body:null}))
    const fakeAnalysis=async()=>({status:'failed',batch_count:1,error:'synthetic failure'})
    fakeAnalysis.dispose=()=>{}
    const fetched=[]
    const report=await diagnostic({planPath:join(root,'plan.json'),runDir:run,outDir:out,createAnalysis:async()=>fakeAnalysis,dispatch:async({id},options)=>{assert.equal(options.python,'unused');fetched.push(id);return id==='s1'?{entity:{kind:'paper',id:'paper-1'},text:'exact quote\nwith multi whitespace'}:{entity:{kind:'paper',id:'elsewhere'},text:'wrong paper'}}})
    assert.equal(report.paper_count,1);assert.equal(report.call_count,2)
    assert.deepEqual(report.quote_totals,{exact:1,'unique-whitespace-equivalent':0,'not-found':0,'source-id-wrong':0,missing:3})
    assert.deepEqual(report.graph_quote_totals,{exact:0,'unique-whitespace-equivalent':0,'not-found':0,'source-id-wrong':0,missing:1})
    assert.deepEqual(report.metadata_quote_totals,{exact:1,'unique-whitespace-equivalent':0,'not-found':0,'source-id-wrong':0,missing:2})
    assert.deepEqual(report.additional_quote_totals,{exact:1,'unique-whitespace-equivalent':1,'not-found':0,'source-id-wrong':2,missing:1})
    assert.deepEqual(fetched.sort(),['s1','s2'])
    assert.equal(report.calls[0].thinking_tokens,7);assert.equal(report.calls[0].returned_model,'glm-returned')
    assert.ok(report.calls[0].shape.issues.includes('node_3_quote_inside_fields'))
    const rejected = report.calls[0].quote_checks.find(row => row.source_allowed === false && row.source_id === 's3')
    assert.equal(rejected.category,'source-id-wrong')
    assert.equal(rejected.quote,undefined)
    assert.equal(report.papers[0].job_status,'failed');assert.equal(report.papers[0].batch_count,1)
    assert.equal(report.calls[1].error_code,'DIRECT_MODEL_NETWORK_ERROR')
    assert.equal(report.calls[1].parse_error,null)
  }finally{await rm(root,{recursive:true,force:true})}
})
