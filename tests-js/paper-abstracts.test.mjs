import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { createFetchHandler } from '../src/http.mjs'
import { createLanguageLearning } from '../src/harness/language-learning.mjs'
import { createLocalStateStore } from '../src/local-state.mjs'

const require=createRequire(import.meta.url)
let JSDOM
try{({JSDOM}=require(process.env.JSDOM_MODULE||'jsdom'))}catch{}

const abstract='This synthetic abstract contains a strictly bounded source for the translation test.'
async function fixture(t,{model=true,failFirst=false,fetchOptions}={}){
  const root=await mkdtemp(join(tmpdir(),'synthetic-abstracts-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const library=join(root,'library'),localStateHome=join(root,'state'),store=createLocalStateStore({library,home:localStateHome})
  const prompts=[]
  const languageLearning=createLanguageLearning({store,getDefaultModel:async()=>({provider:'synthetic',model:'translator'}),
    ai:async({prompt})=>{prompts.push(prompt);if(failFirst&&prompts.length===1)throw Error('Synthetic failure');return JSON.stringify({result:'这是用于测试的合成摘要译文。'});}})
  const handle=createFetchHandler({library,localStateHome,fetchOptions,...(model?{languageLearning}:{})})
  const call=async input=>{
    const response=await handle(new Request('http://localhost/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)}))
    return response.json()
  }
  const paper=(await call({action:'create',metadata:{title:'Synthetic abstract paper',abstract}})).result
  return {call,paper,prompts}
}

test('reads saved original, rejects a forged source hash and caches one verified translation',async t=>{
  const {call,paper,prompts}=await fixture(t)
  const read=await call({action:'paper_abstract_read',id:paper.id})
  assert.equal(read.result.text,abstract)
  assert.equal(read.result.source.kind,'catalog')
  assert.equal(read.result.translation_status,'ready')
  const request={action:'paper_abstract_translate',id:paper.id,source_hash:read.result.source_hash,target_language:read.result.target_language}
  assert.equal((await call({...request,source_hash:'f'.repeat(64)})).ok,false)
  assert.equal(prompts.length,0)
  const results=await Promise.all([call({...request,text:'forged source'}),call(request)])
  assert.equal(results[0].result.translation.text,'这是用于测试的合成摘要译文。')
  assert.deepEqual(results[0],results[1])
  assert.equal(prompts.length,1)
  assert.ok(prompts[0].includes(abstract)&&!prompts[0].includes('forged source'))
  const reopened=await call({action:'paper_abstract_read',id:paper.id})
  assert.equal(reopened.result.translation_status,'complete')
  assert.equal((await call({action:'get',id:paper.id})).result.abstract,abstract)
})

test('a failed translation keeps the original and requires a manual retry',async t=>{
  const {call,paper,prompts}=await fixture(t,{failFirst:true})
  const {result}=await call({action:'paper_abstract_read',id:paper.id})
  const request={action:'paper_abstract_translate',id:paper.id,source_hash:result.source_hash,target_language:result.target_language}
  assert.equal((await call(request)).ok,false)
  const reopened=await call({action:'paper_abstract_read',id:paper.id})
  assert.equal(reopened.result.text,abstract)
  assert.equal(reopened.result.translation_status,'failed')
  assert.equal((await call(request)).result.translation_status,'failed')
  assert.equal(prompts.length,1)
  assert.equal((await call({...request,retry:true})).result.translation_status,'complete')
})

test('a topic source can supply a matching abstract, with no model in standalone mode',async t=>{
  const {call}=await fixture(t,{model:false})
  const imported=await call({action:'field_radar_import',expected_revision:0,document:{schema_version:1,
    topic:{id:'synthetic-topic',title:'Synthetic topic',question:'How are abstracts sourced?'},
    papers:[{id:'p1',title:'Synthetic abstract paper',source_ids:['s1']},{id:'p2',title:'Different synthetic paper',summary:'This is not the source abstract.',source_ids:['s1']}],
    sources:[{id:'s1',title:'Synthetic abstract paper',url:'https://example.org/article',abstract}],scholars:[],claims:[]}})
  assert.equal(imported.ok,true,imported.error)
  const query={action:'paper_abstract_read',topic_id:'synthetic-topic',id:'p1',expected_revision:imported.result.revision}
  const {result}=await call(query)
  assert.equal(result.text,abstract)
  assert.equal(result.source.kind,'radar')
  assert.equal(result.translation_status,'unavailable')
  assert.equal((await call({...query,id:'p2'})).result.text,null)
  assert.equal((await call({...query,expected_revision:'old'})).ok,false)
})

test('a missing original can be read by known DOI from the matching public record',async t=>{
  const doi='10.1234/synthetic-abstract', requests=[]
  const fetchOptions={resolver:async()=>[{address:'93.184.215.14',family:4}],transport:async({url})=>{
    requests.push(url.href)
    const payload=url.hostname==='api.crossref.org'?'{}':url.hostname==='api.datacite.org'?JSON.stringify({data:{attributes:{
      doi,types:{resourceTypeGeneral:'JournalArticle'},titles:[{title:'DOI abstract paper'}],
      descriptions:[{descriptionType:'Other',description:'Not the abstract'},{descriptionType:'Abstract',description:abstract}]
    }}}):''
    return {statusCode:200,headers:{},body:Readable.from([Buffer.from(payload)]),close(){this.body.destroy()}}
  }}
  const {call}=await fixture(t,{model:false,fetchOptions})
  const paper=(await call({action:'create',metadata:{title:'DOI abstract paper',DOI:doi}})).result
  const {result}=await call({action:'paper_abstract_read',id:paper.id})
  assert.equal(result.text,abstract)
  assert.deepEqual(result.source,{kind:'doi',url:`https://doi.org/${doi}`})
  assert.deepEqual(requests.map(value=>new URL(value).hostname),['api.crossref.org','api.datacite.org'])
  assert.ok(requests.every(value=>decodeURIComponent(value).endsWith(doi)))
})

test('opening the abstract shows the original before automatic translation finishes',{skip:!JSDOM},async t=>{
  const dom=new JSDOM('<body></body>',{runScripts:'outside-only'})
  t.after(()=>dom.window.close())
  const {window}=dom
  window.HTMLDialogElement.prototype.showModal=function(){this.open=true}
  window.eval(await readFile(new URL('../web/paper-abstract.js',import.meta.url),'utf8'))
  const calls=[],sourceHash='a'.repeat(64)
  let finishTranslation
  const ui=window.PaperAbstract.create({api:async(action,args)=>{
    calls.push({action,args})
    if(action==='paper_abstract_read')return {title:'Synthetic abstract paper',text:abstract,source:{kind:'pdf',page:1},source_hash:sourceHash,target_language:'zh-CN',translation_status:'ready'}
    return new Promise(resolve=>{finishTranslation=resolve})
  }})
  await ui.open({id:'paper-id'},'Synthetic abstract paper')
  const dialog=window.document.querySelector('dialog')
  assert.ok(dialog.textContent.includes(abstract))
  assert.match(dialog.textContent,/PDF 第 1 页.*正在翻译摘要/)
  assert.equal(calls[1].action,'paper_abstract_translate')
  assert.equal(calls[1].args.source_hash,sourceHash)
  assert.equal(calls[1].args.retry,false)
  finishTranslation({translation_status:'complete',translation:{text:'合成摘要译文',target_language:'zh-CN',model:{provider:'synthetic',model:'translator'}}})
  await new Promise(resolve=>setImmediate(resolve))
  assert.match(dialog.textContent,/AI 译文.*合成摘要译文/)
  assert.ok(dialog.textContent.includes(abstract))
})
