import test from 'node:test'
import assert from 'node:assert/strict'
import {createReadingGraph} from '../src/harness/reading-graph.mjs'
import {loadQuestionnaire,parseReadingAnswers,compileReadingGraph} from '../src/reading-questions.mjs'

function fixture({legacy=true}={}) {
 const config=loadQuestionnaire(),data=new Map(),calls=[],qids=['q1_method','q2_author_claim'],all=[]
 const record={key:'job',revision:'r1',value:{id:'synthetic',request_id:'first',status:'complete',batch_count:2,questionnaire_snapshot:config,questionnaire:{groups:qids.map(q=>[q])},coverage:{full_document:true}}}
 const source=page=>({id:`s${page}`,entity:{kind:'paper',id:'synthetic'},locator:{page},content_hash:'fixture',text:'Method A was used. Experiment B measured C. Result D was reported. Check E before drawing conclusions.'})
 for(let batch=0;batch<2;batch++) {
  const pack={sources:[source(batch+1)],source_ids:[`s${batch+1}`]},keys=[],answers=[]
  for(const qid of qids){
   const key=`q:${batch}:${qid}`,rows=Array.from({length:12},(_,i)=>({question_id:qid,choice:qid==='q1_method'?'method':'author_claim',judgment:`合成判断 ${batch}-${qid}-${i}`,evidence:['Method A was used.','Experiment B measured C.','Result D was reported.','Check E before drawing conclusions.'].map(quote=>({source_id:'S1',quote}))}))
   const parsed=parseReadingAnswers(JSON.stringify({answers:rows}),pack,[qid],config);assert.ok(parsed.answers.every(a=>a.valid))
   const answer_keys=parsed.answers.map((a,i)=>{const ak=`${key}:answer:${i}`;data.set(ak,a);all.push({answer:a,key:ak,batch,question_id:qid});return ak});
   data.set(key,{status:'complete',question_ids:[qid],answer_keys,...(!legacy?{graph_counts:{[qid]:{total:12,valid:12,invalid:0,neutral:0}}}:{})});keys.push(key);answers.push(...parsed.answers)
  }
  data.set(`batch:${batch}`,{source_ids:pack.source_ids,question_keys:keys,compilation:compileReadingGraph(answers,pack,config).compilation})
 }
 const store={get:async key=>{calls.push(key);return {key,value:data.get(key)}}}
 const kernel=async input=>{calls.push(input.action);if(input.action==='get')return {id:'synthetic',title:'Synthetic full graph'};if(input.action==='knowledge_source_get')return source(Number(input.id.slice(1)));throw Error('No PDF parse or model calls permitted')}
 return {api:createReadingGraph({store,kernel,batchKey:(_id,_request,index)=>`batch:${index}`}),record,data,calls,all}
}

test('all judgments including old projection omissions are reachable with bounded overview, pages and evidence graphs',async()=>{
 const f=fixture(),root=await f.api({},f.record)
 assert.equal(root.reading.total_answers,48);assert.equal(root.nodes.length,3);assert.ok(root.reading.legacy_budget_omissions>0)
 const visited=new Set()
 for(const q of root.reading.questions){let offset=0;do{
  const page=await f.api({question_id:q.id,offset},f.record);assert.ok(page.nodes.length<=13)
  for(const node of page.nodes.filter(n=>n.reading_target)){
   const detail=await f.api(node.reading_target,f.record);assert.ok(detail.nodes.length<20);assert.equal(detail.reading.level,'answer');assert.equal(detail.reading.answer.id,node.answer_id)
   assert.equal(detail.nodes.filter(n=>n.type==='evidence').length,4);assert.ok(detail.edges.some(e=>e.relation==='reports'));assert.ok(detail.nodes.filter(n=>n.type==='evidence').every(n=>n.evidence.page===node.batch_index+1));visited.add(`${node.batch_index}:${node.answer_id}`)
  }
  offset=page.reading.next_offset
 }while(offset!==null)}
 assert.equal(visited.size,48);assert.ok(f.all.every(row=>visited.has(`${row.batch}:${row.answer.id}`)))
 assert.equal(f.calls.includes('paper_analysis_batch'),false)
})

test('new group counts avoid loading answer bodies for overview; page renders only its requested window',async()=>{
 const f=fixture({legacy:false});await f.api({},f.record);assert.equal(f.calls.some(k=>k.includes(':answer:')),false)
 f.calls.length=0;const page=await f.api({question_id:'q1_method',offset:12},f.record)
 assert.equal(page.nodes.length,13);assert.equal(page.reading.next_offset,null);assert.equal(page.reading.previous_offset,0)
 assert.ok(f.calls.filter(k=>k.includes(':answer:')).every(k=>k.startsWith('q:1:q1_method:')))
})

test('cross-question selection, invalid offsets, missing records and changed evidence fail visibly',async()=>{
 const f=fixture(),a=f.all[0]
 await assert.rejects(f.api({question_id:'unknown'},f.record),/不属于/)
 await assert.rejects(f.api({question_id:'q1_method',offset:-1},f.record),/无效/)
 await assert.rejects(f.api({question_id:'q1_method',offset:24},f.record),/超出/)
 await assert.rejects(f.api({question_id:'q2_author_claim',answer_id:a.answer.id,batch_index:0},f.record),/不属于/)
 f.data.delete(a.key);await assert.rejects(f.api({question_id:'q1_method',offset:0},f.record),/缺片/)
 const g=fixture();g.data.set(g.all[0].key,{...g.all[0].answer,evidence:[{...g.all[0].answer.evidence[0],quote:'fabricated'}]});await assert.rejects(g.api({question_id:'q1_method',answer_id:g.all[0].answer.id,batch_index:0},g.record),/无法完整复核/)
 assert.equal((await g.api({},null)).reading.status,'idle');await assert.rejects(g.api({request_id:'missing'},null),/不存在/)
})

test('invalid and neutral answers remain visible but cannot create factual relations',async()=>{
 const f=fixture(),a=f.all[0];f.data.set(a.key,{...a.answer,valid:false,errors:[{message:'synthetic invalid'}]})
 const result=await f.api({question_id:a.question_id,answer_id:a.answer.id,batch_index:a.batch},f.record)
 assert.equal(result.nodes.length,1);assert.equal(result.edges.length,0);assert.ok(result.reading.limitations.includes('synthetic invalid'))
})
