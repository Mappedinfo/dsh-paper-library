import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeOptionCandidates, collectReadingOptionCandidates } from '../scripts/export-reading-option-candidates.mjs'

test('merge groups only by questionnaire hash, question ID, and whitespace-normalized exact text', () => {
  const merged = mergeOptionCandidates([
    { paper_id: 'p1', request_id: 'r1', batch_index: 0, summary: { questionnaire_version: 'v1', questionnaire_hash: 'a'.repeat(64), candidates: [
      { question_id: 'q1', proposed_description: '  A new   method ', count: 2, origins: [{ answer_id: 'a1', source_ids: ['s1'] }] },
      { question_id: 'q1', proposed_description: 'A new method', count: 1, origins: [] },
      { question_id: 'q1', proposed_description: 'a new method', count: 1, origins: [] },
    ] } },
    { paper_id: 'p2', request_id: 'r2', batch_index: 1, summary: { questionnaire_version: 'v2', questionnaire_hash: 'b'.repeat(64), candidates: [
      { question_id: 'q1', proposed_description: 'A new method', count: 3, origins: [{ answer_id: 'a2', source_ids: ['s2'] }] },
    ] } },
  ])
  assert.equal(merged.candidates.length, 3)
  assert.equal(merged.candidates.find(row => row.questionnaire_hash === 'a'.repeat(64) && row.proposed_description === 'A new method').count, 3)
  assert.equal(merged.candidates.find(row => row.questionnaire_hash === 'a'.repeat(64) && row.proposed_description === 'a new method').count, 1)
  assert.equal(merged.candidates.find(row => row.questionnaire_hash === 'b'.repeat(64)).count, 3)
  assert.equal(merged.versions.length, 2)
  assert.deepEqual(merged.candidates.find(row => row.questionnaire_hash === 'a'.repeat(64) && row.proposed_description === 'A new method').origins[0], {
    paper_id: 'p1', request_id: 'r1', batch_index: 0,
    answer_origins: [{ answer_id: 'a1', source_ids: ['s1'] }], origins_truncated: false,
  })
})

test('collector reads only selected saved batches and reports explicit budget truncation', async () => {
  const calls = []
  const report = await collectReadingOptionCandidates({ library: '/synthetic/library', localStateHome: '/synthetic/state', requests: [
    { id: 'paper-a', request_id: 'run-a' }, { id: 'paper-b', request_id: 'run-b' },
  ], maxBatches: 1, createAnalysis: async () => {
    const handle = async request => {
      calls.push(request)
      if (request.batch_index === undefined) return { status: 'complete', batch_count: 2, questionnaire: { version: 'v1', hash: 'c'.repeat(64) } }
      return { option_candidates: { questionnaire_version: 'v1', questionnaire_hash: 'c'.repeat(64), truncated: false,
        candidates: [{ question_id: 'q1', proposed_description: 'Unlisted option', count: 1, origins: [] }] } }
    }
    handle.dispose = () => {}
    return handle
  } })
  assert.deepEqual(calls.map(call => call.id), ['paper-a', 'paper-a'])
  assert.equal(report.inspected_batches, 1)
  assert.equal(report.truncated, true)
  assert.equal(report.candidates[0].origins[0].paper_id, 'paper-a')
})

test('missing jobs, legacy records, absent questionnaire summaries, and incomplete jobs are explicit', async () => {
  const report = await collectReadingOptionCandidates({ library: '/synthetic/library', localStateHome: '/synthetic/state', requests: [
    { id: 'paper-missing', request_id: 'r1' }, { id: 'paper-legacy', request_id: 'r2' },
    { id: 'paper-new', request_id: 'r3' }, { id: 'paper-active', request_id: 'r4' },
  ], createAnalysis: async () => async request => {
    if (request.id === 'paper-missing') return { status: 'idle' }
    if (request.id === 'paper-legacy') return { status: 'complete', batch_count: 1 }
    if (request.id === 'paper-new' && request.batch_index === undefined) return { status: 'partial', batch_count: 1, questionnaire: { version: 'v1', hash: 'd'.repeat(64) } }
    if (request.id === 'paper-new') return { status: 'partial' }
    return { status: 'reading', batch_count: 0, questionnaire: { version: 'v1', hash: 'e'.repeat(64) } }
  } })
  assert.equal(report.papers.find(row => row.id === 'paper-missing').question_protocol, 'missing')
  assert.equal(report.papers.find(row => row.id === 'paper-legacy').question_protocol, 'legacy')
  assert.ok(report.unavailable_records_or_batches.some(row => row.error_code === 'ANALYSIS_RECORD_MISSING'))
  assert.ok(report.unavailable_records_or_batches.some(row => row.error_code === 'CANDIDATE_SUMMARY_UNAVAILABLE'))
  assert.ok(report.incomplete_records.some(row => row.paper_id === 'paper-active'))
})

test('repeated candidate origins have a hard output budget and set truncated', () => {
  const summary = { questionnaire_version: 'v1', questionnaire_hash: 'f'.repeat(64), candidates: [
    { question_id: 'q2', proposed_description: 'One option', count: 1, origins: [] },
  ] }
  const result = mergeOptionCandidates([0, 1, 2].map(index => ({ paper_id: `p${index}`, request_id: `r${index}`, batch_index: index, summary })), { maxOrigins: 1 })
  assert.equal(result.candidates[0].count, 3)
  assert.equal(result.candidates[0].origins.length, 1)
  assert.equal(result.candidates[0].origins_truncated, true)
  assert.equal(result.truncated, true)
})
