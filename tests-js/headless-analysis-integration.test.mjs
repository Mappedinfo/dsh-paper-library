import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHeadlessAnalysis } from '../src/headless-analysis.mjs'
import { createFetchHandler } from '../src/http.mjs'
import { dispatch } from '../src/bridge.mjs'
import { loadQuestionnaire, questionGroups } from '../src/reading-questions.mjs'

const questionnaire = loadQuestionnaire()
const questionIds = questionnaire.questions.map(question => question.id)
const groups = questionGroups(questionnaire)
const callsPerBatch = groups.length

const run = promisify(execFile)
const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex')

test('large first answer batch still produces a note with late-batch evidence through the real Python source binder', { timeout: 120000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'paper-note-budget-integration-'))
  const library = join(root, 'library'), localStateHome = join(root, 'state'), python = resolve('.venv/bin/python')
  let analysis
  try {
    const fixture = await run('uv', ['run', '--offline', '--no-project', '--python', python, 'python', '-B', '-c', `
import json, sys
from pathlib import Path
import pymupdf as fitz
from dsh_paper_library.core import Library
root = Path(sys.argv[1])
original = root / 'synthetic-reading-methods.pdf'
with fitz.open() as doc:
    for number in range(1, 97):
        page = doc.new_page()
        page.insert_text((40, 60), f'Synthetic reading methods exercise. Exact page {number} evidence.')
    doc.save(original)
library = Library(root / 'library')
paper = library.create({'title': 'Synthetic reading methods exercise'})
paper = library.attach(paper['id'], str(original))
print(json.dumps({'id': paper['id'], 'original': str(original), 'managed': str(library.pdf_path(paper['id']))}))
library.close()
`, root], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: resolve('src') }, maxBuffer: 1024 * 1024 })
    const paper = JSON.parse(fixture.stdout), before = await Promise.all([paper.original, paper.managed].map(digest))
    let calls = 0, noteInput
    const questionCalls = []
    const agent = async input => {
      calls++
      const context = input.analysisContext
      if (context.question_ids) {
        questionCalls.push(context.question_ids)
        const page = context.pages[0]
        return JSON.stringify({ answers: context.question_ids.flatMap(question_id => Array.from({ length: 6 }, (_, index) => ({
          question_id, choice: 'other', judgment: `合成学习方法判断 ${question_id}/${index}。` + '有限范围的阅读方法说明。'.repeat(100),
          evidence: [{ source_id: context.source_ids[0], quote: `Synthetic reading methods exercise. Exact page ${page} evidence.` }],
        }))) })
      }
      assert.equal(context.stage, 'note')
      noteInput = input
      return JSON.stringify({ title: '合成学习方法笔记', body: '## 一句话概括\n仅汇总保留的合成摘录。\n## 待核实与未覆盖\n细节压缩和图谱省略需逐批审阅。' })
    }
    agent.model = { provider: 'synthetic', model: 'deterministic' }
    // 合成测试明确配置所需上限；生产默认预算不随题数自动提高。
    const expectedCalls = 12 * callsPerBatch + 1
    analysis = await createHeadlessAnalysis({ library, python, localStateHome, agent,
      modelConfig: { provider: 'glm', model: 'deterministic', keyEnv: 'SYNTHETIC_TEST_KEY', maxCalls: expectedCalls } })
    const input = { action: 'paper_analysis_run', ids: [paper.id], request_id: 'synthetic-long-note', notes: true, review: false }
    const result = await analysis(input), row = result.results[0]
    assert.ok(row.note_draft_id, `note missing: ${(row.warnings ?? []).join('; ')}`)
    assert.equal(calls, expectedCalls, 'twelve batches of separate calls plus one note; no extra model summarization')
    assert.deepEqual(questionCalls, Array.from({ length: 12 }, () => groups).flat())
    const saved = await analysis({ action: 'paper_analysis_get', id: paper.id, request_id: row.request_id, batch_index: 0 })
    assert.ok(Buffer.byteLength(JSON.stringify(saved.batch_answers)) > 24000, 'reproduces the old first-batch packing rejection')
    assert.equal(saved.note_coverage.batches, 12)
    assert.equal(saved.note_coverage.partial, true, 'all batch cards participating must not imply uncompressed full coverage')
    assert.ok(saved.note_coverage.packing.material_bytes <= 24000, 'the final model material remains inside its original byte budget')
    assert.deepEqual(saved.note_coverage.packing.batch_indices, Array.from({ length: 12 }, (_, index) => index + 1))
    assert.ok(noteInput.analysisContext.pages.includes(1) && noteInput.analysisContext.pages.includes(96))
    const note = await dispatch({ action: 'knowledge_draft_get', id: row.note_draft_id }, { library, python })
    const sources = await Promise.all(note.source_ids.map(id => dispatch({ action: 'knowledge_source_get', id }, { library, python })))
    assert.ok(sources.length <= 40 && sources.length >= 12)
    assert.ok(sources.some(source => source.locator.page <= 8) && sources.some(source => source.locator.page >= 89))
    assert.ok(sources.every(source => source.pdf_snapshot?.kind === 'selected-source-excerpt'))
    assert.ok(sources.reduce((sum, source) => sum + [...source.text].length, 0) <= 24000)
    for (const source of [sources[0], sources.at(-1)]) {
      const parent = await dispatch({ action: 'knowledge_source_get', id: source.pdf_snapshot.parent_source_id }, { library, python })
      assert.equal(source.pdf_snapshot.parent_content_hash, parent.content_hash)
      assert.equal(parent.text.slice(source.pdf_snapshot.parent_character_start, source.pdf_snapshot.parent_character_end), source.text)
    }
    assert.deepEqual(await Promise.all([paper.original, paper.managed].map(digest)), before)
    await analysis(input)
    assert.equal(calls, expectedCalls, 'reading persisted partial results never replays model calls')
  } finally {
    analysis?.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('headless batches read synthetic PDFs through the real worker and share question records with HTTP and CLI', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'paper-headless-integration-'))
  const library = join(root, 'library'), localStateHome = join(root, 'state')
  const python = resolve('.venv/bin/python')
  let analysis, observer
  try {
    // 本地合成学习练习；不读取真实文献，不调用外部 API。
    const fixture = await run('uv', ['run', '--offline', '--no-project', '--python', python, 'python', '-B', '-c', `
import json, sys
from pathlib import Path
import pymupdf as fitz
from dsh_paper_library.core import Library
root = Path(sys.argv[1])
library = Library(root / 'library')
items = []
for count in (13, 3):
    original = root / f'reading-{count}.pdf'
    with fitz.open() as doc:
        for index in range(count):
            page = doc.new_page()
            page.insert_text((40, 60), f'Reading methods exercise {count}. Published 2024. Page {index + 1}.')
        doc.save(original)
    item = library.create({'title': f'Reading methods exercise {count}'})
    item = library.attach(item['id'], str(original))
    items.append({'id': item['id'], 'original': str(original), 'managed': str(library.pdf_path(item['id']))})
library.close()
print(json.dumps(items))
`, root], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: resolve('src') }, maxBuffer: 1024 * 1024 })
    const papers = JSON.parse(fixture.stdout)
    const files = papers.flatMap(paper => [paper.original, paper.managed])
    const before = await Promise.all(files.map(digest))
    let calls = 0
    const seen = [], questionCalls = []
    const agent = async ({ prompt, analysisContext }) => {
      calls++
      if (analysisContext?.question_ids) {
        questionCalls.push(analysisContext.question_ids)
        seen.push(analysisContext.pages)
        return JSON.stringify({ answers: analysisContext.question_ids.map(question_id => ({ question_id, choice: 'not_reported' })) })
      }
      const metadataOnly = prompt.startsWith('Extract ONLY')
      const sourcePack = prompt.match(/LIBRARY_KNOWLEDGE_JSON:\n(\{[\s\S]*?\})\nAdditionally return/)?.[1]
      if (metadataOnly && sourcePack) seen.push(JSON.parse(sourcePack).sources.map(source => source.locator.page))
      return JSON.stringify({ title: '阅读方法练习草稿', body: '合成学习练习的待核对记录。',
        nodes: [], edges: [], assertions: [], ...(metadataOnly ? { metadata: { issued: { 'date-parts': [[2024]] } },
          field_sources: { issued: [{ source_id: analysisContext.source_ids[0], quote: 'Published 2024' }] } } : {}),
      })
    }
    agent.model = { provider: 'synthetic', model: 'deterministic' }
    analysis = await createHeadlessAnalysis({ library, python, localStateHome, agent })
    const input = { action: 'paper_analysis_run', ids: papers.map(paper => paper.id), request_id: 'learning-full', notes: false }
    const batch = await analysis(input)
    assert.equal(batch.status, 'complete', JSON.stringify(batch))
    assert.equal(calls, 3 * callsPerBatch, 'each of three page batches runs each selected question separately')
    assert.deepEqual(questionCalls, [...groups, ...groups, ...groups])
    assert.deepEqual([...new Map(seen.map(pages => [JSON.stringify(pages), pages])).values()], [[1,2,3,4,5,6,7,8], [9,10,11,12,13], [1,2,3]])
    assert.equal(batch.results.length, 2)
    for (const result of batch.results) {
      assert.equal(result.coverage.full_document, true)
      const record = await analysis({ action: 'paper_analysis_get', id: result.id, request_id: result.request_id })
      assert.equal(record.draft.status, 'needs-review')
      assert.equal(record.draft.origin, 'llm')
      assert.equal(record.question_coverage.complete, true)
      assert.equal(record.question_summary.valid_answers, questionIds.length * (result.id === papers[0].id ? 2 : 1))
      assert.equal(record.batch_answers.length, questionIds.length, 'the job view exposes the latest batch answers; cumulative counts remain in question_summary')
      assert.equal(record.metadata.issued, undefined, 'full reading questions do not run the separate metadata extractor')
      assert.equal((await dispatch({ action: 'get', id: result.id }, { library, python })).issued, undefined)
    }
    assert.equal((await analysis(input)).status, 'complete')
    assert.equal(calls, 3 * callsPerBatch, 'same request reuses persisted results')

    const metadata = await analysis({ action: 'paper_analysis_run', ids: [papers[0].id], request_id: 'learning-metadata', mode: 'metadata' })
    assert.equal(metadata.status, 'complete', JSON.stringify(metadata))
    assert.equal(calls, 3 * callsPerBatch + 1)
    assert.deepEqual(seen.at(-1), [1], 'metadata extraction defaults to the first page only')
    assert.equal(metadata.results[0].coverage.full_document, false)
    assert.deepEqual(await Promise.all(files.map(digest)), before, 'analysis never rewrites PDFs')

    observer = await createHeadlessAnalysis({ library, python, localStateHome })
    const selected = batch.results[0]
    const get = { action: 'paper_analysis_get', id: selected.id, request_id: selected.request_id }
    assert.equal((await observer(get)).status, 'complete', 'reading saved jobs needs no key')
    const http = createFetchHandler({ library, python, localStateHome })
    const response = await http(new Request('http://localhost/api', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(get),
    }))
    const body = await response.json()
    assert.equal(body.ok, true, JSON.stringify(body))
    assert.equal(body.result.draft.id, selected.draft_id, 'standalone UI can read the same draft')

    const cli = await new Promise((accept, reject) => {
      const child = spawn(process.execPath, ['src/cli.mjs', '--library', library, '--state-home', localStateHome, '--python', python], {
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = '', stderr = ''
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
      child.on('error', reject)
      child.on('close', code => accept({ code, stdout, stderr }))
      child.stdin.end(JSON.stringify(get))
    })
    assert.equal(cli.code, 0, cli.stderr + cli.stdout)
    assert.equal(JSON.parse(cli.stdout).result.draft.id, selected.draft_id)

    const applied = await observer({ action: 'paper_analysis_apply', id: papers[0].id, request_id: metadata.results[0].request_id })
    assert.ok(applied.metadata_result.applied_fields.includes('issued'))
    assert.equal((await dispatch({ action: 'get', id: papers[0].id }, { library, python })).issued['date-parts'][0][0], 2024)
    assert.equal(await digest(papers[0].original), before[0], 'explicit writeback preserves the imported original')
  } finally {
    analysis?.dispose(); observer?.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
