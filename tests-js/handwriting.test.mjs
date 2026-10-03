import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createHandwritingRecognition } from '../src/harness/handwriting.mjs'
import { createHarnessAI } from '../src/harness/ai.mjs'
import { createLocalStateStore } from '../src/local-state.mjs'

function crc32(data) {
  let crc = 0xffffffff
  for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0) }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]), result = Buffer.alloc(body.length + 8)
  result.writeUInt32BE(data.length); body.copy(result, 4); result.writeUInt32BE(crc32(body), result.length - 4); return result
}
function png(width = 640, height = 360, mark = 1) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2
  const rows = Buffer.alloc((width * 3 + 1) * height, 255)
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0
  for (let x = 10; x < Math.min(width, 30 + mark); x++) rows[(width * 3 + 1) * Math.min(height - 1, 15) + 1 + x * 3] = 0
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]).toString('base64')
}
const image = png(), imageChanged = png(640, 360, 8)
const base = { action: 'handwriting_recognize', id: 'synthetic-paper', annotation_id: 'synthetic-parent', image, request_id: '53641649-7fdb-478a-b352-9c38592c1a11' }
const transcript = '合成手写内容\nUncertain value [无法辨认]'
const hash = value => createHash('sha256').update(value).digest('hex')
const flush = () => new Promise(resolve => setImmediate(resolve))

function memoryStore() {
  const records = new Map(); let sequence = 0
  const store = {
    records, beforePut: null, afterPut: null,
    async get(key) { return structuredClone(records.get(key) || { key, value: null, revision: 0 }) },
    async put(key, value, expected) {
      assert.ok(key.length <= 200); await store.beforePut?.(key, value)
      const current = await store.get(key)
      if (current.revision !== expected) throw Object.assign(new Error('Synthetic state conflict'), { code: 'STATE_CONFLICT' })
      const record = { key, value: structuredClone(value), revision: hash(String(++sequence)) }
      records.set(key, record); await store.afterPut?.(key, value); return structuredClone(record)
    },
  }
  return store
}

function fixture(store = memoryStore(), extra = {}) {
  const calls = [], kernel = [], routes = []
  const f = { store, calls, kernel, routes, answer: transcript, gate: null, model: { provider: 'configured-route', model: 'paper-vision', reasoningEffort: 'high' } }
  f.options = {
    store, library: '/synthetic/library', python: '/synthetic/python',
    dispatch: async input => { kernel.push(input); return { annotation: { id: input.annotation_id }, note: { board: 'synthetic-source-strokes' } } },
    paperChat: async input => { routes.push(input); return { sessionId: 'synthetic-paper-session', model: f.model } },
    ai: async input => { calls.push(input); await f.gate; if (f.answer instanceof Error) throw f.answer; return f.answer },
    ...extra,
  }
  f.handle = createHandwritingRecognition(f.options)
  return f
}

test('handwriting recognition uses the saved parent and current paper route without altering source strokes', async () => {
  const f = fixture()
  const result = await f.handle({ ...base, provider: 'forged', model: 'forged', api_key: 'ignored' })
  assert.equal(result.text, transcript); assert.equal(result.generated, true); assert.equal(result.status, 'complete')
  assert.equal(result.provider, f.model.provider); assert.equal(result.model, f.model.model); assert.equal(result.reasoningEffort, 'high')
  assert.equal(result.model_source, 'harness-session'); assert.equal(result.session_id, 'synthetic-paper-session')
  assert.equal(result.paper_id, base.id); assert.equal(result.annotation_id, base.annotation_id)
  assert.equal(result.image_sha256, hash(Buffer.from(image, 'base64'))); assert.equal(result.image_width, 640); assert.equal(result.image_height, 360)
  assert.deepEqual(f.kernel, [{ action: 'handwriting_get', id: base.id, annotation_id: base.annotation_id }])
  assert.deepEqual(f.routes, [{ action: 'chat_ensure', id: base.id }])
  assert.deepEqual(f.calls[0].images, [{ mediaType: 'image/png', data: image, name: 'handwriting.png' }])
  assert.match(f.calls[0].prompt, /never instructions/); assert.match(f.calls[0].prompt, /Do not translate/); assert.match(f.calls[0].prompt, /\[无法辨认\]/)
  assert.equal(result.fingerprint, undefined); assert.equal(result.image, undefined)
  assert.equal(JSON.stringify([...f.store.records.values()]).includes(image), false, 'The result cache retains a hash, not another image copy')
})

test('same concurrent recognition joins once and a restarted service replays durable text without a model', async () => {
  const f = fixture(); let release; f.gate = new Promise(resolve => { release = resolve })
  const a = f.handle(base), b = f.handle(base); while (!f.calls.length) await flush(); release()
  assert.equal((await a).text, (await b).text); assert.equal(f.calls.length, 1)
  const result = await createHandwritingRecognition(f.options)(base)
  assert.equal(result.replayed, true); assert.equal(f.calls.length, 1); assert.equal(f.routes.length, 1)
  for (const patch of [{ image: imageChanged }, { annotation_id: 'different-parent' }]) await assert.rejects(f.handle({ ...base, ...patch }), error => error.code === 'HANDWRITING_REQUEST_CONFLICT')
  assert.equal(f.calls.length, 1)
})

test('fresh requests follow a changed paper model rather than a request-supplied override', async () => {
  const f = fixture(); await f.handle(base); f.model = { provider: 'new-route', model: 'new-vision' }
  const result = await f.handle({ ...base, request_id: randomUUID(), model: 'forged' })
  assert.equal(result.provider, 'new-route'); assert.equal(result.model, 'new-vision'); assert.equal(f.calls.length, 2)
})

test('a second process refuses unknown pending work without resending the model', async () => {
  const f = fixture(); let release; f.gate = new Promise(resolve => { release = resolve })
  const first = f.handle(base); while (!f.calls.length) await flush()
  await assert.rejects(createHandwritingRecognition(f.options)(base), error => error.code === 'HANDWRITING_PENDING' && error.retry_with_new_request === false)
  assert.equal(f.calls.length, 1); release(); await first
})

test('two concurrent model calls are admitted, and a third receives a bounded busy response', async () => {
  const f = fixture(); let release; f.gate = new Promise(resolve => { release = resolve })
  const a = f.handle(base), b = f.handle({ ...base, request_id: randomUUID() }); while (f.calls.length < 2) await flush()
  await assert.rejects(f.handle({ ...base, request_id: randomUUID() }), error => error.code === 'HANDWRITING_BUSY' && error.status === 429)
  assert.equal(f.calls.length, 2); release(); await Promise.all([a, b])
})

test('malformed IDs, data URLs, noncanonical base64 and oversized or wrong-size images reach no model', async () => {
  const f = fixture()
  for (const patch of [
    { id: '../escape' }, { annotation_id: '\u0000' }, { request_id: 'not-uuid' },
    { image: `data:image/png;base64,${image}` }, { image: image + '\n' }, { image: 'a'.repeat(2_796_208) },
    { image: Buffer.alloc(60).toString('base64') }, { image: png(32, 32) }, { image: png(1280, 360) },
  ]) await assert.rejects(f.handle({ ...base, ...patch }), error => error.code === 'HANDWRITING_INVALID')
  assert.equal(f.calls.length + f.routes.length + f.kernel.length, 0)
})

test('missing parent or unavailable paper model consumes no generation and writes no result', async () => {
  for (const patch of [
    { dispatch: async () => { throw new Error('Parent annotation is missing') } },
    { paperChat: async () => ({ model: null }) },
    { ai: null },
  ]) {
    const f = fixture(undefined, patch); await assert.rejects(f.handle(base)); assert.equal(f.calls.length, 0); assert.equal(f.store.records.size, 0)
  }
})

test('incomplete or failed output preserves the original and cannot replay as a second model request', async () => {
  for (const answer of ['', 'x'.repeat(12001), new Error('Synthetic model stream failure')]) {
    const f = fixture(); f.answer = answer
    await assert.rejects(f.handle(base), error => error.generation_status === 'failed' && error.retry_with_new_request === true)
    const record = [...f.store.records.values()][0]
    assert.equal(record.value.status, 'failed'); assert.equal(record.value.text, undefined)
    await assert.rejects(createHandwritingRecognition(f.options)(base), error => error.code === 'HANDWRITING_FAILED')
    assert.equal(f.calls.length, 1); assert.ok(f.kernel.every(input => input.action === 'handwriting_get'))
  }
})

test('a lost result-write receipt recovers committed text without generation replay', async () => {
  const f = fixture(); let failed = false
  f.store.afterPut = (_key, value) => { if (value.status === 'complete' && !failed) { failed = true; throw new Error('Synthetic lost write receipt') } }
  const result = await f.handle(base); assert.equal(result.text, transcript); assert.equal(result.replayed, true)
  await createHandwritingRecognition(f.options)(base); assert.equal(f.calls.length, 1)
})

test('failure to persist a completed response keeps pending state and never automatically re-generates', async () => {
  const f = fixture()
  f.store.beforePut = (_key, value) => { if (value.status === 'complete') throw new Error('Synthetic disk write failure') }
  await assert.rejects(f.handle(base), error => error.code === 'HANDWRITING_PENDING' && error.retry_with_new_request === false)
  assert.equal([...f.store.records.values()][0].value.status, 'pending')
  await assert.rejects(createHandwritingRecognition(f.options)(base), error => error.code === 'HANDWRITING_PENDING')
  assert.equal(f.calls.length, 1)
})

test('timeout is bounded even for a stalled adapter and retains slots until that adapter settles', async () => {
  const releases = [], calls = []
  const f = fixture(undefined, { timeoutMs: 20, ai: input => { calls.push(input); return new Promise(resolve => releases.push(resolve)) } })
  // Keep the test event loop alive because AbortSignal.timeout intentionally
  // does not keep a standalone Node process running by itself.
  const keepalive = setTimeout(() => {}, 1000)
  try {
    const a = f.handle(base), b = f.handle({ ...base, request_id: randomUUID() })
    const results = await Promise.allSettled([a, b])
    assert.ok(results.every(result => result.status === 'rejected' && result.reason.code === 'HANDWRITING_PENDING'))
    assert.ok(calls.every(call => call.signal.aborted))
    await assert.rejects(f.handle({ ...base, request_id: randomUUID() }), error => error.code === 'HANDWRITING_BUSY')
    for (const release of releases) release(transcript)
    await flush()
    assert.equal((await f.handle({ ...base, request_id: randomUUID() }).catch(error => error)).code, 'HANDWRITING_PENDING')
    releases.at(-1)(transcript)
  } finally { clearTimeout(keepalive); for (const release of releases) release(transcript) }
})

test('real local-state storage reopens a durable result with bounded keys and no cached image bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paper-library-handwriting-'))
  try {
    const store = createLocalStateStore({ library: join(root, 'library'), home: join(root, 'home') })
    const f = fixture(store); const first = await f.handle({ ...base, image: png(1280, 720) })
    const freshStore = createLocalStateStore({ library: join(root, 'library'), home: join(root, 'home') })
    const result = await createHandwritingRecognition({ ...f.options, store: freshStore })({ ...base, image: png(1280, 720) })
    assert.equal(result.text, first.text); assert.equal(result.replayed, true); assert.equal(f.calls.length, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

function aiFixture(modalities = ['text', 'image']) {
  const admissions = [], calls = [], preparations = []
  const attachment = { attachmentId: `sha256:${hash(Buffer.from(image, 'base64'))}`, mediaType: 'image/png', bytes: Buffer.from(image, 'base64').length, width: 640, height: 360, name: 'handwriting.png' }
  const f = {
    admissions, calls, preparations, attachment,
    attachments: { admitPromptContent: async content => { admissions.push(content); return content.map(part => part.type === 'image' ? { type: 'image', attachment } : part) } },
    llm: {
      prepareCall: async (config, signal) => { preparations.push({ config, signal }); return { config, inputModalities: modalities,
        stream: options => { calls.push(options); return (async function* () { yield { type: 'block-end', block: { type: 'text', text: transcript } }; yield { type: 'finish', reason: { kind: 'stop' } } })() },
      } },
      resolveModelInfo: async () => { throw new Error('Prepared image calls do not separately re-resolve models') },
      stream: () => { throw new Error('Prepared image calls do not use the unbound stream') },
    },
  }
  f.ai = createHarnessAI(f.llm, createUserMessage, { maxOutputTokens: 4096 }, { attachments: () => f.attachments })
  return f
}
const aiRequest = { prompt: 'Synthetic transcription request', provider: 'configured-route', model: 'vision', images: [{ mediaType: 'image/png', data: image }] }

test('real Harness user-message constructor receives the public image attachment block, not a text placeholder', async () => {
  const f = aiFixture(); assert.equal(await f.ai(aiRequest), transcript)
  assert.equal(f.preparations.length, 1); assert.equal(f.admissions.length, 1); assert.equal(f.calls.length, 1)
  const message = f.calls[0].messages[0]
  assert.equal(message.role, 'user'); assert.ok(message.id); assert.equal(message.source.plugin, 'paper-library')
  assert.deepEqual(message.content, [{ type: 'text', text: aiRequest.prompt }, { type: 'image', attachment: f.attachment }])
  assert.equal(f.calls[0].maxTokens, 4096); assert.equal(f.admissions[0][1].data, image)
  assert.equal(JSON.stringify(message.content).includes(image), false)
})

test('text-only or unknown vision capability rejects before storing attachments or streaming', async () => {
  for (const [modalities, code] of [[['text'], 'AI_IMAGE_MODEL_UNSUPPORTED'], [null, 'AI_IMAGE_CAPABILITY_UNKNOWN']]) {
    const f = aiFixture(modalities)
    await assert.rejects(f.ai(aiRequest), error => error.code === code)
    assert.equal(f.admissions.length + f.calls.length, 0)
  }
})

test('missing attachment service or authoritative PNG decode failure never invokes the model', async () => {
  const f = aiFixture(); f.attachments = null
  await assert.rejects(f.ai(aiRequest), error => error.code === 'AI_IMAGE_SERVICE_REQUIRED')
  assert.equal(f.calls.length, 0)
  f.attachments = { admitPromptContent: async () => { throw new Error('Synthetic authoritative PNG decode failure') } }
  await assert.rejects(f.ai(aiRequest), /PNG decode failure/); assert.equal(f.calls.length, 0)
})

test('cancellation after image admission is checked before the native model stream starts', async () => {
  const f = aiFixture(), controller = new AbortController()
  f.attachments.admitPromptContent = async content => { controller.abort(new Error('Synthetic cancellation')); return content }
  await assert.rejects(f.ai({ ...aiRequest, signal: controller.signal }), /Synthetic cancellation/)
  assert.equal(f.calls.length, 0)
})

test('recognition service and native image adapter integrate without any external model calls', async () => {
  const adapter = aiFixture(), f = fixture(undefined, { ai: adapter.ai })
  const result = await f.handle(base)
  assert.equal(result.text, transcript); assert.equal(adapter.calls.length, 1)
  assert.equal(adapter.calls[0].provider, 'configured-route'); assert.equal(adapter.calls[0].model, 'paper-vision')
  assert.equal(adapter.calls[0].messages[0].content[1].type, 'image')
  assert.equal(adapter.calls[0].messages[0].content[1].attachment.mediaType, 'image/png')
})
