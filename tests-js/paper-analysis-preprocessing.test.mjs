import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHeadlessAnalysis } from '../src/headless-analysis.mjs'
import { createPaperAnalysis } from '../src/harness/paper-analysis.mjs'
import { createPaperAnalysisAgent } from '../src/harness/paper-analysis-agent.mjs'
import { dispatch } from '../src/bridge.mjs'

const run = promisify(execFile)
const hash = value => createHash('sha256').update(value).digest('hex')
const fileHash = async path => hash(await readFile(path))

async function fixture(t, kinds = ['text', 'text', 'text']) {
  const root = await mkdtemp(join(tmpdir(), 'paper-preprocessing-integration-'))
  const library = join(root, 'library'), localStateHome = join(root, 'state')
  const python = resolve('.venv/bin/python'), calls = [], kernel = []
  let analysis
  t.after(async () => { analysis?.dispose(); await rm(root, { recursive: true, force: true }) })
  // 只有本次生成的练习文本、几何图像和批注；不打开私人文献或调用模型网络。
  const result = await run('uv', ['run', '--offline', '--no-project', '--python', python, 'python', '-B', '-c', `
import json, sys
from pathlib import Path
import pymupdf as fitz
from dsh_paper_library.core import Library
root = Path(sys.argv[1])
original = root / 'synthetic-learning.pdf'
with fitz.open() as doc:
    for index, kind in enumerate(json.loads(sys.argv[2])):
        page = doc.new_page(width=600, height=800)
        if kind == 'text':
            page.insert_text((40, 60), f'Learning methods exercise. Published 2024. Page {index + 1}.', fontsize=12)
            page.insert_text((40, 100), 'Synthetic inter-\\nnational reading finding.', fontsize=12)
            page.insert_text((40, 140), 'The method is reading.', fontsize=12)
            page.add_freetext_annot(fitz.Rect(40, 700, 550, 740), 'SYNTHETIC ANNOTATION EXCLUDED', fontsize=10)
        else:
            pixels = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 40, 40), False)
            pixels.clear_with(128)
            page.insert_image(fitz.Rect(0, 0, 600, 800), pixmap=pixels)
    doc.save(original)
library = Library(root / 'library')
try:
    item = library.create({'title': 'Synthetic learning layout exercise'})
    item = library.attach(item['id'], str(original))
    print(json.dumps({'id': item['id'], 'original': str(original), 'managed': str(library.pdf_path(item['id']))}))
finally:
    library.close()
`, root, JSON.stringify(kinds)], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: resolve('src') }, maxBuffer: 1024 * 1024 })
  const paper = JSON.parse(result.stdout)
  const before = await Promise.all([paper.original, paper.managed].map(fileHash))
  const agent = async request => {
    const sourceId = request.analysisContext.source_ids[0]
    const source = await dispatch({ action: 'knowledge_source_get', id: sourceId }, { library, python })
    calls.push({ ...request, sources: [{ id: source.id, text: source.text, locator: source.locator }] })
    const answers = request.analysisContext.question_ids.map(question_id => question_id === 'q1'
      ? { question_id, choice: 'method', judgment: '本练习明确将 reading 作为方法。', evidence: [{ source_id: 'S1', quote: 'The method is reading.' }] }
      : { question_id, choice: 'not_reported' })
    return JSON.stringify({ answers })
  }
  agent.model = { provider: 'synthetic', model: 'deterministic-vision' }
  agent.supportsImages = true
  analysis = await createHeadlessAnalysis({ library, python, localStateHome, agent,
    dispatch: async (input, options) => { kernel.push(structuredClone(input)); return dispatch(input, options) } })
  return { root, library, localStateHome, python, paper, before, calls, kernel, analysis,
    input: { action: 'paper_analysis_run', ids: [paper.id], request_id: 'synthetic-run', notes: false },
    get: (requestId, batch_index) => analysis({ action: 'paper_analysis_get', id: paper.id, request_id: requestId, ...(batch_index === undefined ? {} : { batch_index }) }) }
}

async function filesBelow(root) {
  const files = []
  for (const item of await readdir(root, { withFileTypes: true })) {
    const path = join(root, item.name)
    if (item.isDirectory()) files.push(...await filesBelow(path))
    else if (item.isFile()) files.push(path)
  }
  return files
}

test('real worker sends bounded Markdown page images and saves traceable sources without base64', { timeout: 60000 }, async t => {
  const f = await fixture(t)
  const result = await f.analysis({ ...f.input, input_format: 'markdown', include_images: true })
  assert.equal(result.status, 'complete', JSON.stringify(result))
  assert.equal(f.calls.length, 6)
  assert.deepEqual([...new Map(f.calls.map(call => [call.analysisContext.batch_index, call.analysisContext.pages])).values()], [[1, 2], [3]])
  assert.deepEqual([...new Map(f.calls.map(call => [call.analysisContext.batch_index, call.images.map(image => image.page)])).values()], [[1, 2], [3]])
  const requestId = result.results[0].request_id
  const record = await f.get(requestId)
  assert.equal(record.coverage.full_document, true)
  assert.equal(record.input_format, 'markdown')
  assert.equal(record.include_images, true)
  assert.deepEqual(record.visual_coverage.rendered_pages, [1, 2, 3])
  assert.equal(record.visual_coverage.full_document, false, 'rendering all pages is not proof of complete visual understanding')
  const imageData = []
  for (const [index, call] of f.calls.entries()) {
    assert.ok(call.images.length >= 1 && call.images.length <= 2)
    assert.match(call.prompt, /派生 Markdown 的引文只能称为提取文本/)
    assert.match(call.prompt, /图片可以帮助理解版式和图表/)
    assert.doesNotMatch(call.prompt, /SYNTHETIC ANNOTATION EXCLUDED|data:image\/|file:\/\//)
    let total = 0
    for (const image of call.images) {
      const bytes = Buffer.from(image.data, 'base64')
      imageData.push(image.data)
      assert.equal(image.mime_type, 'image/png')
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
      assert.equal(hash(bytes), image.sha256)
      assert.ok(bytes.length <= 1024 * 1024)
      assert.ok(Math.max(image.width, image.height) <= 1600)
      assert.equal(image.width, bytes.readUInt32BE(16))
      assert.equal(image.height, bytes.readUInt32BE(20))
      assert.equal(call.prompt.includes(image.data), false)
      total += bytes.length
    }
    assert.ok(total <= 2 * 1024 * 1024)
    if (index && f.calls[index - 1].analysisContext.batch_index === call.analysisContext.batch_index) continue
    const batch = await f.get(requestId, call.analysisContext.batch_index)
    assert.equal(batch.batch_preprocessing.raw_verbatim, false)
    assert.equal(batch.batch_preprocessing.derived, true)
    assert.equal(batch.batch_preprocessing.ocr, false)
    assert.deepEqual(batch.batch_visual_coverage.rendered_pages, call.analysisContext.pages)
    assert.deepEqual(batch.batch_image_inputs.map(image => image.page), call.images.map(image => image.page))
    assert.ok(batch.batch_image_inputs.every(image => !Object.hasOwn(image, 'data')))
    for (const sourceInfo of call.sources) {
      const source = await dispatch({ action: 'knowledge_source_get', id: sourceInfo.id }, f)
      assert.equal(source.locator.page, sourceInfo.locator.page)
      assert.equal(source.content_hash, hash(source.text))
      assert.equal(source.pdf_snapshot.derived, true)
      assert.equal(source.pdf_snapshot.raw_verbatim, false)
      assert.equal(source.pdf_snapshot.exact_quote_basis, 'saved-source-text')
      const raw = await readFile(join(f.library, source.pdf_snapshot.cache_files.raw_text), 'utf8')
      const markdown = await readFile(join(f.library, source.pdf_snapshot.cache_files.markdown), 'utf8')
      assert.equal(hash(raw), source.pdf_snapshot.raw_text_sha256)
      assert.equal(hash(markdown), source.pdf_snapshot.markdown_sha256)
      assert.match(raw, /inter-\nnational/)
      assert.match(markdown, /international/)
      assert.doesNotMatch(raw + markdown, /SYNTHETIC ANNOTATION EXCLUDED/)
      assert.ok(markdown.includes(source.text))
    }
    const quote = batch.draft.nodes.find(node => node.type === 'evidence')
    assert.equal(quote.quote, 'The method is reading.', 'derived quotes are validated against the saved Markdown')
    assert.ok(call.sources.find(source => source.id === quote.source_id).text.includes(quote.quote))
  }
  // 检查本次临时目录的真实落盘状态与目录数据库；PNG 缓存保留二进制本体。
  const saved = (await filesBelow(f.root)).filter(path => !/\.(pdf|png)$/.test(path))
  assert.ok(saved.some(path => path.includes('analysis.batch')))
  for (const path of saved) {
    const bytes = await readFile(path)
    for (const data of imageData) assert.equal(bytes.includes(Buffer.from(data)), false, 'saved analysis must not contain image base64')
    assert.equal(bytes.includes(Buffer.from('data:image/')), false)
  }
  assert.deepEqual(await Promise.all([f.paper.original, f.paper.managed].map(fileHash)), f.before)
})

test('default text analysis keeps its batch shape and request identity while opt-in changes conflict', { timeout: 60000 }, async t => {
  const f = await fixture(t)
  const result = await f.analysis(f.input)
  assert.equal(result.status, 'complete', JSON.stringify(result))
  assert.equal(f.calls.length, 3)
  assert.deepEqual([...new Set(f.calls.map(call => JSON.stringify(call.analysisContext.pages)))].map(value => JSON.parse(value)), [[1, 2, 3]])
  assert.equal(Object.hasOwn(f.calls[0], 'images'), false)
  assert.equal(f.kernel.find(call => call.action === 'paper_analysis_batch').input_format, undefined)
  const record = await f.get(result.results[0].request_id)
  assert.equal(record.input_format, 'text')
  assert.equal(record.include_images, false)
  assert.equal(record.preprocessing, undefined)
  assert.equal(record.visual_coverage, undefined)
  assert.equal((await f.analysis({ ...f.input, input_format: 'text', include_images: false })).reused, true)
  const child = { action: 'paper_analysis_start', id: f.paper.id, request_id: result.results[0].request_id, notes: false }
  assert.equal((await f.analysis({ ...child, input_format: 'text', include_images: false })).status, 'complete')
  for (const options of [{ input_format: 'markdown' }, { include_images: true }]) {
    await assert.rejects(f.analysis({ ...f.input, ...options }), { code: 'ANALYSIS_CONFLICT' })
    await assert.rejects(f.analysis({ ...child, ...options }), { code: 'ANALYSIS_CONFLICT' })
  }
  assert.equal(f.calls.length, 3)
  assert.equal(f.kernel.filter(call => call.action === 'paper_analysis_batch').length, 1)
  assert.deepEqual(await Promise.all([f.paper.original, f.paper.managed].map(fileHash)), f.before)
})

test('scanned pages keep visual coverage separate and never claim full text coverage', { timeout: 60000 }, async t => {
  const f = await fixture(t, ['text', 'scan', 'text'])
  const result = await f.analysis({ ...f.input, input_format: 'markdown', include_images: true })
  assert.equal(result.status, 'partial', JSON.stringify(result))
  const record = await f.get(result.results[0].request_id)
  assert.equal(record.coverage.full_document, false)
  assert.deepEqual(record.coverage.no_extractable_text_pages, [2])
  assert.deepEqual(record.coverage.image_only_pages, [2])
  assert.deepEqual(record.coverage.blank_pages, [])
  assert.deepEqual(record.visual_coverage.rendered_pages, [1, 2, 3])
  assert.equal(record.visual_coverage.ocr, false)
  assert.equal(record.question_coverage.complete, true, 'all selected reading questions were answered on batches containing text')
  assert.equal(record.coverage.selected_scope_complete, false, 'the scan page has no textual evidence')
  const batches = [...new Map(f.calls.map(call => [call.analysisContext.batch_index, call])).values()]
  assert.deepEqual(batches[0].images.map(image => image.page), [1, 2])
  assert.deepEqual(batches[0].sources.map(source => source.locator.page), [1])
  assert.deepEqual(batches[1].sources.map(source => source.locator.page), [3])
  assert.deepEqual(await Promise.all([f.paper.original, f.paper.managed].map(fileHash)), f.before)
})

test('an entirely scanned PDF records its missing text and does not fabricate a model draft', { timeout: 60000 }, async t => {
  const f = await fixture(t, ['scan'])
  const result = await f.analysis({ ...f.input, input_format: 'markdown', include_images: true })
  assert.equal(result.status, 'failed')
  assert.equal(f.calls.length, 0)
  const record = await f.get(result.results[0].request_id)
  assert.equal(record.status, 'failed')
  assert.match(record.error, /OCR/)
  assert.equal(record.coverage.full_document, false)
  assert.deepEqual(record.coverage.image_only_pages, [1])
  assert.deepEqual(record.coverage.no_extractable_text_pages, [1])
  assert.equal(record.draft_id, null)
  assert.equal(f.kernel.some(call => call.action === 'knowledge_draft_put'), false)
  assert.deepEqual(await Promise.all([f.paper.original, f.paper.managed].map(fileHash)), f.before)
})

test('the native engine and an undeclared headless adapter reject image mode before any worker access', async () => {
  let accesses = 0, writes = 0, models = 0
  const agent = createPaperAnalysisAgent({ get() { models++; throw new Error('Native host must remain untouched') } }, { cwd: '/synthetic/library' })
  const store = { async get(key) { return { key, value: null, revision: 0 } }, async put() { writes++; throw new Error('No job may be persisted') } }
  const kernel = async () => { accesses++; throw new Error('No PDF may be read') }
  const input = { action: 'paper_analysis_start', id: 'synthetic-paper', request_id: 'unsupported-images', input_format: 'markdown', include_images: true }
  const native = createPaperAnalysis({ store, dispatch: kernel, agent, library: '/synthetic/library' })
  try { await assert.rejects(native(input), { code: 'PAPER_ANALYSIS_IMAGES_UNSUPPORTED' }) }
  finally { native.dispose() }
  const undeclared = async () => { models++; throw new Error('Undeclared vision adapter must remain untouched') }
  undeclared.model = { provider: 'synthetic', model: 'unspecified-modality' }
  const headless = await createHeadlessAnalysis({ store, dispatch: kernel, agent: undeclared, library: '/synthetic/library' })
  try { await assert.rejects(headless(input), { code: 'PAPER_ANALYSIS_IMAGES_UNSUPPORTED' }) }
  finally { headless.dispose() }
  assert.equal(accesses, 0)
  assert.equal(writes, 0)
  assert.equal(models, 0)
})
