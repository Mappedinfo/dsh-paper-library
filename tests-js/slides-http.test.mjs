import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFetchHandler } from '../src/http.mjs'
import { assertSafeSlideStyles } from '../src/slides-safety.mjs'
import { createDeckTemplate } from '../lib/plaindeck-core.mjs'

test('slides use the authenticated HTTP prefix and preserve a draft on a stale save', async t => {
  const root = await mkdtemp(join(tmpdir(), 'paper-slides-http-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const handler = createFetchHandler({ library: join(root, 'library'), localStateHome: join(root, 'state'), basePath: '/api/paper-library' })
  const request = async input => {
    const response = await handler(new Request('http://localhost/api/paper-library/api', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost' }, body: JSON.stringify(input),
    }))
    return { status: response.status, ...await response.json() }
  }
  const empty = await request({ action: 'slides_list', limit: 50 })
  assert.equal(empty.ok, true); assert.deepEqual(empty.result.projects, [])
  const created = await request({ action: 'slides_create', title: 'Synthetic talk', template: 'paper-reading' })
  assert.equal(created.ok, true)
  const { project, document, revision } = created.result
  document.deck.title = 'Saved synthetic talk'
  const saved = await request({ action: 'slides_save', id: project.id, document, expected_revision: revision })
  assert.equal(saved.ok, true)
  const stale = structuredClone(document); stale.deck.title = 'Unsaved second window'
  const conflict = await request({ action: 'slides_save', id: project.id, document: stale, expected_revision: revision })
  assert.equal(conflict.status, 409); assert.equal(conflict.code, 'STATE_CONFLICT')
  assert.equal(conflict.current.revision, saved.result.revision)
  const loaded = await request({ action: 'slides_get', id: project.id })
  assert.equal(loaded.result.document.deck.title, 'Saved synthetic talk')
  assert.equal(stale.deck.title, 'Unsaved second window')
  const foreign = await handler(new Request('http://localhost/api/paper-library/api', { method: 'POST', headers: { origin: 'https://invalid.test' } }))
  assert.equal(foreign.status, 403)
  for (const name of ['slides.html', 'slides-editor.js', 'slides-editor.css']) {
    const response = await handler(new Request(`http://localhost/api/paper-library/${name}`))
    assert.equal(response.status, 200, name)
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
    assert.ok((await response.text()).length > 100)
    const head = await handler(new Request(`http://localhost/api/paper-library/${name}`, { method: 'HEAD' }))
    assert.equal(head.status, 200); assert.equal(await head.text(), '')
  }
})

test('all built-in templates use supported local paint and font values', () => {
  for (const name of ['blank', 'paper-reading', 'nature-methods', 'data-story', 'course-lecture', 'flowchart', 'pitch', 'showcase']) {
    assertSafeSlideStyles(createDeckTemplate(name, { lang: 'zh' }))
  }
})

test('style safety rejects remote requests and declaration injection without scanning prose', () => {
  const document = createDeckTemplate('blank', { lang: 'zh' })
  const slide = document.slides[document.deck.slides[0]]
  for (const value of ['url(https://invalid.test/image)', 'image-set("https://invalid.test/image")', 'red;background:url(https://invalid.test)', 'u\\72l(//invalid.test)', '</style>']) {
    const invalid = structuredClone(document); invalid.theme.colors.background = value
    assert.throws(() => assertSafeSlideStyles(invalid), /样式/)
  }
  document.theme.fonts.body = 'Noto Sans CJK SC, "Arial", sans-serif'
  const withFooter = structuredClone(document); withFooter.deck.footer = { color: 'red; background:url(https://invalid.test)' }
  assert.throws(() => assertSafeSlideStyles(withFooter), /样式/)
  slide.elements.push({ id: 'plain-prose', type: 'text', text: 'Discuss url() and CSS; keep the evidence.', frame: { x: 1, y: 1, w: 200, h: 80 } })
  assertSafeSlideStyles(document)
  slide.elements[0].fontFamily = 'Arial; src:url(https://invalid.test)'
  assert.throws(() => assertSafeSlideStyles(document), /样式/)
})

test('the distributed slide bundle omits browser persistence and PWA hooks', async () => {
  const bundle = await readFile(new URL('../lib/slides-editor.js', import.meta.url), 'utf8')
  for (const name of ['localStorage', 'indexedDB', 'navigator.storage', 'showDirectoryPicker', 'serviceWorker', 'sendBeacon']) assert.equal(bundle.includes(name), false, name)
})
