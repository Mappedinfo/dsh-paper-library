import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadQuestionnaire, questionGroups, makeReadingPrompt, parseReadingAnswers, compileReadingGraph, summarizeOptionCandidates } from '../src/reading-questions.mjs'
import { validateGraph } from '../scripts/probe-paper-analysis-decomposition.mjs'

const atomicConfig = loadQuestionnaire()
const legacyIds = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6']
const atomicIds = ['q1_method', 'q1_dataset', 'q1_metric', 'q1_task', 'q2', 'q3', 'q4',
  'q5_method_data', 'q5_method_result', 'q5_data_result', 'q5_metric_result', 'q5_task_result', 'q6']
function legacyProtocol(protocol) {
  const legacy = structuredClone(protocol)
  legacy.version = 'reading-questions-v2'
  delete legacy.question_ids
  delete legacy.default_mode
  legacy.default_groups = [['q1', 'q2'], ['q3', 'q4'], ['q5', 'q6']]
  return legacy
}
const legacyDirectory = await mkdtemp(join(tmpdir(), 'reading-legacy-v2-synthetic-'))
await cp(new URL('../prompts/reading/', import.meta.url), legacyDirectory, { recursive: true })
await writeFile(join(legacyDirectory, 'protocol.json'), JSON.stringify(legacyProtocol(atomicConfig.protocol)))
const legacyUrl = pathToFileURL(`${legacyDirectory}/`)
const config = loadQuestionnaire(legacyUrl)
after(() => rm(legacyDirectory, { recursive: true, force: true }))
function pack(text = 'Retrieval practice used StudySet and improved recall. The study reports a limited sample.') {
  const sources = [{ id: 'ks-synthetic-a', entity: { kind: 'paper', id: 'synthetic-paper' }, text, locator: { page: 3 }, kind: 'source-note' }]
  return { paper: { id: 'synthetic-paper', title: 'Synthetic learning exercise', abstract: 'PRIVATE ABSTRACT MUST NOT BE SERIALIZED', private_field: 'PRIVATE CUSTOM FIELD' },
    sources, source_ids: sources.map(source => source.id), preprocessing: { representation: 'normalized-markdown', raw_verbatim: false }, coverage: { read_pages: [3], full_document: false } }
}
function answer(question_id = 'q1', choice = 'method', overrides = {}) {
  return { question_id, choice, judgment: '检索练习', evidence: [{ source_id: 'S1', quote: 'Retrieval practice used StudySet and improved recall.' }], ...overrides }
}
function parse(answers, input = pack(), ids = [...new Set(answers.map(item => item.question_id))], selectedConfig = config) {
  return parseReadingAnswers(JSON.stringify({ answers }), input, ids, selectedConfig)
}
async function assertGraphValid(graph, input) {
  const result = await validateGraph({ ...graph, entity: { kind: 'paper', id: input.paper.id }, mode: 'graph', origin: 'llm' }, input.sources)
  assert.equal(result.ok, true, result.error)
}

test('legacy v2 question files retain immutable hashes and their original grouped and separate scopes', () => {
  assert.deepEqual(config.questions.map(question => question.id), legacyIds)
  assert.equal(config.hash, loadQuestionnaire(legacyUrl).hash)
  assert.ok(Object.isFrozen(config.questions[0].options[0]))
  assert.throws(() => { config.questions[0].question = 'changed' }, TypeError)
  assert.deepEqual(questionGroups(config), [['q1', 'q2'], ['q3', 'q4'], ['q5', 'q6']])
  assert.deepEqual(questionGroups(config, { question_ids: ['q6', 'q2'], question_mode: 'separate' }), [['q6'], ['q2']])
  assert.deepEqual(questionGroups(config, { question_ids: ['q6', 'q2'] }), [['q2'], ['q6']])
  for (const options of [{ question_ids: [] }, { question_ids: ['q1', 'q1'] }, { question_ids: ['q7'] }, { question_mode: 'whole' }]) assert.throws(() => questionGroups(config, options), /question_/)
})

test('editing questions changes the content hash and invalid unsafe schema edits are refused', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reading-questions-synthetic-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await cp(new URL('../prompts/reading/', import.meta.url), root, { recursive: true })
  await writeFile(join(root, 'protocol.json'), JSON.stringify(legacyProtocol(atomicConfig.protocol)))
  const file = join(root, 'q1.json'), value = JSON.parse(await readFile(file, 'utf8'))
  value.question += ' 保留应用范围。'
  await writeFile(file, JSON.stringify(value))
  const edited = loadQuestionnaire(pathToFileURL(`${root}/`))
  assert.notEqual(edited.hash, config.hash)
  assert.equal(edited.version, config.version, 'even accidental unchanged human version cannot hide a content edit')
  value.options[0].neutral = true
  await writeFile(file, JSON.stringify(value))
  assert.throws(() => loadQuestionnaire(pathToFileURL(`${root}/`)), /免除证据/)
})

test('prompt exposes page aliases with untouched text, requested questions and no catalog metadata', () => {
  const input = pack('Plain first sentence.\n\nSecond sentence with **Markdown**.'), prompt = makeReadingPrompt(input, ['q6'], config)
  assert.ok(prompt.includes(input.sources[0].text))
  assert.match(prompt, /来源 S1 \| page=3/)
  assert.match(prompt, /"question_id": ?"q6"/)
  assert.doesNotMatch(prompt, /"question_id": ?"q1"/)
  assert.doesNotMatch(prompt, /PRIVATE ABSTRACT|PRIVATE CUSTOM FIELD|"nodes"\s*:/)
  assert.doesNotMatch(prompt, /L1|line_number|sentence_id|\{\{max_answers\}\}/)
  assert.match(prompt, /不提取原始 Abstract/)
  assert.match(prompt, /不可信/)
})

test('exact and unique whitespace citations restore source text and UTF-16 offsets without changing source', () => {
  const input = pack('😀 Prefix. Retrieval practice\n   improves recall. End.')
  const result = parse([answer('q1', 'method', { evidence: [{ source_id: 'S1', quote: 'Retrieval practice improves recall.' }] })], input)
  assert.equal(result.errors.length, 0)
  const ref = result.answers[0].evidence[0]
  assert.equal(ref.match, 'unique-whitespace')
  assert.equal(ref.source_id, input.sources[0].id)
  assert.equal(ref.start_utf16, input.sources[0].text.indexOf('Retrieval'))
  assert.equal(input.sources[0].text.slice(ref.start_utf16, ref.end_utf16), ref.quote)
  assert.equal(ref.quote, 'Retrieval practice\n   improves recall.')
  assert.equal(ref.submitted_quote, 'Retrieval practice improves recall.')
  assert.equal(ref.raw_pdf_verbatim, false)
  const exact = parse([answer('q1', 'method', { evidence: [{ source_id: input.sources[0].id, quote: '😀 Prefix.' }] })], input)
  assert.equal(exact.answers[0].evidence[0].end_utf16, '😀 Prefix.'.length)
  assert.equal(exact.answers[0].evidence[0].match, 'exact')
})

test('invented sources, altered characters, ambiguous quotes and invalid rows cannot erase a valid answer', () => {
  const input = pack('The ﬁnding is bounded. Repeat. Repeat. Word-\nwrap remains.')
  const cases = [
    { source_id: 'ks-outside', quote: 'The ﬁnding is bounded.' },
    { source_id: 'S1', quote: 'The finding is bounded.' },
    { source_id: 'S1', quote: 'Repeat.' },
    { source_id: 'S1', quote: 'Wordwrap remains.' },
    { source_id: 'S1', quote: 'The ﬁnding is bounded!' },
  ]
  const result = parse([answer('q2', 'author_claim', { evidence: [{ source_id: 'S1', quote: 'The ﬁnding is bounded.' }] }),
    ...cases.map((ref, index) => answer('q2', 'author_claim', { judgment: `坏答案 ${index}`, evidence: [ref] }))], input)
  assert.equal(result.answers.filter(item => item.valid).length, 1)
  assert.equal(result.answers.length, 6)
  assert.equal(result.errors.length, 5)
  assert.equal(compileReadingGraph(result, input, config).compilation.included_answer_ids.length, 1)
})

test('missing questions and neutral scope answers remain explicit without negative graph claims', () => {
  const input = pack(), result = parse([answer('q6', 'not_reported', { judgment: '本批未见', evidence: [] })], input, ['q5', 'q6'])
  assert.equal(result.answers[0].valid, true)
  assert.equal(result.answers[0].scope.full_document, false)
  assert.deepEqual(result.missing, ['q5'])
  assert.equal(result.errors[0].code, 'MISSING_QUESTION')
  const graph = compileReadingGraph(result, input, config)
  assert.deepEqual(graph.nodes, [])
  assert.equal(graph.compilation.excluded_answers[0].reason, 'neutral-scope-record-no-graph-claim')
  const missing = parse([answer('q1', 'other', { judgment: '', evidence: [] })], input)
  assert.equal(missing.answers[0].valid, false)
  assert.ok(missing.answers[0].errors.some(error => error.code === 'JUDGMENT_REQUIRED'))
})

test('malformed JSON, unknown questions and forbidden model-authored graph fields are retained as diagnostics', () => {
  const input = pack()
  for (const raw of ['{"answers":[', '[]', '{}']) {
    const result = parseReadingAnswers(raw, input, ['q1'], config)
    assert.equal(result.raw, raw)
    assert.equal(result.errors[0].code, 'INVALID_RESPONSE')
    assert.deepEqual(result.missing, ['q1'])
  }
  const result = parse([answer('q1', 'method', { nodes: [] }), answer('q2', 'author_claim')], input, ['q1'])
  assert.ok(result.answers.every(item => !item.valid))
  assert.equal(result.answers[0].errors[0].code, 'UNEXPECTED_ANSWER_FIELDS')
  assert.equal(result.answers[1].errors[0].code, 'UNKNOWN_QUESTION')
})

test('deterministic graph compiler creates supported typed concepts, observations, source nodes and explicit gap status', async () => {
  const input = pack(), records = []
  for (const [id, choice] of [['q1', 'method'], ['q1', 'dataset'], ['q1', 'metric'], ['q1', 'task'], ['q2', 'reported_result'], ['q3', 'figure'], ['q3', 'formula'], ['q6', 'stated_gap'], ['q6', 'inferred_gap'], ['q6', 'research_question']]) {
    const result = parse([answer(id, choice, { judgment: `${id} ${choice}` })], input)
    assert.equal(result.errors.length, 0)
    records.push(...result.answers)
  }
  const graph = compileReadingGraph(records, input, config)
  assert.deepEqual(graph, compileReadingGraph(records, input, config))
  assert.ok(['method', 'dataset', 'metric', 'task', 'observation', 'figure', 'formula', 'gap', 'question'].every(type => graph.nodes.some(node => node.type === type)))
  assert.equal(graph.nodes.find(node => node.type === 'gap' && node.fields.choice === 'stated_gap').source_status, 'author-stated')
  assert.equal(graph.nodes.find(node => node.type === 'gap' && node.fields.choice === 'inferred_gap').source_status, 'inferred')
  await assertGraphValid(graph, input)
})

test('qualifying and contradicting evidence preserve direction instead of becoming supports assertions', async () => {
  const input = pack(), result = parse(['supports', 'qualifies', 'contradicts'].map(choice => answer('q4', choice, { judgment: '练习结果可推广到其他人群。' })), input)
  const graph = compileReadingGraph(result, input, config)
  assert.deepEqual(graph.assertions.map(item => item.relation), ['supports', 'qualifies', 'contradicts'])
  assert.ok(graph.nodes.filter(node => node.type === 'claim').every(node => node.label === '练习结果可推广到其他人群。'))
  await assertGraphValid(graph, input)
  assert.equal(parse([answer('q4', 'qualifies', { judgment: '' })], input).answers[0].valid, false)
})

test('q5 can produce legal typed relations from evidence-contained endpoints; missing schema links stay explicit', async () => {
  const input = pack(), result = parse([
    answer('q5', 'method_result', { subject: 'Retrieval practice', object: 'improved recall' }),
    answer('q5', 'method_data', { subject: 'Retrieval practice', object: 'StudySet' }),
    answer('q5', 'metric_result', { judgment: '未提供两端，仅保存关系判断' }),
  ], input)
  assert.equal(result.errors.length, 0)
  const graph = compileReadingGraph(result, input, config)
  assert.equal(graph.edges.length, 1)
  assert.equal(graph.edges[0].relation, 'produced_by')
  assert.ok(graph.edges[0].subject.startsWith('observation:'))
  assert.ok(graph.edges[0].object.startsWith('method:'))
  assert.deepEqual(graph.compilation.limitations.map(item => item.code), ['NO_SAFE_TYPED_RELATION', 'RELATION_ENDPOINTS_NOT_PROVIDED'])
  await assertGraphValid(graph, input)
  const invalid = parse([answer('q5', 'method_result', { subject: 'Invented method', object: 'improved recall' })], input)
  assert.equal(invalid.answers[0].valid, false)
  assert.ok(invalid.answers[0].errors.some(error => error.code === 'ENDPOINT_NOT_IN_EVIDENCE'))
})

test('q5 does not join two endpoints taken from disconnected citations', () => {
  const input = pack('Method Alpha was discussed. A separate study improved recall.')
  const result = parse([answer('q5', 'method_result', { subject: 'Method Alpha', object: 'improved recall',
    evidence: [{ source_id: 'S1', quote: 'Method Alpha was discussed.' }, { source_id: 'S1', quote: 'A separate study improved recall.' }] })], input)
  assert.equal(result.answers[0].valid, false)
})

test('graph caps omit entire answers with explicit diagnostics and never delete full reading records', async () => {
  const input = pack(), records = Array.from({ length: 32 }, (_, index) => parse([answer('q1', 'method', { judgment: `独立方法记录 ${index}` })], input).answers[0])
  const graph = compileReadingGraph(records, input, config)
  assert.equal(graph.compilation.truncated, true)
  assert.ok(graph.nodes.length <= 80)
  assert.equal(graph.compilation.included_answer_ids.length + graph.compilation.excluded_answers.length, records.length)
  assert.ok(graph.compilation.excluded_answers.every(item => item.reason === 'graph-budget-whole-answer-omitted'))
  assert.equal(records.length, 32)
  await assertGraphValid(graph, input)
})

test('other choices form bounded human-review candidates without mutating active options or double-counting replay', () => {
  const input = pack(), record = parse([answer('q1', 'other', { judgment: '  教学角色\n分工  ' })], input).answers[0]
  const secondPack = pack('Other page: Retrieval practice used StudySet and improved recall.')
  secondPack.sources[0].id = 'ks-synthetic-b'; secondPack.source_ids = ['ks-synthetic-b']
  const second = parse([answer('q1', 'other', { judgment: '教学角色 分工' })], secondPack).answers[0]
  const candidates = summarizeOptionCandidates([record, record, second], config)
  assert.equal(candidates.candidates.length, 1)
  assert.equal(candidates.candidates[0].count, 2)
  assert.equal(candidates.candidates[0].origins.length, 2)
  assert.equal(candidates.active_config_changed, false)
  assert.equal(candidates.candidates[0].status, 'needs-human-review')
  assert.equal(config.hash, loadQuestionnaire(legacyUrl).hash)
})

test('source selection and evidence offsets are rechecked when graph projection is requested', () => {
  const input = pack(), result = parse([answer()], input)
  const changed = pack('Different text.')
  const graph = compileReadingGraph(result, changed, config)
  assert.equal(graph.nodes.length, 0)
  assert.equal(graph.compilation.excluded_answers[0].reason, 'evidence-no-longer-matches-selected-source')
  input.source_ids = ['different-source']
  assert.throws(() => makeReadingPrompt(input, ['q1'], config), /不一致/)
})

test('whitespace restoration does not bypass the persisted quote character budget', () => {
  const input = pack(`A${' '.repeat(2000)}B`)
  const result = parse([answer('q3', 'text', { evidence: [{ source_id: 'S1', quote: 'A B' }] })], input)
  assert.equal(result.answers[0].valid, false)
  assert.equal(result.answers[0].evidence.length, 0)
})

test('v3 schedules thirteen independent question calls and preserves selected order by default', () => {
  assert.equal(atomicConfig.version, 'reading-questions-v3')
  assert.equal(atomicConfig.protocol.default_mode, 'separate')
  assert.deepEqual(atomicConfig.questions.map(question => question.id), atomicIds)
  assert.deepEqual(questionGroups(atomicConfig), atomicIds.map(id => [id]))
  assert.equal(questionGroups(atomicConfig).length, 13)
  assert.deepEqual(questionGroups(atomicConfig, { question_ids: ['q6', 'q1_method'] }), [['q6'], ['q1_method']])
  assert.deepEqual(questionGroups(atomicConfig, { question_ids: ['q6', 'q1_method'], question_mode: 'grouped' }), [['q1_method'], ['q6']])
  const input = pack(), returned = []
  for (const ids of questionGroups(atomicConfig)) {
    const prompt = makeReadingPrompt(input, ids, atomicConfig)
    assert.equal((prompt.match(/"question_id":/g) ?? []).length, 2, 'each call contains one question and one response-format example')
    const result = parse([answer(ids[0], 'not_reported', { judgment: '本批未见', evidence: [] })], input, ids, atomicConfig)
    assert.deepEqual(result.errors, [])
    assert.deepEqual(result.missing, [])
    returned.push(...result.answers.map(item => item.question_id))
  }
  assert.deepEqual(returned, atomicIds, 'all thirteen independent responses cover the requested questionnaire once')
})

test('each atomic entity question accepts its own category and rejects the other three categories', () => {
  const input = pack()
  for (const type of ['method', 'dataset', 'metric', 'task']) {
    const id = `q1_${type}`, question = atomicConfig.questions.find(item => item.id === id)
    assert.deepEqual(question.options.map(option => option.id), [type])
    for (const choice of ['method', 'dataset', 'metric', 'task']) {
      const result = parse([answer(id, choice)], input, [id], atomicConfig)
      assert.equal(result.answers[0].valid, choice === type, `${id}/${choice}`)
      if (choice === type) {
        const graph = compileReadingGraph(result, input, atomicConfig)
        assert.ok(graph.nodes.some(node => node.type === type))
      } else {
        assert.ok(result.answers[0].errors.some(error => error.code === 'UNKNOWN_CHOICE'))
        assert.deepEqual(compileReadingGraph(result, input, atomicConfig).nodes, [])
      }
    }
    const oldQuestion = parse([answer('q1', type)], input, [id], atomicConfig)
    assert.ok(oldQuestion.answers[0].errors.some(error => error.code === 'UNKNOWN_QUESTION'))
    assert.deepEqual(oldQuestion.missing, [id], 'a legacy broad answer cannot stand in for the new atomic question')
  }
})

test('an invalid atomic category and one missing question cannot erase separately valid entity answers', () => {
  const input = pack(), ids = ['q1_method', 'q1_dataset', 'q1_metric', 'q1_task']
  const result = parse([answer('q1_method', 'method'), answer('q1_dataset', 'dataset'), answer('q1_metric', 'dataset')], input, ids, atomicConfig)
  assert.deepEqual(result.missing, ['q1_task'])
  assert.deepEqual(result.answers.filter(item => item.valid).map(item => item.question_id), ['q1_method', 'q1_dataset'])
  assert.equal(result.answers.find(item => item.question_id === 'q1_metric').valid, false)
  assert.ok(result.errors.some(error => error.code === 'MISSING_QUESTION' && error.question_id === 'q1_task'))
  const graph = compileReadingGraph(result, input, atomicConfig)
  assert.equal(graph.compilation.included_answer_ids.length, 2)
  assert.equal(graph.compilation.excluded_answers.length, 1)
  assert.ok(graph.nodes.some(node => node.type === 'method'))
  assert.ok(graph.nodes.some(node => node.type === 'dataset'))
  assert.equal(graph.nodes.some(node => node.type === 'metric' || node.type === 'task'), false)
})

test('v3 hashes active atomic assets and refuses unsafe or duplicate manifest identifiers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'reading-atomic-manifest-synthetic-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await cp(new URL('../prompts/reading/', import.meta.url), directory, { recursive: true })
  const url = pathToFileURL(`${directory}/`), baseline = loadQuestionnaire(url)
  const oldFile = join(directory, 'q1.json'), oldQuestion = JSON.parse(await readFile(oldFile, 'utf8'))
  oldQuestion.question += ' 旧快照材料修订。'
  await writeFile(oldFile, JSON.stringify(oldQuestion))
  assert.equal(loadQuestionnaire(url).hash, baseline.hash, 'inactive legacy assets do not change a new job input hash')
  const activeFile = join(directory, 'q1_method.json'), activeQuestion = JSON.parse(await readFile(activeFile, 'utf8'))
  activeQuestion.question += ' 仅核对当前方法。'
  await writeFile(activeFile, JSON.stringify(activeQuestion))
  assert.notEqual(loadQuestionnaire(url).hash, baseline.hash)
  for (const ids of [[], ['q1_method', 'q1_method'], ['../q1'], ['q1_method.json'], Array(41).fill('q1_method')]) {
    const protocol = structuredClone(atomicConfig.protocol)
    protocol.question_ids = ids
    await writeFile(join(directory, 'protocol.json'), JSON.stringify(protocol))
    assert.throws(() => loadQuestionnaire(url), error => error.code === 'READING_PROTOCOL_INVALID', JSON.stringify(ids))
  }
})
