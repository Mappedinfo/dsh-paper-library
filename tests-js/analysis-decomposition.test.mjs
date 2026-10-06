import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { replayOutput, splitPrompts, probeDecomposition } from '../scripts/probe-paper-analysis-decomposition.mjs'
import { validateAnalysisImages } from '../src/model-input-images.mjs'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0) }
  return (crc ^ 0xffffffff) >>> 0
}
function pngChunk(type, data) {
  const name = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([length, name, data, checksum])
}
const pngBytes = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),
  pngChunk('IHDR', Buffer.from([0,0,0,1,0,0,0,1,8,6,0,0,0])),
  pngChunk('IDAT', deflateSync(Buffer.from([0,255,255,255,255]))), pngChunk('IEND', Buffer.alloc(0))])
const pngData = pngBytes.toString('base64')

function syntheticPack(id = 'paper-a') {
  const source = { id: `source-${id}`, entity: { kind: 'paper', id }, kind: 'source-note',
    text: 'The method\n  supports a bounded claim.', locator: { page: 2 }, content_hash: 'synthetic-source-hash', verification: 'source-note' }
  const image = { mime_type: 'image/png', data: pngData, page: 2, width: 1, height: 1, sha256: sha256(pngBytes) }
  const pack = { paper: { id, pdf: true, title: 'Synthetic paper', modified: 'synthetic-revision' },
    expected_modified: 'synthetic-revision', file_version: { bytes: 1 }, sources: [source], source_ids: [source.id], images: [image],
    preprocessing: { representation: 'normalized-markdown', raw_verbatim: false },
    coverage: { read_pages: [2], completed_pages: [2], page_count: 4, full_document: false } }
  validateAnalysisImages(pack.images)
  return pack
}

function output(pack, { metadata = true, graph = true, invalidEdge = false } = {}) {
  const sourceId = pack.source_ids[0]
  const result = { title: '合成论文', body: '只基于第二页来源的阶段摘要。',
    nodes: graph ? [
      { id: 'evidence-method', type: 'evidence', label: '原文方法证据', source_id: sourceId, quote: 'The method supports' },
      { id: 'bounded-claim', type: 'claim', label: '原文支持一个有限主张' },
    ] : [],
    edges: graph && invalidEdge ? [{ subject: 'evidence:evidence-method', object: 'claim:bounded-claim', relation: 'uses', surface: 'synthetic invalid typed edge' }] : [],
    assertions: graph && !invalidEdge ? [{ subject: 'evidence:evidence-method', object: 'claim:bounded-claim', relation: 'supports', surface: '来源文字支持该有限主张' }] : [] }
  if (metadata) {
    result.metadata = { title: 'The Synthetic Method' }
    result.field_sources = { title: [{ source_id: sourceId, quote: 'The method' }] }
  }
  return result
}

test('replayOutput validates historical JSON and the real Python typed-graph schema without library writes', async () => {
  const pack = syntheticPack()
  const valid = await replayOutput(pack, output(pack))
  assert.equal(valid.passed, true, valid.error)
  assert.deepEqual(valid.quote_normalization, { method: 'unique-whitespace-match-v1', count: 1, metadata: 0, graph: 1 })
  assert.deepEqual(valid.graph, { nodes: 2, edges: 0, assertions: 1 })

  const invalid = await replayOutput(pack, output(pack, { invalidEdge: true }))
  assert.equal(invalid.passed, false)
  assert.match(invalid.error, /unsupported Edge endpoints\/relation/)
  assert.equal(pack.paper.title, 'Synthetic paper', 'replay only uses the synthetic pack and does not touch a managed library')
})

test('splitPrompts use the same selected source and page scope while assigning distinct tasks', () => {
  const pack = syntheticPack()
  const prompts = splitPrompts(pack)
  for (const prompt of [prompts.graph, prompts.metadata]) {
    assert.ok(prompt.includes(pack.source_ids[0]))
    assert.ok(prompt.includes('"page":2'))
    assert.ok(prompt.includes('PDF pages [2]'))
    assert.ok(prompt.includes('Markdown'))
  }
  assert.match(prompts.graph, /title, body, nodes, edges, assertions/)
  assert.match(prompts.graph, /Do not extract bibliographic metadata/)
  assert.doesNotMatch(prompts.graph, /field_sources\s*=/)
  assert.match(prompts.metadata, /ONLY missing bibliographic metadata/)
  assert.match(prompts.metadata, /Do not create a graph or paper summary/)
  assert.doesNotMatch(prompts.metadata, /Return.*nodes.*edges.*assertions/s)
  assert.match(prompts.graph, /exact saved source substring/)
  assert.match(prompts.metadata, /EXACT contiguous substring/)
})

async function probeFixture(t, { failMetadataFor, metadataComment = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'synthetic-analysis-decomposition-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const library = join(root, 'library'), out = join(root, 'probe')
  await mkdir(library)
  const ids = failMetadataFor ? ['paper-a', 'paper-b'] : ['paper-a']
  const plan = { library, request_id: 'synthetic-decomposition', mode: 'full', notes: false, review: false,
    input_format: 'markdown', include_images: true,
    routes: [{ name: 'glm-synthetic', config: join(root, 'model.json'), ids }] }
  const sent = []
  const options = {
    out,
    loadConfig: async () => ({ provider: 'glm', model: 'synthetic-model', keyEnv: 'SYNTHETIC_KEY', maxCalls: ids.length * 3, maxConcurrency: 1, maxOutputTokens: 8192 }),
    createAgent: async (config, { fetchImpl }) => {
      const { createDirectModelAgent } = await import('../src/direct-model.mjs')
      return createDirectModelAgent(config, { fetchImpl, env: { SYNTHETIC_KEY: 'synthetic-value' } })
    },
    createStore: () => {
      const rows = new Map()
      return { async get(key) { return structuredClone(rows.get(key) ?? { key, value: null, revision: 0 }) },
        async put(key, value, expected) { const revision = rows.get(key)?.revision ?? 0; assert.equal(expected, revision); const row = { key, value: structuredClone(value), revision: revision + 1 }; rows.set(key, row); return structuredClone(row) } }
    },
    dispatch: async request => {
      if (request.action !== 'paper_analysis_batch') throw new Error(`unexpected dispatch ${request.action}`)
      assert.equal(request.input_format, 'markdown'); assert.equal(request.include_images, true)
      return syntheticPack(request.id)
    },
    fetchImpl: async (_url, init) => {
      const payload = JSON.parse(init.body), blocks = Array.isArray(payload.messages[0].content) ? payload.messages[0].content : []
      const prompt = typeof payload.messages[0].content === 'string' ? payload.messages[0].content : blocks.find(block => block.type === 'text')?.text
      const imageUrls = blocks.filter(block => block.type === 'image_url').map(block => block.image_url.url)
      sent.push({ prompt, imageUrls })
      const id = prompt.match(/paper-(?:a|b)/)?.[0] || 'paper-a'
      let response
      if (prompt.includes('Do not extract bibliographic metadata')) response = output(syntheticPack(id), { metadata: false })
      else if (prompt.includes('ONLY missing bibliographic metadata')) {
        if (failMetadataFor === id) return new Response(JSON.stringify({ error: 'synthetic-stage-failure' }), { status: 503 })
        response = { metadata: { title: 'The Synthetic Method' }, field_sources: { title: [{ source_id: `source-${id}`, quote: 'The method' }] } }
        if (metadataComment) response.batch_note = 'Only the selected page was read.'
      } else response = output(syntheticPack(id))
      const content = JSON.stringify(response)
      return new Response(JSON.stringify({ model: 'synthetic-returned-model', choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }), { headers: { 'content-type': 'application/json' } })
    },
  }
  return { plan, options, sent, out }
}

test('probe runs one control and two split calls per paper with identical image inputs, then validates merged output', async t => {
  const f = await probeFixture(t)
  const result = await probeDecomposition(f.plan, f.options)
  assert.equal(result.protocol_execution, 'complete')
  assert.equal(result.model_calls, 3)
  assert.equal(result.cases, 1)
  assert.equal(result.control_passed, 1)
  assert.equal(result.split_passed, 1)
  assert.deepEqual(result.rows[0].control, { passed: true, error: null, protocol: 'legacy-monolithic-v1', validation_scope: 'historical-response-only; not full production workflow validation',
    quote_normalization: { method: 'unique-whitespace-match-v1', count: 1, metadata: 0, graph: 1 }, graph: { nodes: 2, edges: 0, assertions: 1 },
    validator: { ok: true, nodes: 2, edges: 0, assertions: 1 } })
  assert.equal(f.sent.length, 3)
  assert.deepEqual(f.sent.map(call => call.imageUrls), [0, 1, 1].map(() => [f.sent[1].imageUrls[0]]))
  assert.ok(f.sent[0].prompt.includes('Additionally return metadata'))
  assert.ok(f.sent[1].prompt.includes('Do not extract bibliographic metadata'))
  assert.ok(f.sent[2].prompt.includes('ONLY missing bibliographic metadata'))
  const caseRecord = JSON.parse(await readFile(join(f.out, 'case-paper-a.json'), 'utf8'))
  assert.equal(caseRecord.split_validation.passed, true)
})

test('extra metadata stage root comments are reported without inventing a stricter graph acceptance gate', async t => {
  const f = await probeFixture(t, { metadataComment: true })
  const result = await probeDecomposition(f.plan, f.options)
  assert.equal(result.split_passed, 1)
  const record = JSON.parse(await readFile(join(f.out, 'case-paper-a.json'), 'utf8'))
  assert.deepEqual(record.metadata_envelope_extra_keys, ['batch_note'])
  assert.equal(record.split_validation.passed, true)
})

test('probe execution completion does not turn an invalid or missing split stage into a pass', async t => {
  const f = await probeFixture(t, { failMetadataFor: 'paper-b' })
  const result = await probeDecomposition(f.plan, f.options)
  assert.equal(result.protocol_execution, 'complete')
  assert.equal(result.model_calls, 6)
  assert.equal(result.cases, 2)
  assert.equal(result.control_passed, 2)
  assert.equal(result.split_passed, 1)
  assert.equal(result.rows.find(row => row.id === 'paper-b').split.passed, false)
  const bad = JSON.parse(await readFile(join(f.out, 'case-paper-b.json'), 'utf8'))
  assert.equal(bad.stages.metadata.received, false)
  assert.equal(bad.split_validation, undefined)
  assert.equal(result.rows.find(row => row.id === 'paper-b').split.passed, false, 'a failed split call cannot count as a valid merged output')
})
