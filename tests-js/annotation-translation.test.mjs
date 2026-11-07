import test from 'node:test'
import assert from 'node:assert/strict'
import { createAnnotationTranslation } from '../src/harness/annotation-translation.mjs'
import { createFetchHandler } from '../src/http.mjs'

const input = { action:'annotation_translate', id:'synthetic', annotation_id:'note-1', version:'a'.repeat(64) }
function fixture() {
  let value=null, revision=0, generated=0, saved=null, failSave=false, generationError=null
  const store={get:async()=>({value,revision}),put:async(k,v,r)=>{assert.equal(r,revision);value=v;return {value,revision:++revision}}}
  const f={calls:[],source:'Complete source annotation.', set failSave(v){failSave=v},set generationError(v){generationError=v},get generated(){return generated}}
  const completed=new Map()
  f.options={store,languageLearning:async req=>{
    if(req.action==='language_settings_get')return{value:{target_language:'auto'}}
    f.calls.push(req)
    if(generationError)throw generationError
    if(!completed.has(req.request_id)){generated++;completed.set(req.request_id,{result:'完整的来源批注。',model:{provider:'test',model:'synthetic'}})}
    return completed.get(req.request_id)
  },dispatch:async req=>{
    if(req.action==='annotation_context_exact')return {annotations:[{id:'note-1',page:1,text:f.source,comment:''}]}
    if(req.text){if(failSave)throw Error('PDF save failed'); saved={saved:true,annotation:{comment:'翻译：'+req.text}};return saved}
    return saved?{...saved,duplicate:true}:{saved:false}
  }}
  f.handle=createAnnotationTranslation(f.options);return f
}
test('full source and configured target, concurrent duplicate and saved PDF replay',async()=>{
  const f=fixture();const [a,b]=await Promise.all([f.handle(input),f.handle({...input,text:'forged'})]);assert.ok(a.saved&&b.saved);assert.equal(f.generated,1)
  assert.equal(f.calls[0].text,f.source);assert.equal(f.calls[0].target_language,'zh-CN')
  assert.equal((await createAnnotationTranslation(f.options)(input)).duplicate,true);assert.equal(f.generated,1)
})
test('retry after PDF failure reuses durable language result',async()=>{
  const f=fixture();f.failSave=true;await assert.rejects(f.handle(input),/PDF save/);f.failSave=false
  assert.ok((await createAnnotationTranslation(f.options)({...input,retry:true})).saved);assert.equal(f.generated,1)
})
test('reject absent version and long source before invoking the model',async()=>{
  const f=fixture();await assert.rejects(f.handle({...input,version:null}),/刷新/);f.source='x'.repeat(8001);await assert.rejects(f.handle(input),/8000/);assert.equal(f.generated,0)
})
test('standalone rejects translation and browser cannot forge a saved translation',async()=>{
  const handler=createFetchHandler()
  for(const [action,status]of [['annotation_translate',400],['annotation_translation_result',403]]){
    const r=await handler(new Request('http://localhost/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...input,action})}));assert.equal(r.status,status)
  }
})

test('a fresh model failure is not immediately resubmitted even when the client requested retry',async()=>{
  const f=fixture();f.generationError=Object.assign(Error('synthetic generation failed'),{code:'LANGUAGE_FAILED'})
  await assert.rejects(f.handle({...input,retry:true}),/synthetic generation failed/);assert.equal(f.calls.length,1)
})
