import test from 'node:test'
import assert from 'node:assert/strict'
import { selectCaptionModel } from '../src/harness/ai.mjs'

function host(entries) {
  const checked=[]
  return {checked,listProviders:()=>[...new Set(entries.map(e=>e.provider))].map(id=>({id})),listModels:async provider=>entries.filter(e=>e.provider===provider),resolveModelInfo:async(provider,id)=>{checked.push([provider,id]);const result=entries.find(e=>e.provider===provider&&e.id===id);if(!result)throw Error('unavailable');return result}}
}
const text={provider:'kimi',id:'text',inputModalities:['text']},flash={provider:'deepseek-official',id:'deepseek-flash',inputModalities:['text','image']},vision={provider:'other',id:'vision',inputModalities:['image']}
test('text-only route automatically selects configured Flash ahead of other vision routes',async()=>{
 const llm=host([text,vision,flash]),current={provider:'kimi',model:'text',reasoningEffort:'high'}
 assert.deepEqual(await selectCaptionModel(llm,current),{provider:flash.provider,model:flash.id})
 assert.deepEqual(current,{provider:'kimi',model:'text',reasoningEffort:'high'})
 assert.equal(llm.checked.length,2)
})
test('working vision route stays selected; absent or text-only Flash is never assumed visual',async()=>{
 const llm=host([text,vision,{...flash,inputModalities:['text']}])
 const current={provider:'other',model:'vision',reasoningEffort:'low'}
 assert.equal(await selectCaptionModel(llm,current),current)
 assert.deepEqual(await selectCaptionModel(llm,{provider:'kimi',model:'text'}),{provider:'other',model:'vision'})
 assert.deepEqual(await selectCaptionModel(host([vision]),null),{provider:'other',model:'vision'})
})
test('unknown capabilities fail visibly; cancellation stops a stalled discovery',async()=>{
 await assert.rejects(selectCaptionModel(host([text,{...flash,inputModalities:undefined}]),{provider:'kimi',model:'text'}),{code:'ANNOTATION_CAPTION_MODEL_REQUIRED'})
 const llm=host([]);llm.listProviders=()=>[{id:'slow'}];llm.listModels=()=>new Promise(()=>{});
 const abort=new AbortController(),pending=selectCaptionModel(llm,null,abort.signal);abort.abort(Error('cancelled'));
 await assert.rejects(pending,/cancelled/)
})
test('fallback capability checks stay bounded',async()=>{
 const entries=Array.from({length:100},(_,i)=>({provider:'test',id:`m${i}`,inputModalities:['text']})),llm=host(entries)
 await assert.rejects(selectCaptionModel(llm,null),{code:'ANNOTATION_CAPTION_MODEL_REQUIRED'});assert.equal(llm.checked.length,32)
})
