import test from 'node:test'
import assert from 'node:assert/strict'
import { TOOL_SPECS, requestFromTool, registerLibraryTools } from '../src/harness/tools.mjs'
import { paperRetrievalGuidance } from '../src/harness/paper-retrieval.mjs'
import { companionQuestion } from '../src/harness/companion-queue.mjs'

test('retrieval tools expose a closed read-only scope and preserve continuation fields', async () => {
  const calls=[], registered=new Map(), hooks=[]
  registerLibraryTools({tools:{register:tool=>{registered.set(tool.name,tool);return()=>{}}},on:(name,fn)=>{hooks.push(fn);return()=>{}}}, value=>value, async (request,options)=>{calls.push({request,options});return {pages:[]}}, {library:'/synthetic-library'}, {requireToolApproval:true})
  for(const [name,args] of [['library_paper_search',{id:'paper-1',query:'Word2Vec',start_page:13,page_limit:12,expected_version:'version'}],['library_paper_read',{id:'paper-1',pages:[22],text_offset:4000,expected_version:'version'}]]){
    const spec=TOOL_SPECS.find(v=>v.name===name)
    assert.equal(spec.mutate,undefined)
    const request=requestFromTool(spec,{...args,library:'/elsewhere',python:'unsafe',action:'delete'}, {})
    assert.deepEqual(request,{action:spec.action,...args})
    const decision=await hooks[0]({name},async()=>({kind:'allow'}));assert.equal(decision.kind,'allow')
    await registered.get(name).execute(args,{signal:new AbortController().signal})
    assert.deepEqual(calls.at(-1).request,request);assert.equal(calls.at(-1).options.library,'/synthetic-library')
  }
})

test('guidance requires cross-section retrieval without broad scans or duplicate annotations',()=>{
  const guidance=paperRetrievalGuidance('synthetic-1')
  assert.match(guidance,/paper_id="synthetic-1"/)
  for(const term of ['library_paper_search','library_paper_read','library_paper_view','region=','next_page','next_offset','expected_version','24000'])assert.ok(guidance.includes(term))
  assert.match(companionQuestion,/主动检索、读取相关原文后再判断/)
  assert.match(guidance,/不另调用批注写入工具/)
})
