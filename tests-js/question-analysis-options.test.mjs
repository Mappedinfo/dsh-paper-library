import test from 'node:test'
import assert from 'node:assert/strict'
import { analysisQuestionOptions, analysisInputOptions, validQuestionIds } from '../src/analysis-input.mjs'
import { validatePlan } from '../scripts/run-paper-analysis-batch.mjs'

test('question options preserve explicit values while the snapshot default stays omitted from request identity', () => {
  assert.deepEqual(analysisQuestionOptions({ mode: 'full' }), {})
  assert.deepEqual(analysisQuestionOptions({ mode: 'full', question_ids: ['q1', 'q4'], question_mode: 'separate' }),
    { question_ids: ['q1', 'q4'], question_mode: 'separate' })
  assert.deepEqual(analysisQuestionOptions({ question_mode: 'grouped' }), { question_mode: 'grouped' })
  assert.deepEqual(analysisInputOptions({ question_ids: ['q2'], question_mode: 'separate', input_format: 'markdown' }),
    { input_format: 'markdown' }, 'worker-format options stay separate')
})

test('question IDs accept the current manifest and historical IDs for saved request identity', () => {
  assert.equal(validQuestionIds(['q1', 'q6']), true)
  assert.equal(validQuestionIds(['q1_method', 'q1_dataset', 'q1_metric', 'q1_task', 'q5_metric_result']), true)
  assert.deepEqual(analysisQuestionOptions({ question_ids: ['q1_method', 'q1_dataset'] }), { question_ids: ['q1_method', 'q1_dataset'] })
  for (const question_ids of [[], ['q1', 'q1'], ['q7'], ['q1', 2], 'q1']) {
    assert.throws(() => analysisQuestionOptions({ question_ids }), { code: 'ANALYSIS_INVALID' })
  }
  assert.throws(() => analysisQuestionOptions({ mode: 'metadata', question_ids: ['q1'] }), { code: 'ANALYSIS_INVALID' })
  assert.throws(() => analysisQuestionOptions({ mode: 'metadata', question_mode: 'grouped' }), { code: 'ANALYSIS_INVALID' })
  assert.throws(() => analysisQuestionOptions({ question_mode: 'all-at-once' }), { code: 'ANALYSIS_INVALID' })
})

test('batch plan whitelist preserves valid question controls and rejects malformed or metadata options', () => {
  const base = { library: '/synthetic/library', request_id: 'synthetic-run', mode: 'full', notes: false, review: false,
    routes: [{ name: 'glm', config: '/synthetic/glm.json', ids: ['paper-a'] }] }
  assert.deepEqual(validatePlan({ ...base, question_ids: ['q2', 'q5'], question_mode: 'separate' }).question_ids, ['q2', 'q5'])
  assert.deepEqual(validatePlan({ ...base, question_ids: ['q1_method', 'q5_method_data'] }).question_ids, ['q1_method', 'q5_method_data'])
  assert.equal(validatePlan({ ...base, question_mode: 'grouped' }).question_mode, 'grouped')
  for (const options of [
    { question_ids: [] }, { question_ids: ['q1', 'q1'] }, { question_mode: 'legacy' },
    { mode: 'metadata', question_ids: ['q1'] }, { mode: 'metadata', question_mode: 'grouped' },
  ]) assert.throws(() => validatePlan({ ...base, ...options }), { code: 'BATCH_PLAN_INVALID' })
})
