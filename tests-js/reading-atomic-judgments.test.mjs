import test from 'node:test'
import assert from 'node:assert/strict'
import { loadQuestionnaire, makeReadingPrompt, parseReadingAnswers, compileReadingGraph } from '../src/reading-questions.mjs'
import { validateGraph } from '../scripts/probe-paper-analysis-decomposition.mjs'

const config = loadQuestionnaire()
const target = 'Source checks improve recall.'
const basis = 'Nine of twelve readers recalled the passage after a source check.'
function pack(text = `${target} ${basis}`) {
  const sources = [{ id: 'ks-atomic-judgment-learning', kind: 'source-note', entity: { kind: 'paper', id: 'synthetic-learning' }, text, locator: { page: 2 } }]
  return { paper: { id: 'synthetic-learning' }, sources, source_ids: sources.map(source => source.id), preprocessing: { representation: 'normalized-markdown', raw_verbatim: false } }
}
function answer(id = 'q4_supports', choice = 'supports', extra = {}) {
  return { question_id: id, choice, judgment: '有限的学习练习观察与此主张一致，尚不足以确证因果。', target_claim: { source_id: 'S1', quote: target }, evidence: [{ source_id: 'S1', quote: basis }], ...extra }
}
function parse(answers, input = pack()) {
  return parseReadingAnswers(JSON.stringify({ answers }), input, [...new Set(answers.map(answer => answer.question_id))], config)
}
async function graphValid(graph, input) {
  const result = await validateGraph({ ...graph, entity: { kind: 'paper', id: input.paper.id }, mode: 'graph', origin: 'llm' }, input.sources)
  assert.equal(result.ok, true, result.error)
}

test('all remaining categories have independent question codes instead of accepting another category', () => {
  const families = [
    ['q2_author_claim', 'q2_reported_result', 'q2_reader_inference'],
    ['q3_text', 'q3_figure', 'q3_table', 'q3_formula'],
    ['q4_supports', 'q4_qualifies', 'q4_contradicts'],
    ['q6_research_question', 'q6_study_limitation', 'q6_prior_gap', 'q6_reader_check'],
  ]
  for (const ids of families) for (const id of ids) {
    const question = config.questions.find(question => question.id === id)
    assert.equal(question.options.length, 1)
    for (const other of ids.filter(other => other !== id)) {
      const choice = config.questions.find(question => question.id === other).options[0].id
      const result = parse([answer(id, choice)])
      assert.ok(result.answers[0].errors.some(error => error.code === 'UNKNOWN_CHOICE'), `${id} cannot accept ${choice}`)
      assert.deepEqual(compileReadingGraph(result, pack(), config).nodes, [])
    }
  }
})

test('evidence relationships locate target and basis independently and compile the quoted target instead of the reasoning', async () => {
  const input = pack(`😀 Source checks\n  improve recall.`)
  input.sources.push({ id: 'ks-atomic-basis-page', kind: 'source-note', entity: { kind: 'paper', id: input.paper.id }, text: basis, locator: { page: 3 } })
  input.source_ids = input.sources.map(source => source.id)
  for (const relation of ['supports', 'qualifies', 'contradicts']) {
    const result = parse([answer(`q4_${relation}`, relation, { evidence: [{ source_id: 'S2', quote: basis }] })], input)
    assert.deepEqual(result.errors, [])
    const record = result.answers[0]
    assert.equal(record.target_claim_required, true)
    assert.equal(record.target_claim.source_id, input.sources[0].id)
    assert.equal(record.target_claim.page, 2)
    assert.equal(record.target_claim.match, 'unique-whitespace')
    assert.equal(input.sources[0].text.slice(record.target_claim.start_utf16, record.target_claim.end_utf16), record.target_claim.quote)
    assert.equal(record.evidence[0].page, 3)
    const graph = compileReadingGraph(result, input, config)
    const claim = graph.nodes.find(node => node.type === 'claim')
    assert.equal(claim.label, record.target_claim.quote)
    assert.notEqual(claim.label, record.judgment)
    assert.equal(claim.fields.relation_reason, record.judgment)
    assert.equal(claim.fields.target_source_id, record.target_claim.source_id)
    const edge = graph.assertions.find(assertion => assertion.relation === relation)
    assert.equal(edge.object, `claim:${claim.id}`)
    const evidence = graph.nodes.find(node => `evidence:${node.id}` === edge.subject)
    assert.equal(evidence.quote, basis)
    assert.equal(edge.source_id, input.sources[1].id)
    await graphValid(graph, input)
  }
})

test('missing, rewritten, unselected and ambiguous target claims fail without erasing another valid question', () => {
  for (const [ref, input, expected] of [
    [undefined, pack(), 'TARGET_CLAIM_REQUIRED'],
    [{ source_id: 'S1', quote: 'Source checks always improve recall.' }, pack(), 'TARGET_CLAIM_NOT_LOCATED'],
    [{ source_id: 'S9', quote: target }, pack(), 'TARGET_CLAIM_REQUIRED'],
    [{ source_id: 'S1', quote: target }, pack(`${target} ${basis} ${target}`), 'TARGET_CLAIM_NOT_LOCATED'],
    [{ source_id: 'S1', quote: target, invented: true }, pack(), 'TARGET_CLAIM_REQUIRED'],
  ]) {
    const result = parse([answer('q4_supports', 'supports', { target_claim: ref }),
      { question_id: 'q1_method', choice: 'method', evidence: [{ source_id: 'S1', quote: basis }] }], input)
    assert.ok(result.answers[0].errors.some(error => error.code === expected))
    assert.equal(result.answers[1].valid, true)
    const graph = compileReadingGraph(result, input, config)
    assert.equal(graph.nodes.some(node => node.fields.question_id === 'q4_supports'), false)
    assert.equal(graph.nodes.some(node => node.type === 'method'), true)
  }
})

test('pure target restatement is rejected while a continuous context containing additional evidence remains admissible', () => {
  for (const quote of [target, 'improve recall.']) {
    const result = parse([answer('q4_supports', 'supports', { evidence: [{ source_id: 'S1', quote }] })])
    assert.ok(result.answers[0].errors.some(error => error.code === 'TARGET_RESTATEMENT_NOT_EVIDENCE'))
  }
  const input = pack(), result = parse([answer('q4_supports', 'supports', { evidence: [{ source_id: 'S1', quote: input.sources[0].text }] })], input)
  assert.equal(result.answers[0].valid, true, 'additional material can coexist with the target in one continuous context')
  assert.equal(result.answers[0].status, 'needs-review', 'mechanical distinctness does not establish semantic support')
})

test('unresolved relationships retain the target and reasoning without creating a supports, qualifies or contradicts edge', async () => {
  const input = pack(), result = parse([answer('q4_supports', 'other', { judgment: '本段不足以判断该证据是否支持作者的具体主张。' })], input)
  assert.deepEqual(result.errors, [])
  const graph = compileReadingGraph(result, input, config)
  assert.equal(graph.nodes.find(node => node.type === 'claim').label, target)
  assert.ok(graph.assertions.every(edge => edge.relation === 'reports'))
  assert.ok(graph.compilation.limitations.some(item => item.code === 'EVIDENCE_RELATION_UNRESOLVED'))
  await graphValid(graph, input)
  const changed = structuredClone(result)
  changed.answers[0].target_claim.quote = 'A different invented target.'
  assert.deepEqual(compileReadingGraph(changed, input, config).nodes, [])
})

test('scope answers cannot carry a target or coexist with affirmative content under the new contract', () => {
  const neutral = { question_id: 'q4_supports', choice: 'not_reported', evidence: [] }
  assert.equal(parse([neutral]).answers[0].valid, true)
  const withTarget = parse([{ ...neutral, target_claim: { source_id: 'S1', quote: target } }])
  assert.ok(withTarget.answers[0].errors.some(error => error.code === 'TARGET_CLAIM_NOT_APPLICABLE'))
  for (const rows of [[neutral, answer()], [neutral, { ...neutral, choice: 'not_applicable' }]]) {
    const result = parse(rows)
    assert.ok(result.answers.every(row => !row.valid))
    assert.ok(result.errors.some(error => error.code === 'CONFLICTING_SCOPE_ANSWER'))
    assert.deepEqual(compileReadingGraph(result, pack(), config).nodes, [])
  }
})

test('reader interpretation and check questions require one bounded judgment and preserve inferred attribution even on other', async () => {
  const input = pack()
  for (const id of ['q2_reader_inference', 'q6_reader_check']) {
    const question = config.questions.find(question => question.id === id)
    assert.equal(question.max_answers, 1)
    const prompt = makeReadingPrompt(input, [id], config)
    assert.match(prompt, /"max_answers": 1/)
    assert.match(prompt, /"source_status": "inferred"/)
    for (const choice of [question.options[0].id, 'other']) {
      const item = { question_id: id, choice, judgment: '核对来源可能与练习回忆表现相关，仍需查看可比条件。', evidence: [{ source_id: 'S1', quote: basis }] }
      const result = parse([item], input)
      assert.deepEqual(result.errors, [])
      assert.equal(result.answers[0].source_status, 'inferred')
      const graph = compileReadingGraph(result, input, config)
      const judgment = graph.nodes.find(node => node.type !== 'evidence')
      assert.equal(judgment.fields.source_status, 'inferred')
      if (id === 'q6_reader_check' && choice === 'reader_check') {
        assert.equal(judgment.type, 'question')
        assert.equal(judgment.source_status, 'inferred')
      }
      assert.equal(graph.nodes.some(node => node.type === 'gap'), false)
      await graphValid(graph, input)
      const empty = parse([{ ...item, judgment: '' }], input)
      assert.ok(empty.answers[0].errors.some(error => error.code === 'JUDGMENT_REQUIRED'))
      const extra = parse([item, { ...item, judgment: '另一个待核对问题。' }], input)
      assert.equal(extra.answers[0].valid, true)
      assert.ok(extra.answers[1].errors.some(error => error.code === 'QUESTION_ANSWER_LIMIT'))
      assert.equal(compileReadingGraph(extra, input, config).compilation.included_answer_ids.length, 1)
    }
  }
})

test('all current synthetic coding examples parse and compile through the real Python graph contract', async () => {
  let checked = 0
  for (const question of config.questions) for (const example of question.examples) {
    const input = pack(example.source_text)
    const row = { question_id: question.id, choice: example.choice, judgment: example.judgment,
      evidence: ['not_reported', 'not_applicable'].includes(example.choice) ? [] : [{ source_id: 'S1', quote: example.evidence_quote ?? example.source_text }],
      ...(example.subject ? { subject: example.subject, object: example.object } : {}),
      ...(example.target_claim ? { target_claim: { source_id: 'S1', quote: example.target_claim.quote } } : {}) }
    const result = parse([row], input)
    assert.deepEqual(result.errors, [], `${question.id}/${example.choice}`)
    const graph = compileReadingGraph(result, input, config)
    if (!result.answers[0].neutral) await graphValid(graph, input)
    else assert.equal(graph.nodes.length, 0)
    checked++
  }
  assert.equal(checked, 69)
})
