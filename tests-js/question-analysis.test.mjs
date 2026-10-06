import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPaperAnalysis } from '../src/harness/paper-analysis.mjs'
import { createLocalStateStore } from '../src/local-state.mjs'
import { questionKey, readQuestionGroup } from '../src/harness/question-analysis.mjs'
import { REVIEW_SECTIONS } from '../src/prompt-templates.mjs'

async function fixture(t, override = {}) {
  const root = await mkdtemp(join(tmpdir(), 'question-analysis-'))
  const f = { root, calls: [], kernel: [], drafts: new Map(), modified: 'revision-1', pdfVersion: { size: 100, mtime_ns: '100' }, response: null }
  const source = page => ({ id: `source-${page}`, entity: { kind: 'paper', id: 'paper-a' }, locator: { page }, content_hash: `hash-${page}`,
    text: `Reading exercise ${page}. Method A produced result B. Check the evidence before accepting a conclusion.` })
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
        judgment: '检查证据后再接受结论。', evidence: [{ source_id: 'S1', quote: 'Check the evidence before accepting a conclusion.' }] })) })
    }, ...override }
  f.handle = createPaperAnalysis(f.options)
  f.input = { action: 'paper_analysis_start', id: 'paper-a', request_id: 'run-a', notes: false, review: false }
  f.run = async (extra = {}) => { await f.handle({ ...f.input, ...extra }); await f.handle.wait('paper-a', extra.request_id || 'run-a'); return f.handle({ action: 'paper_analysis_get', id: 'paper-a', request_id: extra.request_id || 'run-a' }) }
  t.after(async () => { f.handle.dispose(); await rm(root, { force: true, recursive: true }) })
  return f
}

test('grouped questions persist host-located evidence, raw replies and option candidates without metadata extraction', async t => {
  const f = await fixture(t), result = await f.run({ apply_metadata: true })
  assert.equal(result.status, 'complete', JSON.stringify(result))
  assert.equal(result.analysis_complete, true)
  assert.equal(result.question_coverage.complete, true)
  assert.equal(result.coverage.full_document, true)
  assert.equal(f.calls.length, 6)
  assert.deepEqual(f.calls.map(call => call.analysisContext.question_ids), [['q1','q2'],['q3','q4'],['q5','q6'],['q1','q2'],['q3','q4'],['q5','q6']])
  assert.equal(f.kernel.filter(call => call.action === 'paper_analysis_batch').length, 2)
  assert.equal(f.kernel.some(call => call.action === 'paper_analysis_apply_metadata'), false)
  assert.deepEqual(result.metadata, {})
  for (const call of f.calls) {
    assert.doesNotMatch(call.prompt, /DO_NOT_SEND_PRIVATE_METADATA|PAPER_ANALYSIS_JSON|Return the complete graph/)
    assert.match(call.prompt, /不提取原始 Abstract/)
  }
  const first = await f.handle({ action: 'paper_analysis_get', id: 'paper-a', request_id: 'run-a', batch_index: 0, include_raw: true })
  assert.equal(first.question_results.length, 3)
  assert.ok(first.question_results.every(group => JSON.parse(group.raw).answers.length === 2))
  assert.equal(first.option_candidates.candidates.length, 6)
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
  assert.equal(f.calls.length, 6)
})

test('one bad quote and one failed request retain valid answers and continue later questions and pages', async t => {
  const f = await fixture(t)
  f.response = input => {
    const context = input.analysisContext
    if (context.batch_index === 0 && context.question_ids.includes('q3')) throw new Error('synthetic provider failure')
    return JSON.stringify({ answers: context.question_ids.map(question_id => ({ question_id, choice: 'other', judgment: '合成判断',
      evidence: [{ source_id: 'S1', quote: context.batch_index === 0 && question_id === 'q1' ? 'invented text' : 'Method A produced result B.' }] })) })
  }
  const result = await f.run()
  assert.equal(result.status, 'partial')
  assert.equal(result.analysis_complete, false)
  assert.equal(result.coverage.full_document, true, 'text extraction completeness is distinct from successful answers')
  assert.equal(result.batch_count, 2)
  assert.equal(f.calls.length, 6)
  assert.equal(result.question_coverage.by_question.q2.answered_batches, 2, 'q2 remains usable when q1 fails in their shared response')
  assert.deepEqual(result.question_coverage.by_question.q1.failed_batches, [0])
  assert.deepEqual(result.question_coverage.by_question.q3.failed_batches, [0])
  assert.equal(result.question_coverage.by_question.q5.answered_batches, 2)
  const first = await f.handle({ action: 'paper_analysis_get', id: 'paper-a', batch_index: 0, include_raw: true })
  assert.match(first.question_results[0].raw, /invented text/)
  assert.equal(first.batch_answers.find(answer => answer.question_id === 'q1').valid, false)
  assert.ok(first.draft.nodes.every(node => node.quote !== 'invented text'))
  assert.equal(first.question_results[1].status, 'partial')
})

test('separate subset invokes only selected questions; neutral answers do not fabricate graph claims', async t => {
  const f = await fixture(t)
  f.response = input => JSON.stringify({ answers: input.analysisContext.question_ids.map(question_id => ({ question_id, choice: 'not_reported' })) })
  const result = await f.run({ question_ids: ['q2', 'q6'], question_mode: 'separate' })
  assert.equal(result.status, 'complete', JSON.stringify(result))
  assert.equal(result.question_coverage.full_questionnaire, false)
  assert.deepEqual(f.calls.map(call => call.analysisContext.question_ids), [['q2'],['q6'],['q2'],['q6']])
  assert.equal(f.kernel.filter(call => call.action === 'knowledge_draft_put' && call.nodes.length).length, 0)
  assert.ok(result.batch_answers.every(answer => answer.neutral && !answer.scope.full_document))
  await assert.rejects(f.handle({ ...f.input, question_ids: ['q2'], question_mode: 'separate' }), { code: 'ANALYSIS_CONFLICT' })
})

test('graph write failure does not erase saved answers or stop the next page', async t => {
  const f = await fixture(t); f.graphError = true
  const result = await f.run()
  assert.equal(result.status, 'partial')
  assert.equal(result.question_coverage.complete, true)
  assert.equal(result.analysis_complete, false)
  assert.equal(result.batch_answers.length, 6)
  assert.equal(result.batch_count, 2)
  assert.match(result.batch_graph_error, /synthetic graph persistence/)
})

test('graph budget omissions remain inspectable and cannot count as a complete deliverable', async t => {
  const f = await fixture(t)
  f.response = input => JSON.stringify({ answers: Array.from({ length: 12 }, (_, index) => ({
    question_id: input.analysisContext.question_ids[index % 2], choice: 'other', judgment: `合成判断 ${index}`,
    evidence: [{ source_id: 'S1', quote: 'Method A produced result B.' }, { source_id: 'S1', quote: 'Check the evidence before accepting a conclusion.' }],
  })) })
  const result = await f.run()
  assert.equal(result.status, 'partial')
  assert.equal(result.analysis_complete, false)
  assert.equal(result.question_coverage.complete, true)
  assert.equal(result.batch_answers.length, 36)
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
  assert.equal(result.active_questions[0].answers.length, 2)
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

test('an unrequested invalid answer cannot leave the group partial while the overall job claims complete', async t => {
  const f = await fixture(t)
  f.response = input => JSON.stringify({ answers: [
    ...input.analysisContext.question_ids.map(question_id => ({ question_id, choice: 'not_reported' })),
    { question_id: 'q99', choice: 'not_reported' },
  ] })
  const result = await f.run({ question_ids: ['q1'] })
  assert.equal(result.question_results[0].status, 'partial')
  assert.equal(result.status, 'partial')
  assert.equal(result.analysis_complete, false)
})

test('a requested reading note with material-budget omissions cannot make full analysis complete', async t => {
  const f = await fixture(t)
  f.response = input => input.analysisContext.stage === 'note'
    ? JSON.stringify({ title: '合成部分阅读笔记', body: '仅分析实际送入的批次。' })
    : JSON.stringify({ answers: input.analysisContext.question_ids.map(question_id => ({ question_id, choice: 'other',
      judgment: '保持条件与证据。'.repeat(20), evidence: [{ source_id: 'S1', quote: 'Check the evidence before accepting a conclusion.' }] })) })
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
  const result = await f.run({ question_ids: ['q1'] })
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
      ? JSON.stringify({ answers: [{ question_id: 'q1', choice: 'method', judgment: 'Method A', evidence: [{ source_id: 'S1', quote: 'Method A produced result B.' }] }] })
      : JSON.stringify(stage === 'note' ? { title: '合成阅读笔记', body: '仅使用可保存出处的材料。' }
        : { title: '证据图谱评审：合成材料', body: REVIEW_SECTIONS.map(section => `## ${section}\n仅使用可保存出处的材料。`).join('\n') })
    const result = await f.run({ question_ids: ['q1'], notes: stage === 'note', review: stage === 'review' })
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
