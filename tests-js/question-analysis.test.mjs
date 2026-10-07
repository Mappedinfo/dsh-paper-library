import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPaperAnalysis } from '../src/harness/paper-analysis.mjs'
import { createLocalStateStore } from '../src/local-state.mjs'
import { questionKey, readQuestionGroup } from '../src/harness/question-analysis.mjs'
import { REVIEW_SECTIONS } from '../src/prompt-templates.mjs'
import { loadQuestionnaire, questionGroups } from '../src/reading-questions.mjs'

const questionnaire = loadQuestionnaire()
const questionIds = questionnaire.questions.map(question => question.id)
const groups = questionGroups(questionnaire)
const callsPerBatch = groups.length
// e035446 的真实 v3 协议；旧题目资产保留供历史作业读取。
const savedV2Protocol = JSON.parse(readFileSync(new URL('./fixtures/reading-protocol-v2.json', import.meta.url), 'utf8'))
const savedV3Protocol = JSON.parse(readFileSync(new URL('./fixtures/reading-protocol-v3.json', import.meta.url), 'utf8'))

async function fixture(t, override = {}) {
  const root = await mkdtemp(join(tmpdir(), 'question-analysis-'))
  const f = { root, calls: [], kernel: [], drafts: new Map(), modified: 'revision-1', pdfVersion: { size: 100, mtime_ns: '100' }, response: null }
  const source = page => ({ id: `source-${page}`, entity: { kind: 'paper', id: 'paper-a' }, locator: { page }, content_hash: `hash-${page}`,
    text: `Reading exercise ${page}. Method A produced result B. Check the evidence before accepting a conclusion. Reading checks improve recall. Nine of twelve readers recalled the passage after a source check.` })
  f.store = createLocalStateStore({ library: join(root, 'library'), home: join(root, 'state') })
  f.options = { store: f.store, library: join(root, 'library'), resolveModel: async () => ({ provider: 'synthetic', model: 'deterministic' }),
    dispatch: async request => {
      f.kernel.push(request)
      if (request.action === 'get') return { id: request.id, pdf: true, title: 'Learning exercise', modified: f.modified, abstract: 'DO_NOT_SEND_PRIVATE_METADATA' }
      if (request.action === 'paper_analysis_batch') {
        const page = (request.cursor?.index || 0) + 1, sources = [source(page)]
        return { paper: { id: request.id, title: 'Learning exercise', abstract: 'DO_NOT_SEND_PRIVATE_METADATA' }, expected_modified: f.modified,
          file_version: structuredClone(f.pdfVersion), sources, source_ids: sources.map(item => item.id),
          coverage: { read_pages: [page], completed_pages: [page], requested_pages: [1, 2], page_count: 2, characters: sources[0].text.length },
          next_cursor: page === 1 ? { index: 1, offset: 0 } : null }
      }
      if (request.action === 'knowledge_draft_put') {
        if (f.graphError && request.mode === 'graph') throw new Error('synthetic graph persistence error')
        const value = { ...request, id: `draft-${f.drafts.size}`, status: 'needs-review' }
        f.drafts.set(value.id, value); return structuredClone(value)
      }
      if (request.action === 'knowledge_draft_get') return structuredClone(f.drafts.get(request.id))
      if (request.action === 'knowledge_source_get') return source(Number(request.id.split('-')[1]))
      throw new Error(`Unexpected operation: ${request.action}`)
    },
    agent: async input => {
      f.calls.push(input)
      if (f.response) return f.response(input)
      return JSON.stringify({ answers: input.analysisContext.question_ids.map(question_id => ({ question_id, choice: 'other',
        ...(question_id.startsWith('q4_') ? { target_claim: { source_id: 'S1', quote: 'Reading checks improve recall.' } } : {}),
        judgment: '检查证据后再接受结论。', evidence: [{ source_id: 'S1', quote: question_id.startsWith('q4_') ? 'Nine of twelve readers recalled the passage after a source check.' : 'Check the evidence before accepting a conclusion.' }] })) })
    }, ...override }
  f.handle = createPaperAnalysis(f.options)
  f.input = { action: 'paper_analysis_start', id: 'paper-a', request_id: 'run-a', notes: false, review: false }
  f.run = async (extra = {}) => { await f.handle({ ...f.input, ...extra }); await f.handle.wait('paper-a', extra.request_id || 'run-a'); return f.handle({ action: 'paper_analysis_get', id: 'paper-a', request_id: extra.request_id || 'run-a' }) }
  t.after(async () => { f.handle.dispose(); await rm(root, { force: true, recursive: true }) })
  return f
}

test('twenty-three separate questions persist host-located evidence, raw replies and option candidates without metadata extraction', async t => {
  const f = await fixture(t), result = await f.run({ apply_metadata: true })
  assert.equal(result.status, 'complete', JSON.stringify(result))
  assert.equal(result.analysis_complete, true)
  assert.equal(result.question_coverage.complete, true)
  assert.equal(result.coverage.full_document, true)
  assert.equal(questionnaire.version, 'reading-questions-v4')
  assert.deepEqual(questionIds, ["q1_method","q1_dataset","q1_metric","q1_task","q2_author_claim","q2_reported_result","q2_reader_inference","q3_text","q3_figure","q3_table","q3_formula","q4_supports","q4_qualifies","q4_contradicts","q5_method_data","q5_method_result","q5_data_result","q5_metric_result","q5_task_result","q6_research_question","q6_study_limitation","q6_prior_gap","q6_reader_check"])
  assert.deepEqual(groups, questionIds.map(id => [id]))
  assert.equal(f.calls.length, 2 * callsPerBatch)
  assert.deepEqual(f.calls.map(call => call.analysisContext.question_ids), [...groups, ...groups])
  assert.equal(f.kernel.filter(call => call.action === 'paper_analysis_batch').length, 2)
  assert.equal(f.kernel.some(call => call.action === 'paper_analysis_apply_metadata'), false)
  assert.deepEqual(result.metadata, {})
  for (const call of f.calls) {
    assert.doesNotMatch(call.prompt, /DO_NOT_SEND_PRIVATE_METADATA|PAPER_ANALYSIS_JSON|Return the complete graph/)
    assert.match(call.prompt, /不提取原始 Abstract/)
  }
  const first = await f.handle({ action: 'paper_analysis_get', id: 'paper-a', request_id: 'run-a', batch_index: 0, include_raw: true })
  assert.equal(first.question_results.length, callsPerBatch)
  assert.ok(first.question_results.every(group => JSON.parse(group.raw).answers.length === 1))
  assert.equal(first.option_candidates.candidates.length, questionIds.length)
  assert.equal(first.option_candidates.active_config_changed, false)
  for (const answer of first.batch_answers) {
    assert.equal(answer.valid, true)
    assert.equal(answer.evidence[0].source_id, 'source-1')
    assert.equal(answer.evidence[0].page, 1)
    assert.equal(answer.evidence[0].match, 'exact')
    assert.ok(answer.evidence[0].end_utf16 > answer.evidence[0].start_utf16)
  }
  const restarted = createPaperAnalysis(f.options)
  assert.equal((await restarted({ ...f.input, apply_metadata: true })).questionnaire.hash, result.questionnaire.hash)
  assert.equal(f.calls.length, 2 * callsPerBatch)
})

test('one bad quote and one failed request retain valid answers and continue later questions and pages', async t => {
  const f = await fixture(t)
  f.response = input => {
    const context = input.analysisContext
    if (context.batch_index === 0 && context.question_ids.includes('q3_text')) throw new Error('synthetic provider failure')
    return JSON.stringify({ answers: context.question_ids.map(question_id => ({ question_id, choice: 'other', judgment: '合成判断',
      ...(question_id.startsWith('q4_') ? { target_claim: { source_id: 'S1', quote: 'Reading checks improve recall.' } } : {}),
      evidence: [{ source_id: 'S1', quote: context.batch_index === 0 && question_id === 'q1_method' ? 'invented text' : question_id.startsWith('q4_') ? 'Nine of twelve readers recalled the passage after a source check.' : 'Method A produced result B.' }] })) })
  }
  const result = await f.run()
  assert.equal(result.status, 'partial')
  assert.equal(result.analysis_complete, false)
  assert.equal(result.coverage.full_document, true, 'text extraction completeness is distinct from successful answers')
  assert.equal(result.batch_count, 2)
  assert.equal(f.calls.length, 2 * callsPerBatch)
  assert.equal(result.question_coverage.by_question.q2_author_claim.answered_batches, 2, 'the author-claim question remains usable when the separate method question fails')
  assert.deepEqual(result.question_coverage.by_question.q1_method.failed_batches, [0])
  assert.deepEqual(result.question_coverage.by_question.q3_text.failed_batches, [0])
  assert.equal(result.question_coverage.by_question.q5_method_result.answered_batches, 2)
  const first = await f.handle({ action: 'paper_analysis_get', id: 'paper-a', batch_index: 0, include_raw: true })
  assert.match(first.question_results[0].raw, /invented text/)
  assert.equal(first.batch_answers.find(answer => answer.question_id === 'q1_method').valid, false)
  assert.ok(first.draft.nodes.every(node => node.quote !== 'invented text'))
  assert.equal(first.question_results.find(group => group.question_ids.includes('q3_text')).status, 'partial')
})

test('separate subset invokes only selected questions; neutral answers do not fabricate graph claims', async t => {
  const f = await fixture(t)
  f.response = input => JSON.stringify({ answers: input.analysisContext.question_ids.map(question_id => ({ question_id, choice: 'not_reported' })) })
  const result = await f.run({ question_ids: ['q2_author_claim', 'q6_reader_check'], question_mode: 'separate' })
  assert.equal(result.status, 'complete', JSON.stringify(result))
  assert.equal(result.question_coverage.full_questionnaire, false)
  assert.deepEqual(f.calls.map(call => call.analysisContext.question_ids), [['q2_author_claim'],['q6_reader_check'],['q2_author_claim'],['q6_reader_check']])
  assert.equal(f.kernel.filter(call => call.action === 'knowledge_draft_put' && call.nodes.length).length, 0)
  assert.ok(result.batch_answers.every(answer => answer.neutral && !answer.scope.full_document))
  await assert.rejects(f.handle({ ...f.input, question_ids: ['q2_author_claim'], question_mode: 'separate' }), { code: 'ANALYSIS_CONFLICT' })
})

test('the two reader-generated questions run independently and preserve inferred attribution', async t => {
  const f = await fixture(t), ids = ['q2_reader_inference', 'q6_reader_check']
  f.response = input => JSON.stringify({ answers: input.analysisContext.question_ids.map(question_id => ({
    question_id, choice: questionnaire.questions.find(question => question.id === question_id).options[0].id,
    judgment: question_id === 'q2_reader_inference' ? '读者推断：这项结果可能依赖参与者原有训练，尚待核对。' : '读者待核对：两组参与者的原有训练是否可比？',
    evidence: [{ source_id: 'S1', quote: 'Nine of twelve readers recalled the passage after a source check.' }],
  })) })
  const result = await f.run({ question_ids: ids })
  assert.equal(result.status, 'complete', JSON.stringify(result))
  assert.deepEqual(f.calls.map(call => call.analysisContext.question_ids), [[ids[0]], [ids[1]], [ids[0]], [ids[1]]])
  assert.equal(f.kernel.filter(call => call.action === 'paper_analysis_batch').length, 2, 'both reader questions reuse each extracted batch')
  for (const id of ids) assert.equal(result.question_coverage.by_question[id].answered_batches, 2)
  const first = await f.handle({ action: 'paper_analysis_get', id: 'paper-a', request_id: 'run-a', batch_index: 0, include_raw: true })
  assert.equal(first.batch_answers.length, 2)
  assert.ok(first.batch_answers.every(answer => answer.valid && answer.source_status === 'inferred'))
  assert.ok(first.question_results.every(group => JSON.parse(group.raw).answers.length === 1))
  assert.ok(first.draft.nodes.some(node => node.fields?.question_id === 'q2_reader_inference' && node.fields.source_status === 'inferred'))
  assert.ok(first.draft.nodes.some(node => node.fields?.question_id === 'q6_reader_check' && node.type === 'question' && node.source_status === 'inferred'))
})

test('graph write failure does not erase saved answers or stop the next page', async t => {
  const f = await fixture(t); f.graphError = true
  const result = await f.run()
  assert.equal(result.status, 'partial')
  assert.equal(result.question_coverage.complete, true)
  assert.equal(result.analysis_complete, false)
  assert.equal(result.batch_answers.length, questionIds.length)
  assert.equal(result.batch_count, 2)
  assert.match(result.batch_graph_error, /synthetic graph persistence/)
})

test('graph budget omissions remain inspectable and cannot count as a complete deliverable', async t => {
  const f = await fixture(t)
  f.response = input => JSON.stringify({ answers: Array.from({ length: 12 }, (_, index) => ({
    question_id: input.analysisContext.question_ids[index % input.analysisContext.question_ids.length], choice: 'other', judgment: `合成判断 ${index}`,
    evidence: [{ source_id: 'S1', quote: 'Method A produced result B.' }, { source_id: 'S1', quote: 'Check the evidence before accepting a conclusion.' }],
  })) })
  const selected = ['q1_method', 'q1_dataset', 'q1_metric', 'q1_task']
  const result = await f.run({ question_ids: selected })
  assert.equal(result.status, 'partial')
  assert.equal(result.analysis_complete, false)
  assert.equal(result.question_coverage.complete, true)
  assert.equal(result.batch_answers.length, 12 * selected.length)
  assert.equal(result.batch_compilation.truncated, true)
  assert.ok(result.batch_compilation.excluded_answers.some(answer => answer.reason === 'graph-budget-whole-answer-omitted'))
})

test('call budget stops new extraction and keeps completed question groups inspectable', async t => {
  const f = await fixture(t)
  f.response = input => {
    if (f.calls.length > 1) throw Object.assign(new Error('limit reached'), { code: 'DIRECT_MODEL_BUDGET_EXHAUSTED' })
    return JSON.stringify({ answers: input.analysisContext.question_ids.map(question_id => ({ question_id, choice: 'not_reported' })) })
  }
  const result = await f.run()
  assert.equal(result.status, 'failed')
  assert.equal(result.error_code, 'DIRECT_MODEL_BUDGET_EXHAUSTED')
  assert.equal(result.analysis_complete, false)
  assert.equal(f.kernel.filter(call => call.action === 'paper_analysis_batch').length, 1)
  assert.equal(f.calls.length, 2)
  assert.equal(result.active_questions[0].status, 'complete')
  assert.equal(result.active_questions[0].answers.length, groups[0].length)
})

test('fatal quota persists its failed question group then stops later groups and synthesis', async t => {
  const f = await fixture(t)
  f.response = () => { throw Object.assign(new Error('provider raw quota detail must not be persisted'), { code: 'DIRECT_MODEL_QUOTA_EXHAUSTED' }) }
  const result = await f.run({ notes: true, review: true })
  assert.equal(result.status, 'failed')
  assert.equal(result.error_code, 'DIRECT_MODEL_QUOTA_EXHAUSTED')
  assert.equal(f.calls.length, 1)
  assert.equal(f.kernel.filter(call => call.action === 'paper_analysis_batch').length, 1)
  assert.equal(f.kernel.some(call => call.action === 'knowledge_draft_put'), false)
  const group = await readQuestionGroup(f.store, questionKey('paper-a', 'run-a', 0, 0), true)
  assert.equal(group.status, 'partial')
  assert.equal(group.request_error.code, 'DIRECT_MODEL_QUOTA_EXHAUSTED')
  assert.doesNotMatch(group.request_error.message, /raw quota detail/)
  assert.equal(result.analysis_complete, false)
})

test('output truncation details persist safely and stop the current paper before later groups', async t => {
  const f = await fixture(t)
  f.response = () => { throw Object.assign(new Error('truncated'), { code: 'DIRECT_MODEL_OUTPUT_TRUNCATED', details: {
    stop_reason: 'max_tokens', max_output_tokens: 16384, output_tokens: 16384, thinking_tokens: 12000, secret: 'do-not-copy',
  } }) }
  const result = await f.run({ notes: true, review: true })
  assert.equal(result.status, 'failed')
  assert.equal(result.error_code, 'DIRECT_MODEL_OUTPUT_TRUNCATED')
  assert.equal(f.calls.length, 1)
  assert.equal(f.kernel.filter(call => call.action === 'paper_analysis_batch').length, 1)
  const group = await readQuestionGroup(f.store, questionKey('paper-a', 'run-a', 0, 0), true)
  assert.deepEqual(group.request_error.details, { stop_reason: 'max_tokens', max_output_tokens: 16384, output_tokens: 16384, thinking_tokens: 12000 })
  assert.doesNotMatch(JSON.stringify(group.request_error), /do-not-copy/)
})

test('historical job fingerprints remain readable and never replay under the new questionnaire', async t => {
  const f = await fixture(t)
  const hash = (await import('node:crypto')).createHash
  const digest = value => hash('sha256').update(JSON.stringify(value)).digest('hex')
  const request = { id: 'paper-a', request_id: 'old', apply_metadata: false, review: false, notes: false }
  const key = `analysis.job:${digest(request.id)}:${digest(request.request_id)}`
  await f.store.put(key, { ...request, fingerprint: digest(request), status: 'complete', metadata: { title: 'Old suggestion' } }, 0)
  const result = await f.handle({ action: 'paper_analysis_start', ...request })
  assert.equal(result.status, 'complete')
  assert.equal(result.questionnaire, undefined)
  assert.equal(result.analysis_complete, undefined)
  assert.equal(f.calls.length, 0)
})

test('saved v1, v2 and genuine v3 questionnaire snapshots retain original question IDs and never replay under v4', async t => {
  const f = await fixture(t)
  const { createHash } = await import('node:crypto')
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const legacyIds = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6']
  const legacyGroups = [['q1','q2'], ['q3','q4'], ['q5','q6']]
  const definitions = await Promise.all(legacyIds.map(id => readFile(new URL(`../prompts/reading/${id}.json`, import.meta.url), 'utf8').then(JSON.parse)))
  for (const version of ['reading-questions-v1', 'reading-questions-v2', 'reading-questions-v3']) {
    const protocol = version.endsWith('v3') ? structuredClone(savedV3Protocol) : { ...structuredClone(savedV2Protocol), version }
    if (!version.endsWith('v3')) { delete protocol.question_ids; delete protocol.default_mode }
    const questions = version.endsWith('v3')
      ? await Promise.all(protocol.question_ids.map(id => readFile(new URL(`../prompts/reading/${id}.json`, import.meta.url), 'utf8').then(JSON.parse)))
      : structuredClone(definitions)
    const savedGroups = version.endsWith('v3') ? savedV3Protocol.default_groups : legacyGroups
    if (version.endsWith('v1')) {
      delete protocol.codebook_required
      for (const question of questions) {
        delete question.examples
        for (const option of question.options) { delete option.coding; if (option.graph) delete option.graph.endpoints }
      }
      for (const option of protocol.common_options) delete option.coding
    }
    const snapshot = { version, protocol, questions }
    snapshot.hash = digest(snapshot)
    assert.deepEqual(questionGroups(snapshot), savedGroups, 'old snapshots retain their original grouped or separate default')
    if (version.endsWith('v3')) {
      assert.equal(questions.length, 13)
      assert.equal(questions.find(question => question.id === 'q2').options.length, 3, 'the real unsplit author/result/inference question remains in the saved definition')
      assert.ok(questions.some(question => question.id === 'q6'))
      assert.equal(questions.some(question => question.id === 'q2_author_claim'), false)
    }
    const historical = { id: 'paper-a', request_id: version, apply_metadata: false, review: false, notes: false }
    const key = `analysis.job:${digest(historical.id)}:${digest(historical.request_id)}`
    const saved = await f.store.put(key, { ...historical, fingerprint: digest(historical), status: 'complete',
      questionnaire: { version, hash: snapshot.hash, groups: structuredClone(savedGroups) }, questionnaire_snapshot: snapshot, analysis_complete: true }, 0)
    const result = await f.handle({ action: 'paper_analysis_start', ...historical })
    assert.equal(result.status, 'complete')
    assert.deepEqual(result.questionnaire, { version, hash: snapshot.hash, groups: savedGroups })
    const reread = await f.store.get(key)
    assert.equal(reread.revision, saved.revision)
    assert.deepEqual(reread.value.questionnaire_snapshot, snapshot)
    assert.equal(f.calls.length, 0)
    assert.equal(f.kernel.length, 0, 'reading a frozen saved job never extracts source pages or resolves a new model')
  }
})

test('an unrequested invalid answer cannot leave the group partial while the overall job claims complete', async t => {
  const f = await fixture(t)
  f.response = input => JSON.stringify({ answers: [
    ...input.analysisContext.question_ids.map(question_id => ({ question_id, choice: 'not_reported' })),
    { question_id: 'q99', choice: 'not_reported' },
  ] })
  const result = await f.run({ question_ids: ['q1_method'] })
  assert.equal(result.question_results[0].status, 'partial')
  assert.equal(result.status, 'partial')
  assert.equal(result.analysis_complete, false)
})

test('a requested reading note with material-budget omissions cannot make full analysis complete', async t => {
  const f = await fixture(t)
  f.response = input => input.analysisContext.stage === 'note'
    ? JSON.stringify({ title: '合成部分阅读笔记', body: '仅分析实际送入的批次。' })
    : JSON.stringify({ answers: input.analysisContext.question_ids.map(question_id => ({ question_id, choice: 'other',
      judgment: '保持条件与证据。'.repeat(20),
      ...(question_id.startsWith('q4_') ? { target_claim: { source_id: 'S1', quote: 'Reading checks improve recall.' } } : {}), evidence: [{ source_id: 'S1', quote: question_id.startsWith('q4_') ? 'Nine of twelve readers recalled the passage after a source check.' : 'Check the evidence before accepting a conclusion.' }] })) })
  const result = await f.run({ notes: true })
  assert.equal(result.question_coverage.complete, true)
  assert.ok(result.note_draft_id, 'the smaller available material may still produce a reviewable note')
  assert.equal(result.note_coverage.partial, true)
  assert.equal(result.status, 'partial')
  assert.equal(result.analysis_complete, false)
})

test('a response saved before an answer-checkpoint failure remains inspectable without reissuing the model', async t => {
  const f = await fixture(t), originalStore = f.store
  f.handle.dispose()
  f.options.store = { get: (...args) => originalStore.get(...args), put: (key, value, revision) => {
    if (key.endsWith(':answer:0')) throw new Error('synthetic answer-checkpoint failure')
    return originalStore.put(key, value, revision)
  } }
  f.handle = createPaperAnalysis(f.options)
  const result = await f.run({ question_ids: ['q1_method'] })
  assert.equal(result.status, 'failed')
  assert.equal(f.calls.length, 1)
  const group = await readQuestionGroup(originalStore, questionKey('paper-a', 'run-a', 0, 0), true)
  assert.ok(group.raw.includes('Check the evidence before accepting a conclusion.'), 'already persisted raw response must remain reachable through its group manifest')
  assert.notEqual(group.status, 'complete')
  const seen = await f.handle({ action: 'paper_analysis_get', id: 'paper-a', request_id: 'run-a', include_raw: true })
  assert.ok(seen.active_questions[0].raw.includes('Check the evidence before accepting a conclusion.'))
  assert.equal(f.calls.length, 1)
})

test('synthesis cannot consume evidence whose sources exceed the persisted note provenance budget', async t => {
  for (const stage of ['note', 'review']) {
    const f = await fixture(t), dispatch = f.options.dispatch
    const source = page => ({ id: `source-${page}`, entity: { kind: 'paper', id: 'paper-a' }, locator: { page }, content_hash: `hash-${page}`,
      text: `Page ${page}. Method A produced result B. `.padEnd(8000, 'x') })
    f.handle.dispose()
    f.options.dispatch = async request => {
      if (request.action === 'paper_analysis_batch') {
        const page = (request.cursor?.index || 0) + 1, value = source(page)
        return { paper: { id: request.id }, expected_modified: 'revision-1', file_version: structuredClone(f.pdfVersion), sources: [value], source_ids: [value.id],
          coverage: { read_pages: [page], completed_pages: [page], requested_pages: [1, 2, 3, 4], page_count: 4, characters: 8000 },
          next_cursor: page < 4 ? { index: page, offset: 0 } : null }
      }
      if (request.action === 'knowledge_source_get') return source(Number(request.id.split('-')[1]))
      return dispatch(request)
    }
    f.handle = createPaperAnalysis(f.options)
    f.response = input => input.analysisContext.stage === 'batch'
      ? JSON.stringify({ answers: [{ question_id: 'q1_method', choice: 'method', judgment: 'Method A', evidence: [{ source_id: 'S1', quote: 'Method A produced result B.' }] }] })
      : JSON.stringify(stage === 'note' ? { title: '合成阅读笔记', body: '仅使用可保存出处的材料。' }
        : { title: '证据图谱评审：合成材料', body: REVIEW_SECTIONS.map(section => `## ${section}\n仅使用可保存出处的材料。`).join('\n') })
    const result = await f.run({ question_ids: ['q1_method'], notes: stage === 'note', review: stage === 'review' })
    assert.equal(result.question_coverage.complete, true)
    const call = f.calls.find(call => call.analysisContext.stage === stage)
    const saved = [...f.drafts.values()].find(draft => draft.id === result[`${stage}_draft_id`])
    assert.ok(call && saved)
    const material = JSON.parse(call.prompt.split('READING_RECORDS_JSON:\n')[1].split('\nEND_OF_READING_RECORDS')[0])
    const sentSources = new Set(material.batches.flatMap(batch => [
      ...(batch.answers || []).flatMap(answer => answer.evidence.map(ref => ref.source_id)),
      ...(batch.nodes || []).map(node => node.source_id).filter(Boolean),
    ]))
    assert.ok([...sentSources].every(id => saved.source_ids.includes(id)), 'every source used by synthesis must be included in the saved note provenance')
    assert.ok(call.analysisContext.source_ids.every(id => saved.source_ids.includes(id)))
    assert.equal(result[`${stage}_coverage`].partial, true)
    assert.equal(result.status, 'partial')
  }
})
