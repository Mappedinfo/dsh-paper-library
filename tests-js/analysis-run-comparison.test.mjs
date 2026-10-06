import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compareRuns } from '../scripts/compare-paper-analysis-runs.mjs'

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
async function fixture({mismatchOptions=false,mismatchHash=false,mismatchQuestions=false}={}) {
  const root=await mkdtemp(join(tmpdir(),'analysis-run-compare-')), library=join(root,'library'), left=join(root,'left'),right=join(root,'right'),out=join(root,'private-out')
  await Promise.all([mkdir(library),mkdir(left),mkdir(right)])
  const common={library,request_id:'common-request',mode:'full',notes:true,review:false,question_ids:['q1','q2']}
  const lp={...common,localStateHome:join(root,'left-state'),routes:[{name:'left-route',config:'/private/left.json',ids:['paper-b','paper-a']}]}
  const rp={...common,localStateHome:join(root,'right-state'), ...(mismatchOptions?{mode:'metadata'}:{}),
    ...(mismatchQuestions?{question_ids:['q1']}:{ }),routes:[{name:'right-route',config:'/private/right.json',ids:['paper-a','paper-b']}]}
  const request=(plan,route)=>`route-${hash([plan.request_id,route.name])}`
  for(const [dir,plan,route] of [[left,lp,lp.routes[0]],[right,rp,rp.routes[0]]]) {
    await writeFile(join(dir,'result.json'),JSON.stringify({status:'complete',routes:[]}))
    await writeFile(join(dir,'run-manifest.json'),JSON.stringify({routes:[{name:route.name,request_id:request(plan,route),model:dir===left?'glm-test':'kimi-test',ids:route.ids}]}))
  }
  const papers=['paper-a','paper-b'], selectionRows=[]
  for(const id of papers) { const path=join(root,`${id}.pdf`), bytes=Buffer.from(`synthetic PDF bytes for ${id}`); await writeFile(path,bytes,{mode:0o600}); selectionRows.push({id,title:`Title ${id}`,path,sha256:createHash('sha256').update(bytes).digest('hex'),pages:[1]}) }
  if(mismatchHash) selectionRows[0].sha256='b'.repeat(64)
  const selection={papers:selectionRows}
  const path=join(root,'selection.json'); await writeFile(path,JSON.stringify(selection))
  await writeFile(join(root,'left-plan.json'),JSON.stringify(lp)); await writeFile(join(root,'right-plan.json'),JSON.stringify(rp))
  const records=new Map()
  for(const [dir,plan] of [[left,lp],[right,rp]]) for(const id of papers) {
    const rid=`batch-${hash([request(plan,plan.routes[0]),id])}`
    records.set(`${id}:${rid}`,{status:'complete',model:{provider:dir===left?'glm':'kimi',model:dir===left?'glm-test':'kimi-test'},coverage:{full_document:true,completed_pages:[1],page_count:1},batch_count:1,
      metadata:{title:`Title ${id}`},field_sources:{title:[{source_id:`src-${id}`,quote:'paper title'}]},draft_id:`draft-${id}`,...(id==='paper-a'?{note_draft_id:`note-${id}`}:{})})
    records.set(`${id}:${rid}:0`,{status:'complete',batch_coverage:{completed_pages:[1]},source_ids:[`src-${id}`],
      batch_metadata:{title:`Title ${id}`},batch_field_sources:{title:[{source_id:`src-${id}`,quote:'paper title'}]},
      draft:{id:`draft-${id}`,nodes:[{id:'claim',quote:'exact graph quote',source_id:`src-${id}`}],edges:[],assertions:[]}})
  }
  const analysis=async req=>records.get(`${req.id}:${req.request_id}${req.batch_index===undefined?'':`:${req.batch_index}`}`)
  const dispatch=async req=>req.action==='knowledge_source_get'?{entity:{kind:'paper',id:req.id.replace('src-','')},text:'paper title and exact graph quote'}:
    req.action==='knowledge_draft_get'?{status:'needs-review',title:'Note',body:`# Note for ${req.id}`}:(()=>{throw new Error('unexpected')})()
  return {root,library,left,right,out,lp,rp,path,analysis,dispatch,selection}
}

test('pairs by paper ID, opens each state home, matches exact receipt context and exports full saved batch graphs',async()=>{
  const f=await fixture()
  try {
    const routeRequest=(plan,route)=>`route-${hash([plan.request_id,route.name])}`
    for(const [dir,plan,route] of [[f.left,f.lp,f.lp.routes[0]],[f.right,f.rp,f.rp.routes[0]]]) {
      await mkdir(join(dir,'responses'))
      const paperRequest=id=>`batch-${hash([routeRequest(plan,route),id])}`
      await writeFile(join(dir,'responses','000001-route.json'),JSON.stringify({call_id:1,route:route.name,status:'succeeded',started_at:'2026-01-01T00:00:00Z',finished_at:'2026-01-01T00:00:02Z',
        returned_model:'returned-model',analysis_context:{id:'paper-a',request_id:paperRequest('paper-a'),stage:'batch',batch_index:0,source_ids:['source-a'],pages:[1]},prompt_sha256:'c'.repeat(64),prompt_bytes:321,
        response_body:JSON.stringify(dir===f.left?{model:'glm-returned',usage:{prompt_tokens:7,completion_tokens:3,prompt_tokens_details:{cached_tokens:2},completion_tokens_details:{reasoning_tokens:1}},choices:[{finish_reason:'stop',message:{content:'synthetic response'}}]}:
          {model:'kimi-returned',usage:{input_tokens:7,output_tokens:3,cache_read_input_tokens:2,cache_creation_input_tokens:1,output_tokens_details:{thinking_tokens:2}},stop_reason:'end_turn',content:[{type:'text',text:'synthetic response'}]})}))
      await writeFile(join(dir,'responses','000002-route.json'),JSON.stringify({call_id:2,route:route.name,status:'succeeded',started_at:'2026-01-01T00:00:00Z',finished_at:'2026-01-01T00:00:01Z',
        analysis_context:{id:'paper-b',request_id:'wrong-request',stage:'batch',batch_index:0,source_ids:['source-b'],pages:[1]},response_body:'{}'}))
      await writeFile(join(dir,'responses','000003-route.json'),'{broken receipt')
      if(dir===f.left) await writeFile(join(dir,'responses','000004-route.json'),JSON.stringify({call_id:4,route:route.name,status:'succeeded',
        analysis_context:{id:'paper-a',request_id:paperRequest('paper-a'),stage:'note',source_ids:['source-a'],pages:[1]},
        response_body:JSON.stringify({usage:{prompt_tokens:8,completion_tokens:4},choices:[{finish_reason:'stop'}]})}))
    }
    const stateHomes=[],disposed=[]
    const report=await compareRuns({leftPlanPath:join(f.root,'left-plan.json'),rightPlanPath:join(f.root,'right-plan.json'),leftRunPath:f.left,rightRunPath:f.right,selectionPath:f.path,outPath:f.out,
      createAnalysis:async opts=>{stateHomes.push(opts.localStateHome); const fn=req=>f.analysis(req); fn.dispose=()=>disposed.push(opts.localStateHome); return fn},dispatch:f.dispatch})
    assert.deepEqual(report.papers.map(p=>p.id),['paper-b','paper-a'])
    assert.equal(report.papers[0].left.batches[0].quote_checks[0].check,'exact_match')
    assert.equal(report.papers[0].left.batches[0].metadata_quote_checks[0].check,'exact_match')
    assert.equal(report.papers[0].left.batches[0].metadata_quote_status,'available')
    assert.equal(report.papers[0].left.metadata.quote_checks[0].check,'exact_match')
    assert.equal(report.papers[1].right.note.markdown_file,'right-note-paper-a.md')
    assert.equal(report.papers[0].left.batches[0].draft.nodes[0].quote,'exact graph quote')
    assert.equal(report.papers[1].left.model_calls.length,2)
    assert.equal(report.papers[0].left.model_calls.length,0)
    assert.deepEqual(stateHomes,[f.lp.localStateHome,f.rp.localStateHome])
    assert.deepEqual(disposed,stateHomes)
    assert.equal(report.usage_latency.left.token_totals.input_tokens_reported.known_sum,15)
    assert.equal(report.usage_latency.left.token_totals.input_tokens_including_cache.known_sum,15)
    assert.equal(report.usage_latency.left.token_totals.input_tokens_excluding_cache.known_sum,5)
    assert.equal(report.usage_latency.left.token_totals.input_tokens_excluding_cache.known_calls,1)
    assert.equal(report.usage_latency.left.token_totals.thinking_tokens.known_sum,1)
    assert.equal(report.usage_latency.right.token_totals.input_tokens_including_cache.known_sum,10)
    assert.equal(report.papers[1].right.model_calls[0].usage.raw.cache_read_input_tokens,2)
    assert.equal(report.papers[1].right.model_calls[0].stop_reason,'end_turn')
    assert.equal(report.papers[1].left.model_calls[0].finish_reason,'stop')
    assert.equal(report.papers[1].left.model_calls[0].usage.thinking_tokens,1)
    assert.equal(report.papers[1].left.model_calls[1].usage.thinking_tokens,null)
    assert.equal(report.usage_latency.left.token_totals.thinking_tokens.known_calls,1)
    assert.equal(report.usage_latency.left.unavailable,1)
    assert.equal(report.papers[0].left.note.status,'missing')
    assert.equal(report.papers[0].left.deliverable_complete,false)
    assert.equal(report.papers[0].left.question_protocol,'legacy')
    assert.equal(report.papers[0].left.question_coverage,null)
    assert.match(await readFile(join(f.out,'right-note-paper-a.md'),'utf8'),/Note for note-paper-a/)
    assert.match(await readFile(join(f.out,'summary.md'),'utf8'),/输入含缓存/)
  } finally { await rm(f.root,{recursive:true,force:true}) }
})

test('new questionnaire jobs require analysis_complete and explicit all-success question coverage',async()=>{
  const f=await fixture()
  try {
    const baseCompare=async()=>compareRuns({leftPlanPath:join(f.root,'left-plan.json'),rightPlanPath:join(f.root,'right-plan.json'),leftRunPath:f.left,rightRunPath:f.right,selectionPath:f.path,outPath:f.out,
      createAnalysis:async opts=>{const fn=req=>f.analysis(req);fn.dispose=()=>{};return fn},dispatch:f.dispatch})
    const oldAnalysis=f.analysis
    let state='incomplete'
    const wrapper=async req=>{
      const row=await oldAnalysis(req)
      if(row&&req.id==='paper-a'&&req.batch_index===undefined) {
        row.questionnaire={version:'reading-questions-v1',hash:'a'.repeat(64)}
        row.analysis_complete=state!=='analysis-incomplete'
        row.question_coverage=state==='incomplete'?{question_ids:['q1','q2'],complete:false,by_question:{q1:{expected_batches:1,answered_batches:1,failed_batches:[],unread_batches:[],valid_answers:1},q2:{expected_batches:1,answered_batches:0,failed_batches:[],unread_batches:[],valid_answers:0}}}:
          {question_ids:['q1','q2'],complete:true,by_question:{q1:{expected_batches:1,answered_batches:1,failed_batches:[],unread_batches:[],valid_answers:1},q2:{expected_batches:1,answered_batches:1,failed_batches:[],unread_batches:[],valid_answers:1}}}
      }
      return row
    }
    f.analysis=wrapper
    const first=await baseCompare()
    assert.equal(first.papers.find(row=>row.id==='paper-a').left.deliverable_complete,false)
    state='analysis-incomplete'; await rm(f.out,{recursive:true,force:true})
    const incompleteOut=join(f.root,'private-out-analysis-incomplete')
    const incomplete=await compareRuns({leftPlanPath:join(f.root,'left-plan.json'),rightPlanPath:join(f.root,'right-plan.json'),leftRunPath:f.left,rightRunPath:f.right,selectionPath:f.path,outPath:incompleteOut,
      createAnalysis:async()=>{const fn=req=>f.analysis(req);fn.dispose=()=>{};return fn},dispatch:f.dispatch})
    assert.equal(incomplete.papers.find(row=>row.id==='paper-a').left.question_status,'incomplete')
    assert.equal(incomplete.papers.find(row=>row.id==='paper-a').left.deliverable_complete,false)
    state='complete'
    // Use another private output directory for the second report.
    const out=join(f.root,'private-out-success')
    const second=await compareRuns({leftPlanPath:join(f.root,'left-plan.json'),rightPlanPath:join(f.root,'right-plan.json'),leftRunPath:f.left,rightRunPath:f.right,selectionPath:f.path,outPath:out,
      createAnalysis:async()=>{const fn=req=>f.analysis(req);fn.dispose=()=>{};return fn},dispatch:f.dispatch})
    const result=second.papers.find(row=>row.id==='paper-a').left
    assert.equal(result.question_protocol,'questionnaire')
    assert.equal(result.analysis_complete,true)
    assert.equal(result.deliverable_complete,true)
  } finally { await rm(f.root,{recursive:true,force:true}) }
})

test('rejects differences in shared run options or local PDF hashes before inspection',async()=>{
  for(const opts of [{mismatchOptions:true},{mismatchHash:true},{mismatchQuestions:true}]) {
    const f=await fixture(opts)
    try {
      await assert.rejects(compareRuns({leftPlanPath:join(f.root,'left-plan.json'),rightPlanPath:join(f.root,'right-plan.json'),leftRunPath:f.left,rightRunPath:f.right,selectionPath:f.path,outPath:f.out,
        createAnalysis:async()=>{throw new Error('must not initialize')},dispatch:f.dispatch}),opts.mismatchOptions||opts.mismatchQuestions?/RUN_OPTIONS_MISMATCH/:/PDF_HASH_OR_RESIDENCY_MISMATCH/)
    } finally { await rm(f.root,{recursive:true,force:true}) }
  }
})

test('rejects an output directory inside the repository before creating it',async()=>{
  const f=await fixture()
  try {
    await assert.rejects(compareRuns({leftPlanPath:join(f.root,'left-plan.json'),rightPlanPath:join(f.root,'right-plan.json'),leftRunPath:f.left,rightRunPath:f.right,selectionPath:f.path,outPath:join(process.cwd(),'comparison-test-output'),createAnalysis:async()=>f.analysis}),/COMPARE_OUTPUT_UNSAFE/)
  } finally { await rm(f.root,{recursive:true,force:true}) }
})

test('rejects output beneath any other git worktree ancestor',async()=>{
  const f=await fixture()
  try {
    await writeFile(join(f.root,'.git'),'synthetic git marker')
    await assert.rejects(compareRuns({leftPlanPath:join(f.root,'left-plan.json'),rightPlanPath:join(f.root,'right-plan.json'),leftRunPath:f.left,rightRunPath:f.right,selectionPath:f.path,outPath:join(f.root,'private-out'),createAnalysis:async()=>f.analysis}),/COMPARE_OUTPUT_IN_GIT/)
  } finally { await rm(f.root,{recursive:true,force:true}) }
})
