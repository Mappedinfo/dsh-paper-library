import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import { webcrypto } from 'node:crypto'

const source = await readFile(new URL('../web/latex-review.js', import.meta.url), 'utf8')
function fixture(api, options = {}) {
  const ids = new Map(), clicked = []
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.events = new Map(); this.value = ''; this.hidden = false; this.dataset = {}; this.classList = { toggle() {} } }
    set id(value) { this._id = value; ids.set(value, this) }
    set textContent(value) { this._text = value; this.children = [] } get textContent() { return this._text || this.children.map(n => n.textContent).join('') }
    append(...nodes) { this.children.push(...nodes) }
    setAttribute() {} focus() {}
    addEventListener(type, fn) { this.events.set(type, fn) }
    click() { clicked.push(this) }
  }
  const document = { createElement: tag => new Element(tag) }, window = {}
  vm.runInNewContext(source, { window, document, crypto: webcrypto, setTimeout, URL, Blob })
  const state = { id: 'project', main: 'main.tex', file: 'one.tex', revision: 'source-rev', dirty: false, editor: { value: '中文😀选段\nNext', selectionStart: 2, selectionEnd: 6 } }
  const ui = window.PaperLatexReview.create({ root: new Element('section'), api, context: () => state, revealSource() {}, revealPdf() {}, ...options })
  ids.get('latex-review-filter').value = 'open'
  return { ui, ids, state, clicked }
}

test('PDF export binds the active project generation including zero', async () => {
  const f = fixture(async () => ({}))
  f.state.binding_generation = 0
  f.ids.get('latex-review-export-pdf').events.get('click')()
  assert.equal(f.clicked[0].href, './latex-review-pdf/project?binding_generation=0')
  f.state.binding_generation = 8
  f.ids.get('latex-review-export-pdf').events.get('click')()
  assert.equal(f.clicked[1].href, './latex-review-pdf/project?binding_generation=8')
})

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

test('a unique high-confidence match restores navigation while keeping the saved anchor and version', async () => {
  const original = { kind: 'source', path: 'one.tex', line: 1, revision: 'old', start: 0, end: 30 }
  const current = { ...original, line: 7, revision: 'current', start: 100, end: 130 }
  const note = { id: 'source:a', version: 'saved-version', status: 'open', stale: true, anchor: original, text: 'Original sufficiently long quotation', comment: 'My original thought', relocation: { status: 'matched', anchor: current, method: 'fuzzy', score: .98 } }
  let revealed, changed
  const f = fixture(async () => ({ annotations: [note] }), { revealSource: anchor => { revealed = anchor }, changed: value => { changed = value } })
  await f.ui.refresh()
  const card = f.ids.get('latex-review-list').children[0]
  assert.equal(card.children[0].disabled, false)
  await card.children[0].events.get('click')()
  assert.deepEqual(revealed, current)
  assert.match(card.textContent, /自动匹配/); assert.match(card.textContent, /98%/); assert.match(card.textContent, /原始位置/)
  assert.equal(f.ui.annotations()[0].anchor, original); assert.equal(f.ui.annotations()[0].version, 'saved-version')
  assert.equal(changed.annotations[0], note)
  f.ids.get('latex-review-filter').value = 'stale'; f.ids.get('latex-review-filter').events.get('change')()
  assert.match(f.ids.get('latex-review-list').textContent, /暂无此类批注/)
})

test('ambiguous automatic matches keep the original locator disabled and explain the ambiguity', async () => {
  const note = { id: 'source:a', version: 'v1', status: 'open', stale: true, anchor: { kind: 'source', path: 'one.tex', line: 1 }, text: 'Repeated source quotation', comment: 'thought', relocation: { status: 'ambiguous', reason: 'ambiguous' } }
  const f = fixture(async () => ({ annotations: [note] }))
  await f.ui.refresh()
  const card = f.ids.get('latex-review-list').children[0]
  assert.equal(card.children[0].disabled, true); assert.match(card.textContent, /多个相近位置/)
  assert.equal(f.ui.annotations()[0].version, 'v1')
})

test('a matched PDF locator uses current page coordinates and still displays the original build', async () => {
  const original = { kind: 'pdf', pdf_version: 'old-pdf', page: 1, rects: [[1, 1, 10, 10]] }
  const current = { kind: 'pdf', pdf_version: 'current-pdf', page: 3, rects: [[20, 30, 120, 45]] }
  let revealed
  const f = fixture(async () => ({ annotations: [{ id: 'pdf:old:a', version: 'v1', status: 'open', stale: true, anchor: original, text: 'PDF quotation', comment: 'thought', relocation: { status: 'matched', method: 'normalized', score: 1, anchor: current } }] }), { revealPdf: anchor => { revealed = anchor } })
  await f.ui.refresh(); const card = f.ids.get('latex-review-list').children[0]
  await card.children[0].events.get('click')()
  assert.deepEqual(revealed, current); assert.match(card.textContent, /第 3 页/); assert.match(card.textContent, /old-pdf/)
  assert.equal(f.ui.annotations()[0].anchor, original)
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

const savedNote = () => ({ id: 'source:a', version: 'v1', status: 'open', stale: true, anchor: { kind: 'source', path: 'one.tex', line: 1, revision: 'old-source' }, text: 'Original source quotation', comment: 'Why this claim?' })

test('each saved annotation has four actions and stale notes can ask DSH with a frozen identity', async () => {
  const note = savedNote(); let release, received
  const f = fixture(async () => ({ annotations: [note] }), { onAsk: value => { received = value; return new Promise(done => { release = done }) }, onPropose: async () => true })
  await f.ui.refresh()
  const row = f.ids.get('latex-review-list').children[0].children.find(node => node.className === 'latex-review-actions latex-review-card-actions')
  assert.deepEqual(row.children.map(button => button.textContent), ['编辑', '解决', '问 DSH', '生成修改提案'])
  const pending = f.ui.testHooks.runNote('ask', note)
  assert.equal(received.id, 'source:a'); assert.equal(received.version, 'v1'); assert.equal(received.stale, true)
  received.comment = 'Changed callback copy'
  assert.equal(note.comment, 'Why this claim?')
  const busy = f.ids.get('latex-review-list').children[0].children.find(node => node.className === 'latex-review-actions latex-review-card-actions')
  assert.equal(busy.children.every(button => button.disabled), true)
  assert.equal(await f.ui.testHooks.runNote('propose', note), false)
  f.ui.testHooks.edit(note); assert.equal(f.ui.hasDraft(), false)
  release(true); assert.equal(await pending, true)
  assert.match(f.ids.get('latex-review-message').textContent, /回复已生成/)
})

test('DSH callback failures preserve the annotation and allow retry without touching its comment', async () => {
  const note = savedNote(); let fail = true
  const f = fixture(async () => ({ annotations: [note] }), { onAsk: async () => { if (fail) throw Error('Synthetic model failure'); return true } })
  await f.ui.refresh()
  assert.equal(await f.ui.testHooks.runNote('ask', note), false)
  assert.match(f.ids.get('latex-review-message').textContent, /Synthetic model failure/)
  assert.equal(f.ui.annotations()[0].comment, 'Why this claim?')
  fail = false; assert.equal(await f.ui.testHooks.runNote('ask', note), true)
})

test('collaboration replies attach only by exact note identity and label older annotation versions', async () => {
  const note = savedNote(), f = fixture(async () => ({ annotations: [note] }))
  await f.ui.refresh()
  const entries = [
    { kind: 'ask', review_note: { id: 'source:a', version: 'v0' }, answer: 'Earlier model answer', model: 'synthetic/light' },
    { kind: 'proposal', review_note: { id: 'source:a', version: 'v1' }, summary: 'A candidate revision', path: 'one.tex' },
    { kind: 'ask', review_note: { id: 'another-note', version: 'v1' }, answer: 'Must not appear' },
  ]
  assert.equal(f.ui.setCollaboration(entries, { id: 'another-project', main: 'main.tex' }), false)
  assert.equal(f.ui.setCollaboration(entries, { id: 'project', main: 'main.tex' }), true)
  const card = f.ids.get('latex-review-list').children[0]
  assert.match(card.textContent, /来自较早批注版本/)
  assert.match(card.textContent, /Earlier model answer/)
  assert.match(card.textContent, /确认后才会修改源码/)
  assert.equal(card.textContent.includes('Must not appear'), false)
  assert.equal(f.ui.annotations()[0].comment, note.comment)
  f.state.binding_generation = 1
  assert.equal(f.ui.setCollaboration(entries, { id: 'project', main: 'main.tex', binding_generation: 0 }), false)
})

test('freeform comments become source annotations and retain the original input on write failure', async () => {
  let failed = true, calls = []
  const f = fixture(async (action, args) => {
    calls.push({ action, ...args })
    if (action === 'latex_review_list') return { annotations: [] }
    if (failed) throw Error('Synthetic save failure')
    return { annotation: { id: 'saved-comment' } }
  })
  assert.equal(await f.ui.createSourceComment('  '), false)
  assert.equal(await f.ui.createSourceComment('x'.repeat(8001)), false)
  assert.equal(calls.length, 0)
  assert.equal(await f.ui.createSourceComment('A freeform thought'), false)
  assert.equal(f.ids.get('latex-review-comment').value, 'A freeform thought')
  assert.equal(f.ui.hasDraft(), true)
  assert.equal(calls[0].anchor.text, '😀选段')
  assert.equal(await f.ui.createSourceComment('Do not replace the draft'), false)
  assert.equal(f.ids.get('latex-review-comment').value, 'A freeform thought')
  failed = false
  const result = await f.ui.testHooks.saveDraft()
  assert.equal(result.id, 'saved-comment'); assert.equal(f.ui.hasDraft(), false)
  assert.equal(calls[0].request_id, calls[1].request_id)
})

test('unsaved source cannot become a source comment and late writes cannot clear another binding', async () => {
  let release, called = 0
  const f = fixture(async () => { called++; return new Promise(done => { release = done }) })
  f.state.dirty = true
  assert.equal(await f.ui.createSourceComment('Comment on dirty source'), false)
  assert.equal(called, 0)
  f.state.dirty = false
  const pending = f.ui.createSourceComment('Keep this text')
  f.state.binding_generation = 2
  release({ annotation: { id: 'old-binding-note' } })
  assert.equal(await pending, false)
  assert.equal(f.ids.get('latex-review-comment').value, 'Keep this text')
  assert.equal(f.ui.hasDraft(), true)
})
