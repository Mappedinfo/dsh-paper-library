import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadQuestionnaire, questionGroups, makeReadingPrompt, parseReadingAnswers, compileReadingGraph } from '../src/reading-questions.mjs'
import { analysisQuestionOptions, validQuestionIds } from '../src/analysis-input.mjs'
import { renderNotePrompt, renderReviewPrompt, renderKnowledgePrompt } from '../src/prompt-templates.mjs'
import { paperRetrievalGuidance } from '../src/harness/paper-retrieval.mjs'
import { bundledLibrarySkills } from '../src/harness/skills.mjs'

const config = loadQuestionnaire()
const previous = JSON.parse(readFileSync(new URL('./fixtures/reading-protocol-v4.json', import.meta.url)))
const dimensions = ['source','scope','granularity','creation','access','use']
const added = [...['q7_mobility','q8_building'].flatMap(prefix => dimensions.map(d => prefix+'_'+d)), 'q9_method_naming']
function pack(text) {
  const source = { id:'synthetic-data-method-source', kind:'source-note', entity:{kind:'paper',id:'synthetic-data-method-paper'}, text, locator:{page:3} }
  return {paper:{id:source.entity.id},sources:[source],source_ids:[source.id]}
}

test('v5 keeps all 23 v4 question identities and schedules every new dimension exactly once', () => {
  assert.deepEqual(config.protocol.question_ids, [...previous.question_ids,...added])
  assert.equal(new Set(config.protocol.question_ids).size,36)
  assert.deepEqual(questionGroups(config), config.protocol.question_ids.map(id=>[id]))
  assert.equal(validQuestionIds(config.protocol.question_ids),true)
  assert.deepEqual(analysisQuestionOptions({question_ids:added}),{question_ids:added})
  assert.equal(validQuestionIds([...config.protocol.question_ids,'invented']),false)
})

test('all new questions locate synthetic evidence and retain independent question coverage', () => {
  for(const id of added) {
    const question=config.questions.find(q=>q.id===id), example=question.examples[0], input=pack(example.source_text)
    const result=parseReadingAnswers(JSON.stringify({answers:[{question_id:id,choice:example.choice,judgment:example.judgment,evidence:[{source_id:'S1',quote:example.source_text}]}]}),input,[id],config)
    assert.deepEqual(result.errors,[],id)
    assert.deepEqual(result.missing,[],id)
    assert.equal(result.answers[0].evidence[0].source_id,input.source_ids[0])
    assert.equal(result.answers[0].evidence[0].page,3)
    const graph=compileReadingGraph(result,input,config)
    assert.ok(graph.nodes.some(n=>n.type==='claim'&&n.fields?.question_id===id),id)
    assert.ok(graph.assertions.some(a=>a.relation==='reports'),id)
  }
})

test('missing building information is an explicit scoped answer and never an invented graph fact', () => {
  const id='q8_building_source', input=pack('The synthetic excerpt reports travel-diary data only.')
  const result=parseReadingAnswers(JSON.stringify({answers:[{question_id:id,choice:'not_reported',judgment:'本批未说明建筑数据，不能判断全文是否使用。',evidence:[]}]}),input,[id],config)
  assert.deepEqual(result.missing,[])
  assert.equal(result.answers[0].neutral,true)
  assert.deepEqual(compileReadingGraph(result,input,config).nodes,[])
  const omitted=parseReadingAnswers(JSON.stringify({answers:[]}),input,[id],config)
  assert.deepEqual(omitted.missing,[id])
  const invented=parseReadingAnswers(JSON.stringify({answers:[{question_id:id,choice:'source',judgment:'Building observations',evidence:[{source_id:'S1',quote:'Invented building dataset'}]}]}),input,[id],config)
  assert.equal(invented.answers[0].valid,false)
  assert.deepEqual(compileReadingGraph(invented,input,config).nodes,[])
})

test('stage, access and naming safeguards reach the actual new-question prompts', () => {
  const input=pack('Synthetic materials.')
  for(const prefix of ['q7_mobility','q8_building']) {
    const prompt=makeReadingPrompt(input,[prefix+'_use'],config)
    for(const stage of ['train','validation','test','calibration','inference','参数来源']) assert.ok(prompt.includes(stage),stage)
    assert.match(prompt,/保留原词/)
    const access=makeReadingPrompt(input,[prefix+'_access'],config)
    assert.match(access,/代码开源不等于数据开放/)
    assert.match(access,/当前已核验可下载/)
  }
  const naming=makeReadingPrompt(input,['q9_method_naming'],config)
  assert.match(naming,/命名理由写未说明/)
  assert.match(naming,/机制解释须标读者解释/)
  assert.match(naming,/不得反推缩写全称/)
  const question=config.questions.find(q=>q.id==='q9_method_naming')
  const knownName=question.examples.find(e=>e.source_text.includes('HOP'))
  assert.equal(knownName.choice,'method_naming')
  assert.match(knownName.judgment,/全称与命名理由均未说明/)
})

test('notes, reviews, manual notes and native annotation guidance all carry the three checks', () => {
  for(const prompt of [renderNotePrompt('Synthetic',[],false,0),renderReviewPrompt('Synthetic',[],false,0),renderKnowledgePrompt({mode:'note',entity:{kind:'paper',id:'synthetic'}},[])]) {
    for(const term of ['human mobility','building','method naming','train','validation','test','parameter sources','未说明']) assert.ok(prompt.includes(term),term)
  }
  const native=paperRetrievalGuidance('synthetic-paper')
  for(const term of ['human mobility','建筑','命名','train','validation','test','参数来源','未说明']) assert.ok(native.includes(term),term)
  assert.match(native,/不为凑齐清单启动全文\/全库任务/)
  assert.match(native,/不修改旧批注或回复/)
  const skills=bundledLibrarySkills()
  for(const name of ['paper-library-notes','paper-library-review','paper-library-knowledge']) {
    const skill=skills.find(s=>s.name===name)
    assert.ok(skill.invocation.modelInvocable)
    for(const term of ['human mobility','建筑','命名理由','reading-questions-v5'])assert.ok(skill.content.includes(term),name+term)
  }
})

test('a still-loaded v4 host keeps its compatible manifest while new code reads v5', () => {
  const directory=new URL('../prompts/reading/',import.meta.url)
  const compatible=loadQuestionnaire(directory)
  assert.equal(compatible.version,'reading-questions-v4')
  assert.equal(compatible.questions.length,23)
  assert.deepEqual(compatible.protocol,previous)
  assert.equal(loadQuestionnaire().version,'reading-questions-v5')
  assert.equal(loadQuestionnaire().questions.length,36)
})
