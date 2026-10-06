import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createPaperAnalysis } from '../src/harness/paper-analysis.mjs'
import { createDirectModelAgent } from '../src/direct-model.mjs'
import { runAnalysisBatch } from '../scripts/run-paper-analysis-batch.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
function pngChunk(type, data) {
  const bytes = Buffer.concat([Buffer.from(type), data]), length = Buffer.alloc(4), checksum = Buffer.alloc(4)
  let crc = 0xffffffff
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0) }
  length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  return Buffer.concat([length, bytes, checksum])
}
function syntheticImage(page) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6
  const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(Buffer.alloc(5))), pngChunk('IEND', Buffer.alloc(0))])
  return { mime_type: 'image/png', data: bytes.toString('base64'), sha256: hash(bytes), width: 1, height: 1, page }
}

function memoryStore() {
  const records = new Map()
  return { async get(key) { return structuredClone(records.get(key) ?? { key, value: null, revision: 0 }) },
    async put(key, value, expected) {
      assert.equal(expected, records.get(key)?.revision ?? 0)
      const record = { key, value: structuredClone(value), revision: expected + 1 }
      records.set(key, record); return structuredClone(record)
    } }
}

test('notes and reviews keep missing scan-only batches in coverage and preserve derived boundaries', async () => {
  const paper = { id: 'synthetic-paper', pdf: true, title: 'Synthetic reading exercise', modified: 'revision-a' }
  const sources = [1, 5].map(page => ({ id: `source-${page}`, entity: { kind: 'paper', id: paper.id },
    text: 'Synthetic international finding.', locator: { page }, content_hash: hash('Synthetic international finding.') }))
  const pagesByBatch = [[1, 2], [3, 4], [5]], drafts = new Map(), calls = []
  let next = 0
  const agent = async request => {
    calls.push(request)
    if (request.analysisContext.stage === 'note') return JSON.stringify({ title: '合成精读笔记', body: '合成的来源说明，等待核对。' })
    if (request.analysisContext.stage === 'review') return JSON.stringify({ title: '证据图谱评审：合成练习',
      body: ['快速判定', '案例拆解', '状态矩阵', '归因', '联合覆盖', '形容词', '本文最多能声称', '本文不能声称', '修改清单'].join('\n') })
    return JSON.stringify({answers:request.analysisContext.question_ids.map(question_id=>({question_id,choice:'other',judgment:'合成批次中的词语',evidence:[{source_id:'S1',quote:'international'}]}))})
  }
  agent.supportsImages = true
  const handle = createPaperAnalysis({ store: memoryStore(), library: '/synthetic/library', agent,
    resolveModel: async () => ({ provider: 'synthetic', model: 'synthetic-vision' }),
    dispatch: async input => {
      if (input.action === 'get') return paper
      if (input.action === 'paper_analysis_batch') {
        const pages = pagesByBatch[next++], selected = sources.filter(source => pages.includes(source.locator.page))
        const scans = pages.filter(page => ![1, 5].includes(page))
        return { paper, expected_modified: paper.modified, file_version: 'synthetic-file-version', sources: selected,
          source_ids: selected.map(source => source.id), images: pages.map(syntheticImage),
          next_cursor: next < pagesByBatch.length ? { index: next * 2, offset: 0 } : null,
          preprocessing: { representation: 'normalized-markdown', raw_verbatim: false, derived: true, ocr: false },
          visual_coverage: { rendered_pages: pages, omitted_pages: [], full_document: false, ocr: false },
          coverage: { requested_pages: [1, 2, 3, 4, 5], read_pages: pages, completed_pages: pages, blank_pages: [],
            no_extractable_text_pages: scans, image_only_pages: scans, truncated_pages: [], omitted_pages: [], page_count: 5,
            full_document: false, characters: selected.reduce((total, source) => total + source.text.length, 0) } }
      }
      if (input.action === 'knowledge_draft_put') {
        const draft = { ...structuredClone(input), id: `draft-${drafts.size}`, status: 'needs-review' }
        drafts.set(draft.id, draft); return structuredClone(draft)
      }
      if (input.action === 'knowledge_draft_get') return structuredClone(drafts.get(input.id))
      if (input.action === 'knowledge_source_get') return structuredClone(sources.find(source => source.id === input.id))
      throw new Error(`Unexpected synthetic action: ${input.action}`)
    } })
  try {
    await handle({ action: 'paper_analysis_start', id: paper.id, request_id: 'scan-gap', input_format: 'markdown',
      include_images: true, notes: true, review: true, apply_metadata: false })
    await handle.wait(paper.id, 'scan-gap')
    const record = await handle({ action: 'paper_analysis_get', id: paper.id, request_id: 'scan-gap' })
    assert.equal(record.status, 'partial', JSON.stringify(record))
    assert.equal(record.batch_count, 3)
    assert.equal(record.coverage.full_document, false)
    for (const stage of ['note', 'review']) {
      const generated = calls.find(call => call.analysisContext.stage === stage)
      assert.ok(generated)
      const material = JSON.parse(generated.prompt.split('READING_RECORDS_JSON:\n')[1].split('\nEND_OF_READING_RECORDS')[0])
      assert.ok(material.batches.every(batch => batch.source_representation === 'normalized-markdown' && batch.raw_pdf_verbatim === false))
      assert.ok(material.batches.every(batch => batch.visual_observations_require_review === true))
      assert.equal(record[`${stage}_coverage`].batches_total, record.batch_count, 'a scanned batch without a draft still belongs to the requested scope')
      assert.equal(record[`${stage}_coverage`].partial, true)
      assert.doesNotMatch(generated.prompt, /All reading batches are covered\./)
      assert.match(generated.prompt, /"no_extractable_text_pages":\[2,3,4\]/)
      assert.equal(Object.hasOwn(generated, 'images'), false, 'derived notes must not silently resend page images')
    }
  } finally { handle.dispose() }
})

test('batch receipts omit uploaded image bytes echoed in a provider error', async t => {
  const root = await mkdtemp(join(tmpdir(), 'paper-image-audit-')), library = join(root, 'library'), out = join(root, 'output')
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(library)
  const image = syntheticImage(1)
  const plan = { library, request_id: 'synthetic-image-audit', mode: 'full', notes: false, review: false,
    input_format: 'markdown', include_images: true, routes: [{ name: 'glm', config: join(root, 'unused-config.json'), ids: ['synthetic-paper'] }] }
  const result = await runAnalysisBatch(plan, { out,
    loadConfig: async () => ({ provider: 'glm', model: 'synthetic-model', keyEnv: 'SYNTHETIC_AUDIT_KEY', maxCalls: 1 }),
    createStore: memoryStore,
    createAgent: (config, options) => createDirectModelAgent(config, { ...options, env: { SYNTHETIC_AUDIT_KEY: 'SYNTHETIC_ONLY_UNUSED_CREDENTIAL' } }),
    createAnalysis: async options => {
      const handle = async input => {
        await assert.rejects(options.agent({ prompt: 'Synthetic page only.', images: [image],
          analysisContext: { id: 'synthetic-paper', request_id: input.request_id, stage: 'batch', batch_index: 0, source_ids: ['source-1'], pages: [1] } }),
        { code: 'DIRECT_MODEL_HTTP_ERROR' })
        return { status: 'failed', results: [{ id: 'synthetic-paper', status: 'failed', warnings: [] }] }
      }
      handle.dispose = () => {}; return handle
    },
    fetchImpl: async (_url, init) => new Response(JSON.stringify({ error: { type: 'synthetic-validation-error', request: JSON.parse(init.body),
      echoed_base64: image.data, nested: JSON.stringify({ data: image.data }) } }), { status: 400 }) })
  assert.equal(result.status, 'failed')
  const manifest = JSON.parse(await readFile(join(out, 'run-manifest.json'), 'utf8'))
  assert.equal(manifest.input_format, 'markdown')
  assert.equal(manifest.include_images, true)
  const receipt = JSON.parse(await readFile(join(out, 'responses', '000001-glm.json'), 'utf8'))
  assert.equal(receipt.image_inputs[0].sha256, image.sha256)
  assert.equal(receipt.image_inputs[0].bytes, Buffer.byteLength(image.data, 'base64'))
  assert.equal(receipt.input_sha256, hash(JSON.stringify({ prompt_sha256: hash('Synthetic page only.'), images: receipt.image_inputs })))
  assert.equal(receipt.response_body.includes(image.data), false, 'response echo must not repersist raw uploaded image bytes')
  assert.equal(receipt.response_body.includes('data:image/png;base64,'), false)
})
