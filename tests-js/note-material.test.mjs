import test from 'node:test'
import assert from 'node:assert/strict'
import { packNoteMaterial } from '../src/harness/note-material.mjs'
import { loadQuestionnaire, questionGroups, parseReadingAnswers, compileReadingGraph } from '../src/reading-questions.mjs'

function excerptSource(id, text, page = 1) {
  return { id, entity: { kind: 'paper', id: 'paper-x' }, text, content_hash: `hash-${id}`, locator: { page }, pdf_snapshot: { kind: 'selected-pdf-page' } }
}

function excerptWriter(sources, { longIds = false } = {}) {
  const saved = new Map()
  return { saved, putExcerpt: async request => {
    const parent = sources.get(request.parent_source_id), points = [...parent.text]
    const utf16Start = parent.text.indexOf(request.text)
    const start = [...parent.text.slice(0, utf16Start)].length
    assert.ok(utf16Start >= 0)
    const id = longIds ? `ks-${String(saved.size).padStart(32, '0')}` : `excerpt-${saved.size}`
    const row = { id, entity: request.entity, text: request.text, pdf_snapshot: {
      kind: 'selected-source-excerpt', parent_source_id: parent.id, parent_content_hash: parent.content_hash,
      parent_character_start: start, parent_character_end: start + [...request.text].length, full_document: false, excerpt_only: true,
    } }
    saved.set(id, row); return row
  } }
}

test('12 compact cards preserve a bound citation from early and late batches under the 24 KB budget', async () => {
  const sources = new Map(), batches = []
  for (let i = 0; i < 12; i++) {
    const id = `source-${i}`, quote = `证据段 ${i} ${'测'.repeat(320)}`
    sources.set(id, excerptSource(id, `前文。${quote}。后文。`, i + 1))
    batches.push({ index: i, pages: [i + 1], source_ids: [id], answers: [{ id: `answer-${i}`, question_id: 'q1', valid: true, choice: 'other', judgment: '长判断'.repeat(90), evidence: [{ source_id: id, quote }] }],
      question_results: [{ question_ids: ['q1'], status: 'complete' }], draft: { body: '', nodes: [], edges: [], assertions: [] } })
  }
  const { putExcerpt, saved } = excerptWriter(sources)
  const result = await packNoteMaterial({ batches, paperId: 'paper-x', getSource: async id => sources.get(id), putExcerpt })
  assert.equal(result.material.length, 12)
  assert.ok(result.material[0].answers[0].evidence[0].source_id)
  assert.ok(result.material.at(-1).answers[0].evidence[0].source_id)
  assert.equal(result.sourceIds.length, 12)
  assert.ok(result.coverage.material_bytes <= 24_000)
  assert.ok(result.coverage.source_characters <= 24_000)
  assert.equal(result.partial, true, 'long judgment and quote compaction is disclosed')
  assert.equal(saved.size, 12)
})

test('same quotation on distinct answers keeps both identities while sharing one excerpt source', async () => {
  const id = 'source-a', quote = 'The exact shared quotation.'
  const sources = new Map([[id, excerptSource(id, quote, 1)]]), { putExcerpt, saved } = excerptWriter(sources)
  const batch = { index: 0, pages: [1], source_ids: [id], draft: { nodes: [], edges: [], assertions: [] }, answers: [
    { id: 'a1', question_id: 'q1', valid: true, choice: 'other', judgment: 'First judgment', evidence: [{ source_id: id, quote }] },
    { id: 'a2', question_id: 'q2', valid: true, choice: 'other', judgment: 'Second judgment', evidence: [{ source_id: id, quote }] },
  ] }
  const result = await packNoteMaterial({ batches: [batch], paperId: 'paper-x', getSource: async sourceId => sources.get(sourceId), putExcerpt })
  assert.deepEqual(result.material[0].answers.map(answer => answer.id), ['a1', 'a2'])
  assert.deepEqual(result.material[0].answers.map(answer => answer.evidence[0].quote), [quote, quote])
  assert.equal(saved.size, 1)
  assert.equal(result.sourceIds.length, 1)
})

test('multiple fallback quotes from one source consume source budgets only once', async () => {
  const id = 'fallback-parent', first = 'Exact sentence one.', second = 'Exact sentence two.'
  const source = { id, entity: { kind: 'paper', id: 'paper-x' }, text: `${first} ${second}`, content_hash: 'fallback-hash', locator: { page: 1 } }
  const sources = new Map([[id, source]])
  const result = await packNoteMaterial({ batches: [{ index: 0, pages: [1], source_ids: [id], draft: {}, answers: [
    { id: 'a1', question_id: 'q1', valid: true, choice: 'other', evidence: [{ source_id: id, quote: first }] },
    { id: 'a2', question_id: 'q2', valid: true, choice: 'other', evidence: [{ source_id: id, quote: second }] },
  ] }], paperId: 'paper-x', getSource: async sourceId => sources.get(sourceId), putExcerpt: async () => { throw new Error('not used') }, sourceBudgetCharacters: [...source.text].length })
  assert.equal(result.sourceIds.length, 1)
  assert.equal(result.coverage.source_characters, [...source.text].length)
  assert.equal(result.material[0].answers.length, 2)
})

test('reusing a full-source fallback cannot erase prior source cost or admit a fourth source', async () => {
  const sources = new Map()
  const batches = []
  for (let i = 0; i < 3; i++) {
    const id = `large-${i}`, q1 = `Quote ${i}a.`, q2 = `Quote ${i}b.`
    const text = `${q1} ${q2}${'x'.repeat(8000 - q1.length - q2.length - 1)}`
    sources.set(id, { id, entity: { kind: 'paper', id: 'paper-x' }, text, content_hash: `h-${i}`, locator: { page: i + 1 } })
    batches.push({ index: i, pages: [i + 1], source_ids: [id], draft: {}, answers: [{ id: `a-${i}`, question_id: 'q1', valid: true, choice: 'other', evidence: [
      { source_id: id, quote: q1 }, { source_id: id, quote: q2 },
    ] }] })
  }
  const extraId = 'one-more-char'
  sources.set(extraId, { id: extraId, entity: { kind: 'paper', id: 'paper-x' }, text: 'z', content_hash: 'h-extra', locator: { page: 4 } })
  batches.push({ index: 3, pages: [4], source_ids: [extraId], draft: {}, answers: [{ id: 'extra', question_id: 'q1', valid: true, choice: 'other', evidence: [{ source_id: extraId, quote: 'z' }] }] })
  const result = await packNoteMaterial({ batches, paperId: 'paper-x', getSource: async id => sources.get(id), putExcerpt: async () => { throw new Error('not used') } })
  assert.equal(result.coverage.source_characters, 24_000)
  assert.equal(result.coverage.source_diagnostics.verified_parent_sources, 3, 'distinct quotations do not count the same parent twice')
  assert.equal(result.sourceIds.length, 3)
  assert.equal(result.material[0].answers[0].evidence.length, 2, 'second quote from an already bound parent survives')
  assert.equal(result.material[3].answers.length, 0, 'the extra one-character source is omitted')
  assert.ok(result.coverage.source_diagnostics.omitted_source_budget > 0)
})

test('emoji excerpt offsets are verified in Unicode code points, not UTF-16 units', async () => {
  const id = 'source-emoji', quote = '🛰️ exact quote'
  const sources = new Map([[id, excerptSource(id, `🧭 before ${quote} after`, 1)]]), { putExcerpt } = excerptWriter(sources)
  const result = await packNoteMaterial({ batches: [{ index: 0, pages: [1], source_ids: [id], answers: [{ id: 'a', question_id: 'q1', valid: true, choice: 'other', judgment: 'ok', evidence: [{ source_id: id, quote }] }], draft: { nodes: [], edges: [], assertions: [] } }],
    paperId: 'paper-x', getSource: async sourceId => sources.get(sourceId), putExcerpt })
  assert.equal(result.coverage.source_diagnostics.excerpt_sources_created, 1)
  assert.equal(result.material[0].answers[0].evidence[0].quote, quote)
})

test('quote suffix tampering and wrong page reuse are rejected', async () => {
  const id = 'source-a', prefix = 'A'.repeat(240), quote = `${prefix}fabricated tail`
  const source = excerptSource(id, prefix, 1), sources = new Map([[id, source]]), { putExcerpt } = excerptWriter(sources)
  const invalid = await packNoteMaterial({ batches: [{ index: 0, pages: [1], source_ids: [id], answers: [{ id: 'a', question_id: 'q1', valid: true, choice: 'other', evidence: [{ source_id: id, quote }] }], draft: {} }],
    paperId: 'paper-x', getSource: async sourceId => sources.get(sourceId), putExcerpt })
  assert.equal(invalid.coverage.source_diagnostics.omitted_quote_mismatch, 1)
  assert.equal(invalid.sourceIds.length, 0)

  const exact = 'Page one exact sentence.'
  sources.set(id, excerptSource(id, exact, 1))
  const crossPage = await packNoteMaterial({ batches: [
    { index: 0, pages: [1], source_ids: [id], answers: [{ id: 'a1', question_id: 'q1', valid: true, choice: 'other', evidence: [{ source_id: id, quote: exact }] }], draft: {} },
    { index: 1, pages: [2], source_ids: [id], answers: [{ id: 'a2', question_id: 'q2', valid: true, choice: 'other', evidence: [{ source_id: id, quote: exact }] }], draft: {} },
  ], paperId: 'paper-x', getSource: async sourceId => sources.get(sourceId), putExcerpt })
  assert.equal(crossPage.material[1].answers.length, 0, 'the unsupported answer is omitted instead of being presented as evidence')
  assert.equal(crossPage.partial, true)
})

test('neutral answers keep only context scope and tiny budgets fail with a typed error', async () => {
  const id = 'source-neutral', source = excerptSource(id, 'Contextual source text.', 1), sources = new Map([[id, source]]), { putExcerpt } = excerptWriter(sources)
  const result = await packNoteMaterial({ batches: [{ index: 0, pages: [1], source_ids: [id], answers: [{ id: 'n', question_id: 'q1', valid: true, choice: 'not_reported', neutral: true, judgment: 'Not reported', evidence: [] }], draft: { nodes: [], edges: [], assertions: [] } }],
    paperId: 'paper-x', getSource: async sourceId => sources.get(sourceId), putExcerpt })
  assert.equal(result.material[0].answers.length, 1)
  assert.equal(result.material[0].scope_context.scope_only, true)
  assert.equal(result.partial, false)
  await assert.rejects(packNoteMaterial({ batches: [{ index: 0, pages: [1], source_ids: [], answers: [], draft: {} }], paperId: 'paper-x', getSource: async () => null, putExcerpt, budgetBytes: 64 }), e => e.code === 'NOTE_MATERIAL_BUDGET_EXCEEDED')
})

function atomicBatches(pageCounts = Array(12).fill(1), { missingQuestion, usePdfSnapshots = false, dense = false } = {}) {
  const config = loadQuestionnaire(), sources = new Map(), batches = []
  assert.equal(config.questions.length, 13, 'exercise the production atomic questionnaire rather than a shortened fixture')
  let page = 0
  for (const [index, pageCount] of pageCounts.entries()) {
    const selected = []
    for (let i = 0; i < pageCount; i++) {
      page++
      const id = `source-${page}`, text = dense ? `阅读训练第${page}页。${'有限范围的阅读方法说明。'.repeat(80)}` : `Evidence on page ${page}.`
      const source = usePdfSnapshots ? excerptSource(id, text, page)
        : { id, entity: { kind: 'paper', id: 'paper-x' }, text, locator: { page }, content_hash: `hash-${page}` }
      sources.set(id, source); selected.push(source)
    }
    const input = { paper: { id: 'paper-x' }, sources: selected, source_ids: selected.map(source => source.id) }
    const answers = [], question_results = []
    for (const ids of questionGroups(config)) {
      if (missingQuestion?.batch === index && missingQuestion.id === ids[0]) {
        question_results.push({ question_ids: ids, status: 'partial', missing: ids, errors: [{ code: 'MODEL_REQUEST_FAILED' }] })
        continue
      }
      const response = { answers: ids.flatMap(question_id => Array.from({ length: dense ? 6 : 1 }, (_, answerIndex) => {
        const source = selected[question_id === 'q2' ? selected.length - 1 : 0]
        return { question_id, choice: dense ? 'other' : config.questions.find(question => question.id === question_id).options[0].id,
          judgment: dense ? `合成学习方法判断 ${question_id}/${answerIndex} ${'有限范围的阅读方法说明。'.repeat(100)}`
            : question_id === 'q2' ? 'UNSELECTED_CLAIM' : `Selected bounded ${question_id} judgment`,
          evidence: [{ source_id: source.id, quote: source.text }] }
      })) }
      const result = parseReadingAnswers(JSON.stringify(response), input, ids, config)
      assert.deepEqual(result.errors, [])
      answers.push(...result.answers)
      question_results.push({ question_ids: ids, status: 'complete', missing: result.missing, errors: result.errors })
    }
    const draft = compileReadingGraph(answers, input, config)
    batches.push({ index, pages: selected.map(source => source.locator.page), source_ids: input.source_ids,
      answers, question_results, draft, compilation: draft.compilation })
  }
  return { batches, sources, questionIds: config.questions.map(question => question.id) }
}

function assertExactMaterialBudget(result, budgetBytes = 24_000) {
  assert.equal(result.coverage.material_bytes, Buffer.byteLength(JSON.stringify({ batches: result.material, packing: result.coverage }), 'utf8'))
  assert.ok(result.coverage.material_bytes <= budgetBytes)
}

test('twelve batches of thirteen affirmative production questions keep every batch and a bound quote under 24 KB', async () => {
  const { batches, sources, questionIds } = atomicBatches(undefined, { usePdfSnapshots: true })
  const before = JSON.stringify(batches), { putExcerpt, saved } = excerptWriter(sources)
  const result = await packNoteMaterial({ batches, paperId: 'paper-x', getSource: async id => sources.get(id), putExcerpt })
  assertExactMaterialBudget(result)
  assert.equal(result.material.length, 12)
  assert.deepEqual(result.coverage.batch_indices, Array.from({ length: 12 }, (_, index) => index + 1))
  assert.equal(result.coverage.answers_total, 12 * 13)
  assert.equal(result.coverage.valid_answers_total, 12 * 13)
  assert.equal(result.sourceIds.length, 12)
  assert.equal(saved.size, 12)
  for (const card of result.material) {
    const refs = [...card.answers.flatMap(answer => answer.evidence), ...card.nodes.filter(node => node.source_id)]
    assert.ok(refs.length > 0, `batch ${card.batch} cannot lose its last citation`)
    for (const ref of refs) assert.ok(saved.get(ref.source_id).text.includes(ref.quote))
    assert.ok(card.source_ids.length > 0)
    assert.equal(card.question_groups.length, 0)
    assert.deepEqual(card.question_groups_summary.question_ids, questionIds)
    assert.equal(card.question_groups_summary.total, 13)
    assert.deepEqual(card.question_groups_summary.by_status, { complete: 13 })
    assert.equal(card.omissions.group_details, 13)
  }
  assert.equal(result.coverage.group_details_omitted, 156)
  assert.equal(result.partial, true)
  assert.ok(result.coverage.partial_reasons.includes('GROUP_DETAILS_COMPACTED'))
  assert.ok(result.coverage.partial_reasons.includes('MATERIAL_BUDGET_COMPACTED'))
  assert.equal(JSON.stringify(batches), before, 'packing cannot alter saved affirmative answers, question results or graph records')
})

test('final packing counters fit the same byte budget and group compaction preserves exactly which question failed', async () => {
  const { batches, sources, questionIds } = atomicBatches([8, 5], { missingQuestion: { batch: 1, id: 'q1_method' } })
  const before = JSON.stringify(batches), options = { batches, paperId: 'paper-x', getSource: async id => sources.get(id),
    putExcerpt: async () => { throw new Error('fallback sources cannot create an excerpt') }, questionCoverage: { complete: false } }
  const normal = await packNoteMaterial(options)
  assertExactMaterialBudget(normal)
  assert.equal(normal.partial, true)
  assert.equal(normal.coverage.answers_total, 25)
  assert.ok(normal.coverage.partial_reasons.includes('QUESTION_GROUP_INCOMPLETE'))
  const compact = await packNoteMaterial({ ...options, budgetBytes: 20_000 })
  assertExactMaterialBudget(compact, 20_000)
  const summary = compact.material[1].question_groups_summary
  assert.ok(summary, 'the smaller budget must also exercise the incomplete group summary')
  assert.equal(summary.total, 13)
  assert.deepEqual(summary.by_status, { complete: 12, partial: 1 })
  assert.deepEqual(summary.question_ids, questionIds)
  assert.deepEqual(summary.incomplete_question_ids, ['q1_method'])
  assert.deepEqual(summary.missing, { q1_method: 1 })
  assert.deepEqual(summary.errors, { MODEL_REQUEST_FAILED: 1 })
  for (const card of compact.material) assert.ok(card.answers.some(answer => answer.evidence.length) || card.nodes.some(node => node.source_id))
  assert.equal(JSON.stringify(batches), before)
})

test('a small thirteen-question card retains all original group detail without unnecessary group compression', async () => {
  const { batches, sources } = atomicBatches([1]), before = JSON.stringify(batches)
  const result = await packNoteMaterial({ batches, paperId: 'paper-x', getSource: async id => sources.get(id),
    putExcerpt: async () => { throw new Error('fallback sources cannot create an excerpt') } })
  assertExactMaterialBudget(result)
  assert.equal(result.material[0].answers.length, 13)
  assert.equal(result.material[0].question_groups.length, 13)
  assert.equal(result.material[0].question_groups_summary, undefined)
  assert.equal(result.material[0].omissions.group_details, 0)
  assert.equal(result.coverage.group_details_omitted, 0)
  assert.equal(result.coverage.partial_reasons.includes('GROUP_DETAILS_COMPACTED'), false)
  assert.equal(result.coverage.answer_count_details_omitted, 0)
  assert.equal(result.coverage.partial_reasons.includes('QUESTION_COUNTS_COMPACTED'), false)
  assert.equal(JSON.stringify(batches), before)
})

test('twelve dense batches with seventy-eight affirmative answers and long Chinese quotes retain citations under 24 KB', async () => {
  const { batches, sources, questionIds } = atomicBatches(undefined, { dense: true, usePdfSnapshots: true })
  const before = JSON.stringify(batches), { putExcerpt, saved } = excerptWriter(sources, { longIds: true })
  const result = await packNoteMaterial({ batches, paperId: 'paper-x', getSource: async id => sources.get(id), putExcerpt })
  assertExactMaterialBudget(result)
  assert.equal(result.material.length, 12)
  assert.equal(result.coverage.answers_total, 12 * 78)
  assert.equal(result.coverage.valid_answers_total, 12 * 78)
  assert.equal(result.sourceIds.length, 12)
  assert.equal(saved.size, 12)
  for (const card of result.material) {
    assert.deepEqual(card.question_groups_summary.question_ids, questionIds)
    assert.deepEqual(card.answer_counts, { total: 78, valid: 78, invalid: 0, neutral: 0, by_choice: { other: 78 } })
    assert.equal(card.omissions.answer_count_details, 13)
    const refs = [...card.answers.flatMap(answer => answer.evidence), ...card.nodes.filter(node => node.source_id)]
    assert.ok(refs.length > 0, `dense batch ${card.batch} retains its last bound quote`)
    for (const ref of refs) assert.ok(saved.get(ref.source_id).text.includes(ref.quote))
  }
  assert.equal(result.coverage.answer_count_details_omitted, 156)
  assert.equal(result.partial, true)
  assert.ok(result.coverage.partial_reasons.includes('QUESTION_COUNTS_COMPACTED'))
  assert.ok(result.coverage.partial_reasons.includes('MATERIAL_BUDGET_COMPACTED'))
  assert.equal(JSON.stringify(batches), before, 'all 936 affirmative saved answers remain unchanged')
})
