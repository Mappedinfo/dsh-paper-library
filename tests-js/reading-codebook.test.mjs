import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadQuestionnaire, questionGroups, makeReadingPrompt, parseReadingAnswers, compileReadingGraph } from '../src/reading-questions.mjs'
import { validateGraph } from '../scripts/probe-paper-analysis-decomposition.mjs'

const config = loadQuestionnaire()
const resultMappings = {
  method_result: { subject_type: 'method', object_type: 'observation', relation: 'produced_by', direction: 'object-to-subject' },
  data_result: { subject_type: 'dataset', object_type: 'observation', relation: 'observed_on', direction: 'object-to-subject' },
  metric_result: { subject_type: 'metric', object_type: 'observation', relation: 'measured_by', direction: 'object-to-subject' },
  task_result: { subject_type: 'task', object_type: 'observation', relation: 'for_task', direction: 'object-to-subject' },
}
const methodDataMapping = { subject_type: 'method', object_type: 'dataset', relation: null, direction: 'none' }

function pack(text = 'Retrieval practice improved recall on StudySet. Recall accuracy measured the gain for the recall task.') {
  const sources = [{ id: 'ks-codebook-learning-page', kind: 'source-note', entity: { kind: 'paper', id: 'synthetic-codebook-paper' }, text, locator: { page: 2 } }]
  return { paper: { id: 'synthetic-codebook-paper', title: 'Synthetic learning text', abstract: 'CATALOG ABSTRACT MUST STAY PRIVATE' },
    sources, source_ids: sources.map(source => source.id), preprocessing: { representation: 'normalized-markdown', raw_verbatim: false },
    coverage: { read_pages: [2], full_document: false } }
}
function answer(choice, quote, overrides = {}) {
  return { question_id: 'q5', choice, judgment: '合成学习材料中的有限判断', evidence: [{ source_id: 'S1', quote }], ...overrides }
}
function parse(answers, input, selectedConfig = config) {
  return parseReadingAnswers(JSON.stringify({ answers }), input, [...new Set(answers.map(item => item.question_id))], selectedConfig)
}
function promptQuestions(prompt, selectedConfig = config) {
  const { questions_heading, output_heading } = selectedConfig.protocol.templates
  const start = prompt.indexOf(`${questions_heading}:\n`) + questions_heading.length + 2
  const end = prompt.indexOf(`\n${output_heading}:\n`, start)
  assert.ok(start > questions_heading.length && end > start, 'actual prompt must contain the selected question JSON')
  return JSON.parse(prompt.slice(start, end))
}
async function graphValid(graph, input) {
  const receipt = await validateGraph({ ...graph, entity: { kind: 'paper', id: input.paper.id }, mode: 'graph', origin: 'llm' }, input.sources)
  assert.equal(receipt.ok, true, receipt.error)
}
async function editableQuestionnaire(t) {
  const directory = await mkdtemp(join(tmpdir(), 'reading-codebook-synthetic-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await cp(new URL('../prompts/reading/', import.meta.url), directory, { recursive: true })
  const originals = new Map(await Promise.all(['protocol', 'q1', 'q2', 'q3', 'q4', 'q5', 'q6'].map(async id =>
    [id, JSON.parse(await readFile(join(directory, `${id}.json`), 'utf8'))])))
  const url = pathToFileURL(`${directory}/`)
  return { url, originals, async write(id, value) { await writeFile(join(directory, `${id}.json`), JSON.stringify(value)) } }
}

test('actual grouped prompts include every selected code definition, boundary, projection and synthetic example', () => {
  assert.equal(config.version, 'reading-questions-v2')
  assert.equal(config.protocol.codebook_required, true)
  const input = pack()
  for (const ids of questionGroups(config)) {
    const prompt = makeReadingPrompt(input, ids, config), rendered = promptQuestions(prompt)
    assert.deepEqual(rendered.map(question => question.question_id), ids)
    assert.ok(prompt.includes(input.sources[0].text), 'source text is transmitted unchanged alongside the codebook')
    assert.doesNotMatch(prompt, /CATALOG ABSTRACT MUST STAY PRIVATE/)
    assert.match(prompt, /projection/)
    assert.match(prompt, /projection.*只读编译说明/)
    assert.match(prompt, /coding.*projection.*(?:不是答案字段|不得填入返回的 answers)/)
    for (const question of rendered) {
      const original = config.questions.find(item => item.id === question.question_id)
      const options = [...original.options, ...config.protocol.common_options]
      assert.deepEqual(question.options.map(option => option.choice), options.map(option => option.id))
      assert.deepEqual(question.coding_examples, original.examples)
      assert.ok(question.coding_examples.length >= 1 && question.coding_examples.length <= 3)
      for (const [index, option] of question.options.entries()) {
        const source = options[index]
        assert.deepEqual(option.coding, source.coding, `${question.question_id}/${option.choice} must receive the complete codebook`)
        for (const field of ['definition', 'include_when', 'exclude_when']) assert.ok(option.coding[field].trim())
        assert.deepEqual(Object.keys(option).sort(), ['choice', 'coding', 'meaning', 'projection'])
        if (source.neutral) assert.deepEqual(option.projection, { graph_claim: false })
        else assert.equal(option.projection.node_type, source.graph.node_type)
      }
    }
  }
  const selected = promptQuestions(makeReadingPrompt(input, ['q5'], config))
  assert.equal(selected.length, 1, 'a single question prompt cannot silently include the full six-question codebook')
  const options = selected[0].options
  for (const [choice, endpoints] of Object.entries({ method_data: methodDataMapping, ...resultMappings })) {
    assert.deepEqual(options.find(option => option.choice === choice).projection,
      { node_type: 'claim', evidence_target_type: 'claim', evidence_relation: 'reports', endpoints })
  }
  assert.deepEqual(options.find(option => option.choice === 'other').projection,
    { node_type: 'claim', evidence_target_type: 'claim', evidence_relation: 'reports' })
})

test('readonly projections describe observation reporting and preserve evidence direction and gap attribution', () => {
  const rendered = promptQuestions(makeReadingPrompt(pack(), ['q2', 'q4', 'q6'], config))
  const projection = (id, choice) => rendered.find(question => question.question_id === id).options.find(option => option.choice === choice).projection
  assert.deepEqual(projection('q2', 'reported_result'), { node_type: 'observation', evidence_target_type: 'claim', evidence_relation: 'reports' })
  for (const relation of ['supports', 'qualifies', 'contradicts']) {
    assert.deepEqual(projection('q4', relation), { node_type: 'claim', evidence_target_type: 'claim', evidence_relation: relation })
  }
  assert.deepEqual(projection('q6', 'stated_gap'), { node_type: 'gap', evidence_target_type: 'gap', evidence_relation: 'identifies', source_status: 'author-stated' })
  assert.deepEqual(projection('q6', 'inferred_gap'), { node_type: 'gap', evidence_target_type: 'gap', evidence_relation: 'reports', source_status: 'inferred' })
  assert.deepEqual(projection('q6', 'research_question'), { node_type: 'question', source_status: 'author-stated' })
  const input = pack(), quote = input.sources[0].text
  for (const extra of [{ coding: {} }, { projection: {} }, { node_type: 'observation' }, { relation: 'produced_by' }]) {
    const result = parse([answer('method_result', quote, extra)], input)
    assert.equal(result.answers[0].valid, false)
    assert.ok(result.answers[0].errors.some(error => error.code === 'UNEXPECTED_ANSWER_FIELDS'))
  }
})

test('q5 result endpoint contracts project to four legal Python graph relations in object-to-subject direction', async () => {
  const examples = [
    ['method_result', 'Retrieval practice improved recall.', 'Retrieval practice', 'improved recall'],
    ['data_result', 'StudySet showed improved recall.', 'StudySet', 'improved recall'],
    ['metric_result', 'Recall accuracy measured a ten-point gain.', 'Recall accuracy', 'a ten-point gain'],
    ['task_result', 'The recall task achieved a ten-point gain.', 'recall task', 'a ten-point gain'],
  ]
  for (const [choice, quote, subject, object] of examples) {
    const input = pack(quote), result = parse([answer(choice, quote, { subject, object })], input)
    assert.deepEqual(result.errors, [], `${choice}: exact evidence and explicit endpoints should pass mechanical validation`)
    const graph = compileReadingGraph(result, input, config), mapping = resultMappings[choice]
    assert.deepEqual(config.questions.find(question => question.id === 'q5').options.find(option => option.id === choice).graph.endpoints, mapping)
    assert.equal(graph.edges.length, 1)
    const edge = graph.edges[0]
    const from = graph.nodes.find(node => `${node.type}:${node.id}` === edge.subject)
    const to = graph.nodes.find(node => `${node.type}:${node.id}` === edge.object)
    assert.equal(from.type, 'observation')
    assert.equal(from.label, object)
    assert.equal(to.type, mapping.subject_type)
    assert.equal(to.label, subject)
    assert.equal(edge.relation, mapping.relation)
    assert.equal(edge.source_id, input.sources[0].id)
    await graphValid(graph, input)
    await assert.rejects(() => graphValid({ ...graph, edges: [{ ...edge, subject: edge.object, object: edge.subject }] }, input),
      undefined, `${choice}: real Python graph validation must reject reversing the result edge`)
  }
})

test('q5 method-data retains both typed entities and a limitation without inventing a typed edge', async () => {
  const quote = 'Retrieval practice used StudySet for the learning exercise.', input = pack(quote)
  const result = parse([answer('method_data', quote, { subject: 'Retrieval practice', object: 'StudySet' })], input)
  assert.deepEqual(result.errors, [])
  const graph = compileReadingGraph(result, input, config)
  assert.deepEqual(graph.edges, [])
  assert.ok(graph.nodes.some(node => node.type === 'method' && node.label === 'Retrieval practice'))
  assert.ok(graph.nodes.some(node => node.type === 'dataset' && node.label === 'StudySet'))
  assert.equal(graph.nodes.some(node => node.type === 'observation'), false)
  assert.deepEqual(graph.compilation.limitations.map(item => item.code), ['NO_SAFE_TYPED_RELATION'])
  await graphValid(graph, input)
})

test('codebook edits change the immutable hash and make prior answer projections ineligible', async t => {
  const fixture = await editableQuestionnaire(t), value = structuredClone(fixture.originals.get('q5'))
  const baseline = loadQuestionnaire(fixture.url)
  value.options.find(option => option.id === 'method_result').coding.exclude_when += ' 合成边界修订：设计目标须单独记录。'
  await fixture.write('q5', value)
  const edited = loadQuestionnaire(fixture.url)
  assert.equal(edited.version, baseline.version)
  assert.notEqual(edited.hash, baseline.hash)
  assert.ok(Object.isFrozen(edited.questions[4].options[1].coding))
  const quote = 'Retrieval practice improved recall.', input = pack(quote)
  const parsed = parse([answer('method_result', quote, { subject: 'Retrieval practice', object: 'improved recall' })], input, baseline)
  const graph = compileReadingGraph(parsed, input, edited)
  assert.deepEqual(graph.nodes, [])
  assert.equal(graph.compilation.excluded_answers[0].reason, 'invalid-or-different-questionnaire')
})

test('loading refuses incomplete codebooks, unsupported endpoints, changed direction and invalid synthetic examples', async t => {
  const fixture = await editableQuestionnaire(t)
  const cases = [
    ['missing option codebook', 'q1', value => { delete value.options[0].coding }],
    ['missing common codebook', 'protocol', value => { delete value.common_options[0].coding }],
    ['empty inclusion boundary', 'q1', value => { value.options[0].coding.include_when = '' }],
    ['nontext exclusion boundary', 'q1', value => { value.options[0].coding.exclude_when = [] }],
    ['unsupported codebook field', 'q1', value => { value.options[0].coding.confidence = 'certain' }],
    ['unsupported graph node', 'q1', value => { value.options[0].graph.node_type = 'invented_node' }],
    ['missing q5 endpoint contract', 'q5', value => { delete value.options.find(option => option.id === 'method_result').graph.endpoints }],
    ['reversed q5 direction', 'q5', value => { value.options.find(option => option.id === 'method_result').graph.endpoints.direction = 'subject-to-object' }],
    ['unsupported q5 endpoint node', 'q5', value => { value.options.find(option => option.id === 'method_result').graph.endpoints.subject_type = 'invented_node' }],
    ['legal tuple assigned to wrong code', 'q5', value => { value.options.find(option => option.id === 'method_result').graph.endpoints = { ...resultMappings.data_result } }],
    ['missing examples', 'q1', value => { delete value.examples }],
    ['empty examples', 'q1', value => { value.examples = [] }],
    ['too many examples', 'q1', value => { value.examples = Array(4).fill(value.examples[0]) }],
    ['unknown example choice', 'q1', value => { value.examples[0].choice = 'invented_choice' }],
    ['missing example reason', 'q1', value => { delete value.examples[0].reason }],
    ['unknown example field', 'q1', value => { value.examples[0].evidence = [] }],
    ['q5 one-sided example endpoints', 'q5', value => { value.examples[0].subject = 'not in source'; delete value.examples[0].object }],
    ['q5 invented example endpoint', 'q5', value => { value.examples[0].subject = 'invented method'; value.examples[0].object = value.examples[0].source_text }],
    ['non-q5 example endpoints', 'q1', value => { value.examples[0].subject = 'practice'; value.examples[0].object = 'recall' }],
  ]
  for (const [label, id, mutate] of cases) {
    const value = structuredClone(fixture.originals.get(id))
    mutate(value)
    await fixture.write(id, value)
    assert.throws(() => loadQuestionnaire(fixture.url), error => error.code === 'READING_PROTOCOL_INVALID', label)
    await fixture.write(id, fixture.originals.get(id))
  }
  assert.equal(loadQuestionnaire(fixture.url).hash, config.hash, 'all failures leave the original human-maintained configuration recoverable')
})

test('q5 design-purpose statements correctly coded as other create no observation or produced_by edge', async () => {
  const quote = 'Retrieval practice was designed to strengthen recall.', input = pack(quote)
  const result = parse([answer('other', quote, { judgment: '句子表达练习的设计目的，尚未报告实测结果。', subject: 'Retrieval practice', object: 'strengthen recall' })], input)
  assert.deepEqual(result.errors, [])
  assert.equal(result.answers[0].status, 'needs-review')
  const graph = compileReadingGraph(result, input, config)
  assert.ok(graph.nodes.some(node => node.type === 'claim'))
  assert.equal(graph.nodes.some(node => node.type === 'observation'), false)
  assert.equal(graph.edges.some(edge => edge.relation === 'produced_by'), false)
  assert.deepEqual(graph.edges, [])
  await graphValid(graph, input)
})

test('exact evidence with a semantically wrong method-result code stays mechanically valid and explicitly needs review', async () => {
  const quote = 'Retrieval practice was designed to strengthen recall.', input = pack(quote)
  const result = parse([answer('method_result', quote, { judgment: '练习已产生记忆提升。', subject: 'Retrieval practice', object: 'strengthen recall' })], input)
  assert.deepEqual(result.errors, [], 'literal quotation validation does not implement semantic adjudication')
  assert.equal(result.answers[0].valid, true)
  assert.equal(result.answers[0].evidence[0].match, 'exact')
  assert.equal(result.answers[0].status, 'needs-review')
  const graph = compileReadingGraph(result, input, config)
  assert.equal(graph.edges[0].relation, 'produced_by', 'the compiler follows a mechanically valid chosen code; it cannot establish that the statement reports a result')
  assert.match(graph.assertions[0].surface, /待审阅.*引文存在不等于判断已成立/)
  await graphValid(graph, input)
})

test('legacy v1 questionnaires without coding, examples or endpoints remain loadable and compile the original q5 mappings', async t => {
  const fixture = await editableQuestionnaire(t)
  for (const [id, original] of fixture.originals) {
    const value = structuredClone(original)
    if (id === 'protocol') {
      value.version = 'reading-questions-v1'
      delete value.codebook_required
      for (const option of value.common_options) delete option.coding
    } else {
      delete value.examples
      for (const option of value.options) { delete option.coding; delete option.graph.endpoints }
    }
    await fixture.write(id, value)
  }
  const legacy = loadQuestionnaire(fixture.url)
  assert.equal(legacy.version, 'reading-questions-v1')
  assert.equal(legacy.questions[4].options[1].coding, undefined)
  assert.equal(legacy.questions[4].options[1].graph.endpoints, undefined)
  const quote = 'Retrieval practice improved recall on StudySet; Recall accuracy measured the gain for the recall task.', input = pack(quote)
  const choices = [
    ['method_result', 'Retrieval practice', 'improved recall'], ['data_result', 'StudySet', 'improved recall'],
    ['metric_result', 'Recall accuracy', 'the gain'], ['task_result', 'recall task', 'the gain'],
    ['method_data', 'Retrieval practice', 'StudySet'],
  ]
  const result = parse(choices.map(([choice, subject, object]) => answer(choice, quote, { subject, object })), input, legacy)
  assert.deepEqual(result.errors, [])
  const graph = compileReadingGraph(result, input, legacy)
  assert.deepEqual(graph.edges.map(edge => edge.relation), Object.values(resultMappings).map(mapping => mapping.relation))
  assert.ok(graph.edges.every(edge => edge.subject.startsWith('observation:')))
  assert.deepEqual(graph.compilation.limitations.map(item => item.code), ['NO_SAFE_TYPED_RELATION'])
  await graphValid(graph, input)
  const rendered = promptQuestions(makeReadingPrompt(input, ['q5'], legacy), legacy)[0]
  assert.equal(rendered.coding_examples, undefined)
  assert.ok(rendered.options.every(option => option.coding === undefined))
  for (const [choice, endpoints] of Object.entries(resultMappings)) assert.deepEqual(rendered.options.find(option => option.choice === choice).projection.endpoints, endpoints)
})

test('codebook guidance never weakens Markdown marker or source alias quotation validation', () => {
  const quote = '**Retrieval practice** was designed to strengthen recall.', input = pack(quote)
  input.sources.push({ id: 'ks-codebook-other-page', kind: 'source-note', entity: { kind: 'paper', id: input.paper.id }, text: 'StudySet is a synthetic learning dataset.', locator: { page: 3 } })
  input.source_ids = input.sources.map(source => source.id)
  const good = parse([answer('other', quote, { judgment: '设计目的' })], input)
  assert.deepEqual(good.errors, [])
  assert.equal(good.answers[0].evidence[0].raw_pdf_verbatim, false)
  for (const [source_id, submitted, code] of [
    ['S1', 'Retrieval practice was designed to strengthen recall.', 'QUOTE_NOT_LOCATED'],
    ['S2', quote, 'QUOTE_NOT_LOCATED'],
    ['s1', quote, 'INVALID_SOURCE'],
    ['S3', quote, 'INVALID_SOURCE'],
  ]) {
    const result = parse([answer('other', submitted, { judgment: '设计目的', evidence: [{ source_id, quote: submitted }] })], input)
    assert.equal(result.answers[0].valid, false, `${source_id}: ${submitted}`)
    assert.ok(result.answers[0].errors.some(error => error.code === code))
    assert.deepEqual(compileReadingGraph(result, input, config).nodes, [])
  }
})
