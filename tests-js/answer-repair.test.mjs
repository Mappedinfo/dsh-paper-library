import test from 'node:test'
import assert from 'node:assert/strict'
import {repairAnswers} from '../src/harness/answer-repair.mjs'
import {loadQuestionnaire,parseReadingAnswers} from '../src/reading-questions.mjs'
const config=loadQuestionnaire(),q=['q1_method']
const pack={sources:[{id:'s1',entity:{kind:'paper',id:'synthetic'},locator:{page:1},content_hash:'synthetic',text:'A ﬁne source-\ntarget example used Method A. Another invented comparison is not evidence.'}],source_ids:['s1']}
const item=quote=>({question_id:q[0],choice:'method',judgment:'合成练习中的方法。',evidence:[{source_id:'S1',quote}]})
function saved(answers){const raw=JSON.stringify({answers});return {...parseReadingAnswers(raw,pack,q,config),raw_complete:true}}

test('PDF typography restores exact source span without fuzzy punctuation or ambiguous matches',()=>{
 const a=parseReadingAnswers(JSON.stringify({answers:[item('fine source-target example')]}),pack,q,config).answers[0]
 assert.equal(a.valid,true);assert.equal(a.evidence[0].match,'unique-pdf-typography')
 assert.equal(pack.sources[0].text.slice(a.evidence[0].start_utf16,a.evidence[0].end_utf16),a.evidence[0].quote)
 assert.equal(a.evidence[0].quote,'ﬁne source-\ntarget example')
 for(const quote of ['fine source target example','fine source—target example','fine source-target EXAMPLE'])assert.equal(parseReadingAnswers(JSON.stringify({answers:[item(quote)]}),pack,q,config).answers[0].valid,false)
 const duplicate={...pack,sources:[{...pack.sources[0],text:'ﬁne source-\ntarget example; ﬁne source-target example'}]}
 assert.equal(parseReadingAnswers(JSON.stringify({answers:[item('fine source-target example')]}),duplicate,q,config).answers[0].valid,false)
})

test('targeted repair retains valid answers and requires exactly the failed identifiers',async()=>{
 const previous=saved([item('used Method A.'),item('invented quote')]);let calls=0
 const result=await repairAnswers(previous,pack,q,config,async prompt=>{calls++;assert.match(prompt,/修订任务/);return JSON.stringify({repairs:[{answer_id:previous.answers[1].id,reason:'用原文中的连续片段替换错误引文。',answer:item('source-\ntarget example used Method A.')}]})})
 assert.equal(calls,1);assert.equal(result.parsed.answers.length,2);assert.equal(result.parsed.answers[0].id,previous.answers[0].id)
 assert.ok(result.parsed.answers.every(a=>a.valid));assert.equal(result.log[0].status,'repaired')
 await assert.rejects(repairAnswers(previous,pack,q,config,async()=>JSON.stringify({repairs:[{answer_id:previous.answers[0].id,reason:'越界',answer:item('used Method A.') }]})),/越界/)
})

test('withdrawal is explicit and unsupported replacement stays unresolved',async()=>{
 const previous=saved([item('used Method A.'),item('unsupported fabricated quote')])
 const base={answer_id:previous.answers[1].id,reason:'原文未支持该项。'}
 const withdrawn=await repairAnswers(previous,pack,q,config,async()=>JSON.stringify({repairs:[{...base,withdrawn:true}]}))
 assert.equal(withdrawn.log[0].status,'withdrawn');assert.equal(withdrawn.parsed.answers.length,1)
 const unresolved=await repairAnswers(previous,pack,q,config,async()=>JSON.stringify({repairs:[{...base,answer:item('still fabricated')}]}))
 assert.equal(unresolved.log[0].status,'unresolved');assert.equal(unresolved.parsed.answers[1].valid,false)
 let calls=0;await repairAnswers(saved([item('used Method A.')]),pack,q,config,async()=>{calls++});assert.equal(calls,0)
})

test('a repair cannot invalidate a later valid answer by duplicating it or introducing neutral conflicts',async()=>{
 const bad=item('invented quote'),good=item('used Method A.'),previous=saved([bad,good]);
 await assert.rejects(repairAnswers(previous,pack,q,config,async()=>JSON.stringify({repairs:[{answer_id:previous.answers[0].id,reason:'复制后面的有效回答会导致重复判错。',answer:good}]})),/已有有效回答冲突/)
 await assert.rejects(repairAnswers(previous,pack,q,config,async()=>JSON.stringify({repairs:[{answer_id:previous.answers[0].id,reason:'不能用未报告否定已有肯定回答。',answer:{question_id:q[0],choice:'not_reported',judgment:'未见方法。',evidence:[]}}]})),/已有有效回答冲突/)
});

test('typography normalization cannot accept a substring inside a PDF ligature',()=>{
 const input={...pack,sources:[{...pack.sources[0],text:'ﬁeld and oﬃce.'}]}
 for(const quote of ['ield','ofice','fice'])assert.equal(parseReadingAnswers(JSON.stringify({answers:[item(quote)]}),input,q,config).answers[0].valid,false)
});

test('a failed semantic repair remains retryable after typography validation recovers',async()=>{
 const previous=saved([item('used Method A.'),item('fine source-target example')]);
 const target=previous.answers[1].id;
 previous.request_error={code:'PAPER_ANALYSIS_INCOMPLETE',message:'Synthetic incomplete response'};
 previous.repair_log=[{previous_id:target,status:'unresolved',reason:'Semantic review did not finish.'}];
 let calls=0;
 const result=await repairAnswers(previous,pack,q,config,async()=>{calls++;return JSON.stringify({repairs:[{answer_id:target,reason:'复查后缩小判断并保留原文。',answer:{...item('fine source-target example'),judgment:'合成例子涉及源与目标。'}}]})});
 assert.equal(calls,1);assert.equal(result.log[0].status,'repaired');assert.equal(result.parsed.answers[0].id,previous.answers[0].id);
 assert.ok(result.parsed.answers.every(a=>a.valid));
 await assert.rejects(repairAnswers({...previous,repair_log:[]},pack,q,config,async()=>''),/响应不完整/);
});
