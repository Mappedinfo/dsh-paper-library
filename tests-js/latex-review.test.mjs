import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import { webcrypto } from 'node:crypto'

const source = await readFile(new URL('../web/latex-review.js', import.meta.url), 'utf8')
function fixture(api) {
  const ids = new Map()
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.events = new Map(); this.value = ''; this.hidden = false; this.dataset = {}; this.classList = { toggle() {} } }
    set id(value) { this._id = value; ids.set(value, this) }
    set textContent(value) { this._text = value; this.children = [] } get textContent() { return this._text || this.children.map(n => n.textContent).join('') }
    append(...nodes) { this.children.push(...nodes) }
    setAttribute() {} focus() {}
    addEventListener(type, fn) { this.events.set(type, fn) }
  }
  const document = { createElement: tag => new Element(tag) }, window = {}
  vm.runInNewContext(source, { window, document, crypto: webcrypto, setTimeout, URL, Blob })
  const state = { id: 'project', main: 'main.tex', file: 'one.tex', revision: 'source-rev', dirty: false, editor: { value: '中文😀选段\nNext', selectionStart: 2, selectionEnd: 6 } }
  const ui = window.PaperLatexReview.create({ root: new Element('section'), api, context: () => state, revealSource() {}, revealPdf() {} })
  ids.get('latex-review-filter').value = 'open'
  return { ui, ids, state }
}

test('source selection uses codepoint offsets and a failed save preserves exact draft/request identity', async () => {
  let failed = true; const calls = []
  const f = fixture(async (action, args) => {
    calls.push({ action, ...args })
    if (action === 'latex_review_list') return { annotations: [] }
    if (failed) throw new Error('offline')
    return { saved: true }
  })
  f.ui.beginSource(); f.ids.get('latex-review-comment').value = '我的想法'
  await f.ui.testHooks.saveDraft()
  assert.equal(f.ui.hasDraft(), true)
  assert.equal(f.ids.get('latex-review-comment').value, '我的想法')
  assert.match(f.ids.get('latex-review-message').textContent, /未保存/)
  const request = calls[0]
  assert.equal(request.anchor.start, 2); assert.equal(request.anchor.end, 5); assert.equal(request.anchor.text, '😀选段')
  failed = false; await f.ui.testHooks.saveDraft()
  assert.equal(calls[1].request_id, request.request_id)
  assert.equal(f.ui.hasDraft(), false)
})

test('editing uses note CAS and conflict never clears user text', async () => {
  let payload
  const f = fixture(async (_action, args) => { payload = args; throw new Error('STATE_CONFLICT') })
  f.ui.testHooks.edit({ id: 'source:a', version: 'v1', status: 'open', anchor: { kind: 'source', path: 'one.tex', line: 1 }, text: 'quote', comment: 'old' })
  f.ids.get('latex-review-comment').value = 'new thought'
  await f.ui.testHooks.saveDraft()
  assert.equal(payload.note_id, 'source:a'); assert.equal(payload.expected_version, 'v1'); assert.equal(payload.anchor, undefined)
  assert.equal(f.ids.get('latex-review-comment').value, 'new thought'); assert.equal(f.ui.hasDraft(), true)
})

test('late list responses cannot cross main/draft', async () => {
  let release
  const old = new Promise(done => { release = done })
  const f = fixture(async () => old)
  const pending = f.ui.refresh(); f.state.main = 'draft.tex'
  release({ annotations: [{ id: 'old', status: 'open', stale: true }] }); await pending
  assert.equal(f.ui.testHooks.notes().length, 0)
})

test('a stale note displays a disabled locator and remains editable', async () => {
  const f = fixture(async () => ({ annotations: [{ id: 'source:a', version: 'v1', status: 'open', stale: true, anchor: { kind: 'source', path: 'one.tex', line: 1 }, text: 'old quote', comment: 'thought' }] }))
  await f.ui.refresh()
  const card = f.ids.get('latex-review-list').children[0]
  assert.equal(card.children[0].disabled, true)
  assert.match(card.textContent, /待重定位/)
  f.ui.testHooks.edit(f.ui.testHooks.notes()[0])
  assert.equal(f.ids.get('latex-review-comment').value, 'thought')
})

test('PDF markup saves without a comment and preserves the selection on failure', async () => {
  const calls = []; let failed = true
  const f = fixture(async (action, args) => {
    calls.push({ action, ...args })
    if (action === 'latex_review_list') return { annotations: [] }
    if (failed) throw new Error('offline')
    return { saved: true }
  })
  const anchor = { kind: 'pdf', page: 1, pdf_version: 'test-version', rects: [[1, 1, 10, 10]], text: '选中的文字' }
  f.ui.beginPdf(anchor, 'underline', { instant: true })
  await new Promise(done => setImmediate(done))
  assert.equal(calls[0].type, 'underline'); assert.equal(calls[0].comment, '')
  assert.equal(f.ui.hasDraft(), true)
  assert.equal(f.ids.get('latex-review-quote').textContent, '选中的文字')
  failed = false; await f.ui.testHooks.saveDraft()
  assert.equal(calls[1].request_id, calls[0].request_id)
  assert.equal(f.ui.hasDraft(), false)
})
