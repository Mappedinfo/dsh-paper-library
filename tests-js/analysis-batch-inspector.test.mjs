import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectBatch } from '../scripts/inspect-paper-analysis-batch.mjs'

async function fixture({ route, analysis, sourceText = 'A source quote.', selectionSha256, noteStatus = 'needs-review' }) {
  const root = await mkdtemp(join(tmpdir(), 'analysis-inspector-test-'))
  const library = join(root, 'library'), run = join(root, 'run')
  await mkdir(library); await mkdir(run)
  const pdf = join(root, 'synthetic.pdf'), bytes = Buffer.from('%PDF- synthetic test bytes\n')
  await writeFile(pdf, bytes, { mode: 0o600 })
  const plan = { library, request_id: 'batch-request', mode: 'full', notes: true, review: false,
    routes: [{ name: 'route-a', ids: ['paper-a'] }] }
  const selection = { papers: [{ id: 'paper-a', title: 'Synthetic title', path: pdf,
    sha256: selectionSha256 ?? createHash('sha256').update(bytes).digest('hex'), size: bytes.length }] }
  await writeFile(join(root, 'plan.json'), JSON.stringify(plan))
  await writeFile(join(root, 'selection.json'), JSON.stringify(selection))
  await writeFile(join(run, 'result.json'), JSON.stringify({ status: 'partial', request_id: 'batch-request', calls: 1, routes: [route] }))
  try {
    const report = await inspectBatch({ planPath: join(root, 'plan.json'), runPath: run, selectionPath: join(root, 'selection.json'),
      createAnalysis: async () => analysis, dispatch: async request => {
        if (request.action === 'knowledge_draft_get') return { status: noteStatus }
        if (request.action === 'knowledge_source_get') return { id: request.id, entity: { kind: 'paper', id: 'paper-a' }, text: sourceText }
        throw new Error('unexpected synthetic action')
      } })
    return { report, run }
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error }
  finally { /* caller removes run after assertions */ }
}

test('a failed route without rows still counts every planned paper and does not read latest records', async () => {
  let reads = 0
  const f = await fixture({ route: { name: 'route-a', status: 'failed', error_code: 'ROUTE_FAILED', results: [] },
    analysis: async () => { reads++; return { status: 'complete' } } })
  try {
    assert.deepEqual(f.report.counts, { total: 1, success: 0, partial: 0, failed: 1 })
    assert.equal(f.report.papers[0].status, 'failed')
    assert.equal(f.report.papers[0].error_code, 'ROUTE_FAILED')
    assert.equal(f.report.papers[0].pdf.status, 'match')
    assert.equal(reads, 0)
  } finally { await rm(f.run, { recursive: true, force: true }); await rm(join(f.run, '..'), { recursive: true, force: true }) }
})

test('an analysis-record read failure remains in the failure count', async () => {
  const f = await fixture({ route: { name: 'route-a', status: 'partial', results: [{ id: 'paper-a', request_id: 'exact-run', status: 'complete' }] },
    analysis: async () => { throw Object.assign(new Error('synthetic'), { code: 'STATE_CORRUPT' }) } })
  try {
    assert.deepEqual(f.report.counts, { total: 1, success: 0, partial: 0, failed: 1 })
    assert.equal(f.report.papers[0].record_error, 'STATE_CORRUPT')
    assert.equal(f.report.papers[0].inspection_warnings.includes('ANALYSIS_RECORD_UNAVAILABLE'), true)
  } finally { await rm(f.run, { recursive: true, force: true }); await rm(join(f.run, '..'), { recursive: true, force: true }) }
})

test('a complete record missing its required review note is partial, with clear draft-count scope', async () => {
  const record = { status: 'complete', coverage: { page_count: 1, read_pages: [1], completed_pages: [1], full_document: true },
    batch_count: 1, draft_id: 'graph-draft', metadata: { title: 'synthetic' } }
  const f = await fixture({ route: { name: 'route-a', status: 'complete', results: [{ id: 'paper-a', request_id: 'exact-run', status: 'complete' }] },
    analysis: async request => request.batch_index === 0 ? { ...record, draft: { nodes: [{ source_id: 'source-a', quote: 'A source quote.' }] } } : record })
  try {
    const paper = f.report.papers[0]
    assert.deepEqual(f.report.counts, { total: 1, success: 0, partial: 1, failed: 0 })
    assert.equal(paper.coverage_class, 'partial')
    assert.ok(paper.inspection_warnings.includes('NOTE_MISSING'))
    assert.equal(paper.visible_draft_count, 1)
    assert.equal(paper.last_batch_node_count, 1)
    assert.equal(Object.hasOwn(paper, 'draft_count'), false)
    assert.equal(paper.evidence_quote_check.matched, 1)
    assert.match(await readFile(join(f.run, 'summary.md'), 'utf8'), /部分覆盖 1 篇/)
    assert.equal((await stat(join(f.run, 'inspect.json'))).mode & 0o777, 0o600)
  } finally { await rm(f.run, { recursive: true, force: true }); await rm(join(f.run, '..'), { recursive: true, force: true }) }
})

test('a complete record with unreviewed note, bad evidence quote, or changed PDF cannot count as success', async () => {
  const record = { status: 'complete', coverage: { page_count: 1, read_pages: [1], completed_pages: [1], full_document: true },
    batch_count: 1, draft_id: 'graph-draft', note_draft_id: 'note-draft' }
  const f = await fixture({ route: { name: 'route-a', status: 'complete', results: [{ id: 'paper-a', request_id: 'exact-run', status: 'complete' }] },
    analysis: async request => request.batch_index === 0 ? { ...record, draft: { nodes: [{ source_id: 'source-a', quote: 'A source quote.' }] } } : record,
    sourceText: 'Different source text.', noteStatus: 'accepted', selectionSha256: '0'.repeat(64) })
  try {
    const paper = f.report.papers[0]
    assert.deepEqual(f.report.counts, { total: 1, success: 0, partial: 1, failed: 0 })
    assert.equal(paper.pdf.status, 'hash_mismatch')
    assert.equal(paper.note_needs_review, false)
    assert.equal(paper.evidence_quote_check.mismatched, 1)
    assert.ok(paper.inspection_warnings.includes('PDF_HASH_MISMATCH'))
    assert.ok(paper.inspection_warnings.includes('NOTE_NOT_NEEDS_REVIEW'))
    assert.ok(paper.inspection_warnings.includes('EVIDENCE_QUOTE_MISMATCH'))
  } finally { await rm(f.run, { recursive: true, force: true }); await rm(join(f.run, '..'), { recursive: true, force: true }) }
})

test('a missing saved batch cannot be reported as successfully inspected', async () => {
  const record = { status: 'complete', coverage: { page_count: 1, completed_pages: [1], full_document: true },
    batch_count: 1, draft_id: 'graph-draft', note_draft_id: 'note-draft' }
  const f = await fixture({ route: { name: 'route-a', status: 'complete', results: [{ id: 'paper-a', request_id: 'exact-run', status: 'complete' }] },
    analysis: async request => { if (request.batch_index === 0) throw new Error('missing batch'); return record } })
  try {
    assert.deepEqual(f.report.counts, { total: 1, success: 0, partial: 1, failed: 0 })
    assert.ok(f.report.papers[0].inspection_warnings.includes('LAST_BATCH_UNAVAILABLE'))
  } finally { await rm(join(f.run, '..'), { recursive: true, force: true }) }
})

test('questionnaire incompleteness is partial and missing completeness evidence stays unknown', async () => {
  const base = { questionnaire: { version: 'reading-questions-v1', hash: 'a'.repeat(64) },
    coverage: { page_count: 1, read_pages: [1], completed_pages: [1], full_document: true }, batch_count: 0, metadata: {} }
  const incomplete = await fixture({ route: { name: 'route-a', status: 'partial', results: [{ id: 'paper-a', request_id: 'exact-run', status: 'partial' }] },
    analysis: async () => ({ ...base, status: 'partial', analysis_complete: false,
      question_coverage: { question_ids: ['q1'], complete: false, by_question: { q1: { expected_batches: 1, answered_batches: 0, failed_batches: [0], unread_batches: [], valid_answers: 0 } } } }) })
  try {
    assert.equal(incomplete.report.papers[0].coverage_class, 'partial')
    assert.equal(incomplete.report.papers[0].question_status, 'partial')
    assert.equal(incomplete.report.papers[0].analysis_complete, false)
  } finally { await rm(join(incomplete.run, '..'), { recursive: true, force: true }) }

  const unknown = await fixture({ route: { name: 'route-a', status: 'complete', results: [{ id: 'paper-a', request_id: 'exact-run', status: 'complete' }] },
    analysis: async () => ({ ...base, status: 'complete' }) })
  try {
    assert.deepEqual(unknown.report.counts, { total: 1, success: 0, partial: 0, failed: 0, unknown: 1 })
    assert.equal(unknown.report.papers[0].question_status, 'unknown')
    assert.equal(unknown.report.papers[0].coverage_class, 'unknown')
  } finally { await rm(join(unknown.run, '..'), { recursive: true, force: true }) }
})
