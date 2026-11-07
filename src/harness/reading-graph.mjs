import { compileReadingGraph } from '../reading-questions.mjs'
import { readQuestionGroup } from './question-analysis.mjs'

const PAGE_SIZE = 12
const fail = message => Object.assign(new Error(message), {code:'ANALYSIS_GRAPH_INVALID',status:409})
const count = value => Number.isSafeInteger(value) && value >= 0
const integer = (value, name) => {if(!count(value))throw fail(`${name}无效。`);return value}
const base = {editable:false,provenance:'analysis-answer',status:'needs-review'}
const edge = (source,target,relation='contains',evidence={}) => ({...base,id:`${source}:${relation}:${target}`,source,target,relation,evidence})
const sourceEvidence = ref => ref ? {page:ref.page,quote:ref.quote,source:ref.source_id,note:'已保存的分析来源快照；AI 判断待核对。'} : {}

/** 完整判断是事实源；仅缓存目录，不缓存正文或把旧有界草稿当作全集。 */
export function createReadingGraph({store,kernel,batchKey}) {
  const cache=new Map()
  async function directory(record) {
    const cacheKey=`${record.key}:${record.revision}`
    if(cache.has(cacheKey))return cache.get(cacheKey)
    const promise=(async()=>{
      const job=record.value,config=job.questionnaire_snapshot
      if(!config?.questions?.length)throw fail('此分析没有可浏览的问题记录。')
      const questions=config.questions.filter(q=>job.questionnaire.groups.flat().includes(q.id)).map(q=>({id:q.id,title:q.title,total:0,valid:0,invalid:0,neutral:0,groups:[]}))
      const byId=new Map(questions.map(q=>[q.id,q])), batches=[]
      let legacyBudget=0,relationLimitations=0
      for(let batchIndex=0;batchIndex<(job.batch_count||0);batchIndex++) {
        const batch=(await store.get(batchKey(job.id,job.request_id,batchIndex))).value
        if(!batch||!Array.isArray(batch.question_keys))throw fail(`第 ${batchIndex+1} 批目录缺失，不能显示为完整图谱。`)
        batches.push({source_ids:batch.source_ids})
        legacyBudget+=(batch.compilation?.excluded_answers||[]).filter(a=>a.reason==='graph-budget-whole-answer-omitted').length
        relationLimitations+=(batch.compilation?.limitations||[]).length
        // 单题记录已有严格回答预算；旧任务按需读取一次后兼容，不调用模型。
        for(const key of batch.question_keys) {
          const group=(await store.get(key)).value
          if(!group)throw fail('判断目录缺失，不能跳过。')
          let counts=group.graph_counts
          if(!counts){
            const saved=await readQuestionGroup(store,key)
            if(saved.missing_parts?.length)throw fail('判断记录缺片，请先恢复保存；没有把缺片当作零项。')
            counts={}
            for(const answer of saved.answers){const row=counts[answer.question_id]||={total:0,valid:0,invalid:0,neutral:0};row.total++;row[answer.valid?'valid':'invalid']++;if(answer.neutral)row.neutral++}
          }
          for(const [id,c] of Object.entries(counts)) {
            const q=byId.get(id)
            if(!q||!['total','valid','invalid','neutral'].every(k=>count(c[k]))||c.valid+c.invalid!==c.total||c.neutral>c.total)throw fail('判断目录与题库不一致。')
            for(const k of ['total','valid','invalid','neutral'])q[k]+=c[k]
            if(c.total)q.groups.push({key,batch_index:batchIndex,total:c.total})
          }
        }
      }
      const totals={total_answers:0,valid_answers:0,invalid_answers:0,neutral_answers:0}
      for(const q of questions){totals.total_answers+=q.total;totals.valid_answers+=q.valid;totals.invalid_answers+=q.invalid;totals.neutral_answers+=q.neutral}
      return {questions,byId,batches,...totals,legacy_budget_omissions:legacyBudget,relation_limitations:relationLimitations}
    })()
    cache.set(cacheKey,promise)
    while(cache.size>2)cache.delete(cache.keys().next().value)
    try{return await promise}catch(error){cache.delete(cacheKey);throw error}
  }
  async function groupAnswers(span,qid){
    const group=await readQuestionGroup(store,span.key)
    if(!group||group.missing_parts?.length)throw fail('判断内容缺片，请先恢复保存。')
    const answers=group.answers.filter(a=>a.question_id===qid)
    if(answers.length!==span.total)throw fail('判断数量已改变，请刷新全文图谱。')
    return answers
  }
  return async function readingGraph(input,record){
    if(input.offset!==undefined)integer(input.offset,'分页位置')
    if(input.batch_index!==undefined)integer(input.batch_index,'批次')
    if(input.question_id!==undefined&&(typeof input.question_id!=='string'||input.question_id.length>100))throw fail('问题标识无效。')
    if(input.answer_id!==undefined&&(typeof input.answer_id!=='string'||input.answer_id.length>100||!input.question_id||input.batch_index===undefined))throw fail('查看判断需指定问题、批次和回答标识。')
    const empty={nodes:[],edges:[],truncated:false,reading:{level:'overview',status:'idle',total_answers:0,valid_answers:0,questions:[]}}
    if(!record?.value){if(input.request_id)throw fail('指定的分析记录不存在。');return empty}
    const job=record.value
    if(!job.questionnaire_snapshot)return {...empty,reading:{...empty.reading,status:'unsupported'}}
    const index=await directory(record),paper=await kernel({action:'get',id:job.id})
    const publicQuestions=index.questions.map(({groups,...q})=>q)
    const reading={request_id:job.request_id,status:job.status,level:'overview',total_answers:index.total_answers,valid_answers:index.valid_answers,invalid_answers:index.invalid_answers,neutral_answers:index.neutral_answers,legacy_budget_omissions:index.legacy_budget_omissions,relation_limitations:index.relation_limitations,questions:publicQuestions,completed_batches:job.batch_count||0,full_document:job.coverage?.full_document===true}
    const graph={nodes:[],edges:[],truncated:false,reading,warnings:[...(index.legacy_budget_omissions?[`旧摘要图省略的 ${index.legacy_budget_omissions} 项均可在此展开。`]:[]),...(index.relation_limitations?[`${index.relation_limitations} 条关系类型提示保留在相应判断中，不猜测连线。`]:[])],scope:{kind:'paper',paper_id:job.id},semantics:'Complete saved judgments, progressively expanded; AI output is not a verified claim.'}
    const paperNode={...base,id:job.id,paper_id:job.id,type:'paper',label:paper.title||'本文',description:'展开问题，查看所有已保存判断及其原文依据。',evidence:{}}
    const questionNode=q=>({...base,provenance:'analysis-group',id:`reading-question:${q.id}`,paper_id:job.id,type:'topic',label:`${q.title} · ${q.total}`,description:`${q.total} 项判断；${q.valid} 项通过来源校验，${q.invalid} 项待修正。`,evidence:{},reading_target:{question_id:q.id}})
    const answerNode=(answer,batchIndex)=>({...base,id:`reading-answer:${batchIndex}:${answer.id}`,paper_id:job.id,type:answer.valid?'claim':'question',label:answer.judgment||answer.choice,description:answer.judgment||answer.choice,evidence:sourceEvidence(answer.evidence?.[0]),valid:answer.valid,neutral:answer.neutral,answer_id:answer.id,batch_index:batchIndex,reading_target:{question_id:answer.question_id,answer_id:answer.id,batch_index:batchIndex}})
    if(input.question_id===undefined){
      graph.nodes.push(paperNode,...index.questions.map(questionNode));graph.edges.push(...graph.nodes.slice(1).map(n=>edge(job.id,n.id)));return graph
    }
    const q=index.byId.get(input.question_id)
    if(!q)throw fail('问题不属于这次分析。')
    const center=questionNode(q);delete center.reading_target
    Object.assign(reading,{level:'question',question_id:q.id,total:q.total,limit:PAGE_SIZE})
    if(input.answer_id===undefined){
      const offset=input.offset??0;if(offset>=q.total&&offset!==0)throw fail('分页位置超出当前问题，请返回第一页。')
      Object.assign(reading,{offset,next_offset:offset+PAGE_SIZE<q.total?offset+PAGE_SIZE:null,previous_offset:offset?Math.max(0,offset-PAGE_SIZE):null})
      graph.nodes.push(center);let skipped=0,remaining=PAGE_SIZE
      for(const span of q.groups){
        if(skipped+span.total<=offset){skipped+=span.total;continue}
        const answers=await groupAnswers(span,q.id),start=Math.max(0,offset-skipped)
        for(const answer of answers.slice(start,start+remaining)){const node=answerNode(answer,span.batch_index);graph.nodes.push(node);graph.edges.push(edge(center.id,node.id));remaining--}
        skipped+=span.total;if(!remaining)break
      }
      return graph
    }
    const spans=q.groups.filter(g=>g.batch_index===input.batch_index)
    let answer
    for(const span of spans){answer=(await groupAnswers(span,q.id)).find(a=>a.id===input.answer_id);if(answer)break}
    if(!answer)throw fail('回答不属于当前问题或批次。')
    Object.assign(reading,{level:'answer',answer_id:answer.id,batch_index:input.batch_index,answer,limitations:[]})
    const root=answerNode(answer,input.batch_index);delete root.reading_target;graph.nodes.push(root)
    if(!answer.valid||answer.neutral){reading.limitations=answer.valid?['此项记录未报告／不适用，不生成肯定的事实关系。']:['此项未通过来源或结构检查；仅展示原记录，不生成事实关系。',...(answer.errors||[]).map(e=>e.message)];return graph}
    const refs=[...answer.evidence,...(answer.target_claim?[answer.target_claim]:[])],ids=[...new Set(refs.map(r=>r.source_id))]
    if(ids.some(id=>!index.batches[input.batch_index]?.source_ids.includes(id)))throw fail('判断来源不属于保存的批次。')
    const sources=await Promise.all(ids.map(id=>kernel({action:'knowledge_source_get',id})))
    if(sources.some((s,i)=>s.id!==ids[i]||s.entity?.kind!=='paper'||s.entity.id!==job.id))throw fail('原文快照身份不匹配。')
    const compiled=compileReadingGraph([answer],{sources,source_ids:ids},job.questionnaire_snapshot)
    if(compiled.compilation.excluded_answers.length||compiled.compilation.truncated)throw fail('此判断原文无法完整复核，不能显示不完整的证据图。')
    reading.limitations=compiled.compilation.limitations
    const byNode=new Map(compiled.nodes.map(n=>[`${n.type}:${n.id}`,n]))
    const evidence=n=>{const support=n.source_id?n:byNode.get(n.source_node)||byNode.get(n.fields?.evidence_node);return support?.source_id?{page:sources.find(s=>s.id===support.source_id)?.locator?.page,quote:support.quote,source:support.source_id,note:'已保存的原文快照；AI 判断待核对。'}:{}}
    const prefix=`reading-detail:${input.batch_index}:`
    for(const n of compiled.nodes){const id=prefix+`${n.type}:${n.id}`;graph.nodes.push({...base,id,paper_id:job.id,type:n.type,label:n.label,description:n.fields?.relation_reason||n.label,evidence:evidence(n)});graph.edges.push(edge(root.id,id,'contains'))}
    for(const e of [...compiled.edges,...compiled.assertions])graph.edges.push({...edge(prefix+e.subject,prefix+e.object,e.relation,evidence(byNode.get(e.subject)||{})),paper_id:job.id})
    return graph
  }
}
