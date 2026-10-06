import test from 'node:test'
import assert from 'node:assert/strict'
import { packNoteMaterial } from '../src/harness/note-material.mjs'

function excerptSource(id, text, page = 1) {
  return { id, entity: { kind: 'paper', id: 'paper-x' }, text, content_hash: `hash-${id}`, locator: { page }, pdf_snapshot: { kind: 'selected-pdf-page' } }
}

function excerptWriter(sources) {
  const saved = new Map()
  return { saved, putExcerpt: async request => {
    const parent = sources.get(request.parent_source_id), points = [...parent.text]
    const utf16Start = parent.text.indexOf(request.text)
    const start = [...parent.text.slice(0, utf16Start)].length
    assert.ok(utf16Start >= 0)
    const id = `excerpt-${saved.size}`
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
