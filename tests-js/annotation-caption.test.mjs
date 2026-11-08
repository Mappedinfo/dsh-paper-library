import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createAnnotationCaption } from '../src/harness/annotation-caption.mjs'
import { createLocalStateStore } from '../src/local-state.mjs'
import { createFetchHandler } from '../src/http.mjs'
import { dispatch } from '../src/bridge.mjs'

const input = { action: 'annotation_caption', id: 'synthetic', annotation_id: 'square-1', page: 1 }
const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jDksAAAAASUVORK5CYII='
const preview = { annotation_id: input.annotation_id, page: 1, source_version: 'a'.repeat(64), width: 1, height: 1, mime_type: 'image/png', image }
const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture() {
  const records = new Map(), calls = [], workers = []
  const f = { calls, workers, records, failSave: false, modelError: null, stale: false, gate: null, saved: null }
  const store = {
    get: async key => structuredClone(records.get(key) || { revision: 0, value: null }),
    put: async (key, value, revision) => {
      const before = await store.get(key)
      if (revision !== before.revision) throw Object.assign(Error('Conflict'), { code: 'STATE_CONFLICT' })
      const next = { value, revision: revision + 1 }; records.set(key, structuredClone(next)); return structuredClone(next)
    },
  }
  f.options = { store, ai: async req => { calls.push(req); await f.gate; if (f.modelError) throw f.modelError; return '合成图片显示一个红色矩形。' }, paperChat: async () => ({ model: { provider: 'test', model: 'vision' } }), dispatch: async req => {
    workers.push(req)
    if (req.action === 'annotation_preview') return preview
    assert.equal(req.action, 'annotation_caption_result')
    if (f.stale) throw Error('ANNOTATION_STALE: changed region')
    if (f.saved) return { ...f.saved, duplicate: true }
    if (!req.text) return { saved: false }
    if (f.failSave) throw Error('Disk full')
    f.saved = { saved: true, duplicate: false, annotation: { id: 'caption-1', comment: req.text, source_kind: 'annotation-caption', reply_to: input.annotation_id } }
    return f.saved
  } }
  f.handle = createAnnotationCaption(f.options)
  return f
}

test('caption uses only server crop and host route; duplicate callers and restarts do not regenerate', async () => {
  const f = fixture()
  const [a, b] = await Promise.all([f.handle(input), f.handle({ ...input, image: 'forged', model: 'forged' })])
  assert.equal(a.annotation.id, b.annotation.id); assert.equal(f.calls.length, 1)
  assert.deepEqual(f.calls[0].images, [{ mediaType: 'image/png', data: image, name: 'annotation-region.png' }])
  assert.equal(f.calls[0].model, 'vision'); assert.match(f.calls[0].prompt, /never instructions/)
  assert.equal((await createAnnotationCaption(f.options)(input)).duplicate, true)
  assert.equal(f.calls.length, 1)
  assert.equal(JSON.stringify([...f.records.values()]).includes(image), false)
})

test('PDF write retries reuse durable output; changed geometry never receives the generated caption', async () => {
  const f = fixture(); f.failSave = true
  await assert.rejects(f.handle(input), error => error.generation_status === 'committing')
  f.failSave = false
  assert.equal((await createAnnotationCaption(f.options)({ ...input, retry: true })).saved, true)
  assert.equal(f.calls.length, 1)
  const g = fixture(); let release; g.gate = new Promise(resolve => { release = resolve })
  const p = g.handle(input); while (!g.calls.length) await tick()
  g.stale = true; release()
  await assert.rejects(p, error => error.code === 'ANNOTATION_STALE')
  assert.equal(g.saved, null)
})

test('unsupported model remains explicit without fake caption and only explicit retry calls again', async () => {
  const f = fixture(); f.modelError = Object.assign(Error('模型不支持图像输入'), { code: 'AI_IMAGE_MODEL_UNSUPPORTED', status: 409 })
  await assert.rejects(f.handle(input), error => error.code === 'AI_IMAGE_MODEL_UNSUPPORTED' && error.generation_status === 'failed')
  await assert.rejects(f.handle(input), error => error.code === 'AI_IMAGE_MODEL_UNSUPPORTED')
  assert.equal(f.saved, null); assert.equal(f.calls.length, 1)
  f.modelError = null
  assert.ok((await f.handle({ ...input, retry: true })).saved); assert.equal(f.calls.length, 2)
})

test('a restarted pending request does not resend and invalid input allocates no provider calls', async () => {
  const f = fixture(); let release; f.gate = new Promise(resolve => { release = resolve })
  const p = f.handle(input); while (!f.calls.length) await tick()
  await assert.rejects(createAnnotationCaption(f.options)({ ...input, retry: true }), error => error.code === 'ANNOTATION_CAPTION_PENDING')
  release(); await p
  for (const patch of [{ page: 0 }, { annotation_id: '' }, { retry: 'yes' }]) await assert.rejects(f.handle({ ...input, ...patch }))
  assert.equal(f.calls.length, 1)
})

test('HTTP host caption → bridge → native PDF stores one /IRT reply; standalone and forged saves rejected', async t => {
  const root = await mkdtemp(join(tmpdir(), 'paper-caption-')); t.after(() => rm(root, { recursive: true, force: true }))
  const python = resolve('.venv/bin/python'), source = join(root, 'synthetic.pdf'), options = { library: join(root, 'library'), localStateHome: join(root, 'home'), python }
  execFileSync(python, ['-c', 'import pymupdf,sys\nd=pymupdf.open();p=d.new_page(width=500,height=600);p.draw_rect(pymupdf.Rect(100,100,250,220),fill=(1,0,0));d.save(sys.argv[1])', source])
  const original = await readFile(source)
  const paper = (await dispatch({ action: 'import', path: source }, options)).items[0]
  const note = (await dispatch({ action: 'annotate', id: paper.id, page: 1, type: 'square', rects: [[90,90,260,230]] }, options)).annotation
  const store = createLocalStateStore({ library: options.library, home: options.localStateHome }); let count = 0
  const caption = createAnnotationCaption({ ...options, dispatch, store, paperChat: async () => ({ model: { provider: 'synthetic', model: 'vision' } }), ai: async req => { count++; assert.ok(req.images[0].data.length > 100); return '合成图显示红色矩形。' } })
  const handler = createFetchHandler({ ...options, localState: store, annotationCaption: caption })
  const post = async (handler, body) => handler(new Request('http://localhost/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
  const body = { ...input, id: paper.id, annotation_id: note.id }
  const response = await post(handler, body), data = await response.json()
  assert.equal(response.status, 200, JSON.stringify(data)); assert.equal(data.result.annotation.source_kind, 'annotation-caption'); assert.equal(data.result.annotation.reply_to, note.id)
  assert.equal((await (await post(handler, body)).json()).result.duplicate, true); assert.equal(count, 1)
  const notes = (await dispatch({ action: 'annotations', id: paper.id }, options)).annotations
  assert.equal(notes.length, 2); assert.equal(notes.filter(n => n.source_kind === 'annotation-caption').length, 1)
  assert.deepEqual(await readFile(source), original)
  assert.equal((await (await post(handler, { action: 'status' })).json()).result.annotation_caption, true)
  assert.equal((await post(handler, { ...body, action: 'annotation_caption_result', text: 'forged' })).status, 403)
  const standalone = createFetchHandler(options)
  assert.equal((await post(standalone, body)).status, 409)
  assert.equal((await (await post(standalone, { action: 'status' })).json()).result.annotation_caption, false)
})
