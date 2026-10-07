import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadQuestionnaire, questionGroups, makeReadingPrompt, parseReadingAnswers, compileReadingGraph } from '../src/reading-questions.mjs'
import { validateGraph } from '../scripts/probe-paper-analysis-decomposition.mjs'

const config = loadQuestionnaire()
const legacyIds = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6']
const originalV2Protocol = JSON.parse(await readFile(new URL('./fixtures/reading-protocol-v2.json', import.meta.url), 'utf8'))
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
  const question_id = choice === 'other' ? 'q5_method_result' : `q5_${choice}`
  return { question_id, choice, judgment: '合成学习材料中的有限判断', evidence: [{ source_id: 'S1', quote }], ...overrides }
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
  const originals = new Map(await Promise.all([...new Set(['protocol', ...legacyIds, ...config.questions.map(question => question.id)])].map(async id =>
    [id, JSON.parse(await readFile(join(directory, `${id}.json`), 'utf8'))])))
  const url = pathToFileURL(`${directory}/`)
  return { url, originals, async write(id, value) { await writeFile(join(directory, `${id}.json`), JSON.stringify(value)) } }
}

test('actual atomic prompts include every selected code definition, boundary, projection and synthetic example', () => {
  assert.equal(config.version, 'reading-questions-v4')
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
  for (const [choice, endpoints] of Object.entries({ method_data: methodDataMapping, ...resultMappings })) {
    const id = `q5_${choice}`, selected = promptQuestions(makeReadingPrompt(input, [id], config))
    assert.equal(selected.length, 1, 'a single question prompt cannot silently include another relation question')
    assert.deepEqual(selected[0].options.map(option => option.choice), [choice, 'other', 'not_reported', 'not_applicable'])
    assert.deepEqual(selected[0].options.find(option => option.choice === choice).projection,
      { node_type: 'claim', evidence_target_type: 'claim', evidence_relation: 'reports', endpoints })
    assert.deepEqual(selected[0].options.find(option => option.choice === 'other').projection,
      { node_type: 'claim', evidence_target_type: 'claim', evidence_relation: 'reports' })
  }
})

test('readonly projections describe independent result, relationship, author-gap and reader-question attribution', () => {
  const ids = ['q2_reported_result', 'q4_supports', 'q4_qualifies', 'q4_contradicts', 'q6_study_limitation', 'q6_prior_gap', 'q6_reader_check', 'q6_research_question']
  const rendered = promptQuestions(makeReadingPrompt(pack(), ids, config))
  const projection = (id, choice) => rendered.find(question => question.question_id === id).options.find(option => option.choice === choice).projection
  assert.deepEqual(projection('q2_reported_result', 'reported_result'), { node_type: 'observation', evidence_target_type: 'claim', evidence_relation: 'reports' })
  for (const relation of ['supports', 'qualifies', 'contradicts']) {
    assert.deepEqual(projection(`q4_${relation}`, relation), { node_type: 'claim', evidence_target_type: 'claim', evidence_relation: relation })
  }
  for (const choice of ['study_limitation','prior_gap']) assert.deepEqual(projection(`q6_${choice}`, choice), { node_type: 'gap', evidence_target_type: 'gap', evidence_relation: 'identifies', source_status: 'author-stated' })
  assert.deepEqual(projection('q6_reader_check', 'reader_check'), { node_type: 'question', source_status: 'inferred' })
  assert.deepEqual(projection('q6_research_question', 'research_question'), { node_type: 'question', source_status: 'author-stated' })
  const input = pack(), quote = input.sources[0].text
  for (const extra of [{ coding: {} }, { projection: {} }, { node_type: 'observation' }, { relation: 'produced_by' }]) {
    const result = parse([answer('method_result', quote, extra)], input)
    assert.equal(result.answers[0].valid, false)
    assert.ok(result.answers[0].errors.some(error => error.code === 'UNEXPECTED_ANSWER_FIELDS'))
  }
})

test('atomic result endpoint contracts project to four legal Python graph relations in object-to-subject direction', async () => {
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
    assert.deepEqual(config.questions.find(question => question.id === `q5_${choice}`).options[0].graph.endpoints, mapping)
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

test('atomic method-data retains both typed entities and a limitation without inventing a typed edge', async () => {
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
  const fixture = await editableQuestionnaire(t), value = structuredClone(fixture.originals.get('q5_method_result'))
  const baseline = loadQuestionnaire(fixture.url)
  value.options.find(option => option.id === 'method_result').coding.exclude_when += ' 合成边界修订：设计目标须单独记录。'
  await fixture.write('q5_method_result', value)
  const edited = loadQuestionnaire(fixture.url)
  assert.equal(edited.version, baseline.version)
  assert.notEqual(edited.hash, baseline.hash)
  assert.ok(Object.isFrozen(edited.questions.find(question => question.id === 'q5_method_result').options[0].coding))
  const quote = 'Retrieval practice improved recall.', input = pack(quote)
  const parsed = parse([answer('method_result', quote, { subject: 'Retrieval practice', object: 'improved recall' })], input, baseline)
  const graph = compileReadingGraph(parsed, input, edited)
  assert.deepEqual(graph.nodes, [])
  assert.equal(graph.compilation.excluded_answers[0].reason, 'invalid-or-different-questionnaire')
})

test('loading refuses incomplete codebooks, unsupported endpoints, changed direction and invalid synthetic examples', async t => {
  const fixture = await editableQuestionnaire(t)
  const cases = [
    ['missing option codebook', 'q1_method', value => { delete value.options[0].coding }],
    ['missing common codebook', 'protocol', value => { delete value.common_options[0].coding }],
    ['empty inclusion boundary', 'q1_method', value => { value.options[0].coding.include_when = '' }],
    ['nontext exclusion boundary', 'q1_method', value => { value.options[0].coding.exclude_when = [] }],
    ['unsupported codebook field', 'q1_method', value => { value.options[0].coding.confidence = 'certain' }],
    ['unsupported graph node', 'q1_method', value => { value.options[0].graph.node_type = 'invented_node' }],
    ['missing atomic endpoint contract', 'q5_method_result', value => { delete value.options[0].graph.endpoints }],
    ['reversed atomic direction', 'q5_method_result', value => { value.options[0].graph.endpoints.direction = 'subject-to-object' }],
    ['unsupported atomic endpoint node', 'q5_method_result', value => { value.options[0].graph.endpoints.subject_type = 'invented_node' }],
    ['legal tuple assigned to wrong code', 'q5_method_result', value => { value.options[0].graph.endpoints = { ...resultMappings.data_result } }],
    ['missing examples', 'q1_method', value => { delete value.examples }],
    ['empty examples', 'q1_method', value => { value.examples = [] }],
    ['too many examples', 'q1_method', value => { value.examples = Array(4).fill(value.examples[0]) }],
    ['unknown example choice', 'q1_method', value => { value.examples[0].choice = 'invented_choice' }],
    ['missing example reason', 'q1_method', value => { delete value.examples[0].reason }],
    ['unknown example field', 'q1_method', value => { value.examples[0].evidence = [] }],
    ['atomic one-sided example endpoints', 'q5_method_result', value => { value.examples[0].subject = 'not in source'; delete value.examples[0].object }],
    ['atomic invented example endpoint', 'q5_method_result', value => { value.examples[0].subject = 'invented method'; value.examples[0].object = value.examples[0].source_text }],
    ['entity question example endpoints', 'q1_method', value => { value.examples[0].subject = 'practice'; value.examples[0].object = 'recall' }],
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

test('atomic design-purpose statements correctly coded as other create no observation or produced_by edge', async () => {
  const quote = 'Retrieval practice was designed to strengthen recall.', input = pack(quote)
  const result = parse([answer('other', quote, { judgment: '句子表达练习的设计目的，尚未报告实测结果。' })], input)
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
  for (const id of ['protocol', ...legacyIds]) {
    const original = id === 'protocol' ? originalV2Protocol : fixture.originals.get(id)
    const value = structuredClone(original)
    if (id === 'protocol') {
      value.version = 'reading-questions-v1'
      delete value.question_ids
      delete value.default_mode
      value.default_groups = [['q1', 'q2'], ['q3', 'q4'], ['q5', 'q6']]
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
  assert.deepEqual(questionGroups(legacy), [['q1', 'q2'], ['q3', 'q4'], ['q5', 'q6']])
  const result = parse(choices.map(([choice, subject, object]) => answer(choice, quote, { question_id: 'q5', subject, object })), input, legacy)
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

test('each atomic relation rejects another relation code and endpoints on other or neutral answers', () => {
  const quote = pack().sources[0].text, input = pack(quote)
  const choices = ['method_data', ...Object.keys(resultMappings)]
  for (const choice of choices) {
    const id = `q5_${choice}`
    for (const otherChoice of choices.filter(candidate => candidate !== choice)) {
      const result = parse([answer(otherChoice, quote, { question_id: id })], input)
      assert.equal(result.answers[0].valid, false, `${id}/${otherChoice}`)
      assert.ok(result.answers[0].errors.some(error => error.code === 'UNKNOWN_CHOICE'))
      assert.deepEqual(compileReadingGraph(result, input, config).edges, [])
    }
    for (const alternative of ['other', 'not_reported', 'not_applicable']) {
      const result = parse([answer(alternative, quote, { question_id: id, subject: 'Retrieval practice', object: 'improved recall' })], input)
      assert.equal(result.answers[0].valid, false, `${id}/${alternative}: endpoints must belong to this question's positive relation code`)
      assert.ok(result.answers[0].errors.some(error => error.code === 'INVALID_ENDPOINTS'))
      assert.deepEqual(compileReadingGraph(result, input, config).edges, [])
    }
  }
  const entity = parse([answer('method', quote, { question_id: 'q1_method', subject: 'Retrieval practice', object: 'improved recall' })], input)
  assert.ok(entity.answers[0].errors.some(error => error.code === 'INVALID_ENDPOINTS'))
})

test('atomic relation endpoints preserve recovered source text and cannot connect disconnected quotations', async () => {
  const input = pack('Prefix. Retrieval practice\n   improved recall. End.'), before = input.sources[0].text
  const result = parse([answer('method_result', 'Retrieval practice improved recall.', { subject: 'Retrieval practice', object: 'improved recall' })], input)
  assert.deepEqual(result.errors, [])
  const record = result.answers[0], ref = record.evidence[0]
  assert.equal(ref.match, 'unique-whitespace')
  assert.equal(ref.quote, 'Retrieval practice\n   improved recall.')
  assert.equal(input.sources[0].text.slice(ref.start_utf16, ref.end_utf16), ref.quote)
  assert.equal(record.relation_evidence_index, 0)
  assert.equal(input.sources[0].text, before)
  const graph = compileReadingGraph(result, input, config)
  assert.equal(graph.edges[0].relation, 'produced_by')
  assert.equal(graph.edges[0].source_id, input.sources[0].id)
  await graphValid(graph, input)
  const disconnected = pack('Retrieval practice was discussed. Another exercise improved recall.')
  const invalid = parse([answer('method_result', '', { subject: 'Retrieval practice', object: 'improved recall', evidence: [
    { source_id: 'S1', quote: 'Retrieval practice was discussed.' },
    { source_id: 'S1', quote: 'Another exercise improved recall.' },
  ] })], disconnected)
  assert.ok(invalid.answers[0].errors.some(error => error.code === 'ENDPOINT_NOT_IN_EVIDENCE'))
  assert.deepEqual(compileReadingGraph(invalid, disconnected, config).edges, [])
})

test('legacy v2 relation alternatives retain their recorded endpoint handling and original grouping', async t => {
  const fixture = await editableQuestionnaire(t), protocol = structuredClone(originalV2Protocol)
  await fixture.write('protocol', protocol)
  const legacy = loadQuestionnaire(fixture.url)
  assert.deepEqual(questionGroups(legacy), [['q1', 'q2'], ['q3', 'q4'], ['q5', 'q6']])
  const quote = 'Retrieval practice was designed to strengthen recall.', input = pack(quote)
  const result = parse([answer('other', quote, { question_id: 'q5', subject: 'Retrieval practice', object: 'strengthen recall', judgment: '句子说明设计目的，未报告结果。' })], input, legacy)
  assert.deepEqual(result.errors, [], 'old alternatives with endpoints remain readable without changing their frozen contract')
  const graph = compileReadingGraph(result, input, legacy)
  assert.deepEqual(graph.edges, [])
  assert.equal(graph.nodes.some(node => node.type === 'observation'), false)
  await graphValid(graph, input)
})
