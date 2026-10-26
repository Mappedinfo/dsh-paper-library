/** The shipped panel under a small DOM: deterministic races and failure recovery. */
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../web/latex-workspace.js', import.meta.url), 'utf8')
const tick = () => new Promise(done => setImmediate(done))
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const image = { image: 'aW1hZ2U=', width: 600, height: 800, pixel_width: 1200, pixel_height: 1600, page_count: 4, bytes: 5, supported: true }

async function fixture(override = () => undefined) {
  const ids = new Map(), revoked = [], calls = [], urls = [], timers = new Map()
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase(); this.children = []; this.events = new Map(); this.attributes = {}; this.dataset = {}; this.value = ''; this.hidden = false; this.clientWidth = 600; this.clientHeight = 600
      this.style = { setProperty(key, value) { this[key] = value } }
      const classes = new Set(); this.classList = { add: (...v) => v.forEach(x => classes.add(x)), remove: (...v) => v.forEach(x => classes.delete(x)), toggle(x, on) { if (on === undefined) on = !classes.has(x); on ? classes.add(x) : classes.delete(x); return on }, contains: x => classes.has(x) }
    }
    set id(value) { this._id = value; ids.set(value, this) } get id() { return this._id }
    set textContent(value) { this._text = value; this.children = [] } get textContent() { return this._text || this.children.map(x => x.textContent).join('') }
    append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node) } }
    setAttribute(key, value) { this.attributes[key] = String(value) } getAttribute(key) { return this.attributes[key] }
    addEventListener(key, value) { if (!this.events.has(key)) this.events.set(key, []); this.events.get(key).push(value) }
    removeEventListener() {}
    async dispatch(key, args = {}) { await Promise.all((this.events.get(key) || []).map(fn => fn({ target: this, preventDefault() {}, ...args }))) }
    querySelectorAll(selector) { const matches = node => selector === 'button[data-path]' ? node.tagName === 'BUTTON' && node.dataset.path : selector.startsWith('.') ? node.className?.split(' ').includes(selector.slice(1)) : node.tagName.toLowerCase() === selector; return this.children.flatMap(node => [...(matches(node) ? [node] : []), ...node.querySelectorAll(selector)]) }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
    get selectedOptions() { return this.children.filter(node => node.value === this.value) }
    focus() {} setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b }
    getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight } }
  }
  const body = new Element('body'), window = new Element('window'); window.devicePixelRatio = 2
  const document = { body, createElement: tag => new Element(tag), getElementById: id => ids.get(id), querySelector: () => null }
  const api = async (action, args, options) => {
    calls.push({ action, ...args, signal: options?.signal })
    const response = override(action, args, options); if (response !== undefined) return await response
    if (action === 'settings_get') return { value: { latex_auto_compile: false }, revision: '1' }
    if (action === 'latex_ws_status') return { root: '/synthetic', sync: {} }
    if (action === 'latex_project_list') return { projects: ['one', 'two'].map(id => ({ id, title: id, main_path: 'main.tex', pdf_present: true })) }
    if (action === 'latex_tree') return { files: ['main.tex', 'draft.tex', 'a.tex', 'b.tex'].map(path => ({ path, kind: 'text' })) }
    if (action === 'latex_outline') return { events: [{ kind: 'heading', path: 'a.tex', line: 2, title: '第一章', level: 2 }], entries: ['main.tex', 'draft.tex'], unreferenced: [], entry_scan_complete: true }
    if (action === 'latex_read') return { path: args.path, content: `${args.path}\nsecond line`, revision: 'revision', bytes: 10, lines: 2 }
    if (action === 'latex_pdf_pages') return { page_count: 4, version: 'pdf-v1', pages: Array.from({ length: 4 }, () => ({ width: 600, height: 800 })) }
    if (action === 'latex_pdf_page' || action === 'latex_media_preview') return { ...image, ...args }
    if (action === 'latex_write') return { revision: 'new', changed: true, bytes: 10 }
    throw new Error(`unexpected action ${action}`)
  }
  vm.runInNewContext(source, { window, document, AbortController, Uint8Array, Blob, atob: value => Buffer.from(value, 'base64').toString('binary'), URL: { createObjectURL() { const url = `blob:${urls.length}`; urls.push(url); return url }, revokeObjectURL: url => revoked.push(url) }, setTimeout: (fn, ms) => { const id = timers.size + 1; timers.set(id, { fn, ms }); return id }, clearTimeout: id => timers.delete(id), getComputedStyle: () => ({ lineHeight: '20' }) })
  const ui = window.PaperLatexWorkspace.create({ api })
  await ui.open(); return { ui, ids, calls, revoked, urls, window }
}

test('navigation keeps an unsaved conflict in place across file, project and close actions', async () => {
  const f = await fixture(action => action === 'latex_write' ? Promise.reject(Object.assign(new Error('changed elsewhere'), { code: 'STATE_CONFLICT', current: { revision: 'other', content: 'other' } })) : undefined)
  await f.ui.testHooks.type('my unsaved writing')
  await f.ui.testHooks.openFile('a.tex')
  await f.ui.testHooks.setProject('two')
  f.ids.get('latex-entry').value = 'draft.tex'; await f.ids.get('latex-entry').dispatch('change')
  await f.ui.testHooks.compile()
  await f.ui.close()
  assert.equal(f.ui.testHooks.state().project, 'one')
  assert.equal(f.ui.testHooks.state().file, 'main.tex')
  assert.equal(f.ids.get('latex-editor').value, 'my unsaved writing')
  assert.equal(f.ui.testHooks.state().dirty, true)
  assert.equal(f.ui.isOpen(), true)
  assert.equal(f.ids.get('latex-conflict').hidden, false)
  assert.equal(f.calls.some(call => ['latex_compile', 'latex_project_update'].includes(call.action)), false)
  f.ui.dispose()
})

test('late file reads cannot replace a newer selected file even if transport ignores abort', async () => {
  const a = deferred(), b = deferred()
  const f = await fixture((action, args) => action === 'latex_read' && args.path !== 'main.tex' ? (args.path === 'a.tex' ? a.promise : b.promise) : undefined)
  const first = f.ui.testHooks.openFile('a.tex'); await tick()
  const second = f.ui.testHooks.openFile('b.tex'); await tick()
  b.resolve({ path: 'b.tex', content: 'B', revision: 'b', bytes: 1, lines: 1 }); await second
  a.resolve({ path: 'a.tex', content: 'A', revision: 'a', bytes: 1, lines: 1 }); await first
  assert.equal(f.ids.get('latex-editor').value, 'B')
  assert.equal(f.ui.testHooks.state().file, 'b.tex')
  assert.equal(f.calls.find(call => call.path === 'a.tex').signal.aborted, true)
  f.ui.dispose()
})

test('DPR and zoom increase requested density; latest page wins and failed page can retry', async () => {
  const late = deferred(); let fail = true
  const f = await fixture((action, args) => {
    if (action !== 'latex_pdf_page') return undefined
    if (args.page === 2) return late.promise
    if (args.page === 4 && fail) return Promise.reject(new Error('synthetic render failure'))
  })
  const fitScale = f.calls.find(call => call.action === 'latex_pdf_page').scale
  f.ids.get('latex-zoom').value = '2'; await f.ids.get('latex-zoom').dispatch('change'); await tick()
  assert.ok(f.calls.filter(call => call.action === 'latex_pdf_page').at(-1).scale >= fitScale * 1.9)
  const first = f.ui.testHooks.renderPage(2); await tick()
  await f.ui.testHooks.renderPage(3)
  late.resolve(image); await first
  assert.equal(f.ids.get('latex-preview').querySelector('img').dataset.page, '3')
  await f.ui.testHooks.renderPage(4)
  assert.match(f.ids.get('latex-render-state').textContent, /失败/)
  fail = false; await f.ui.testHooks.renderPage(4)
  assert.equal(f.ids.get('latex-preview').querySelector('img').dataset.page, '4')
  f.ui.dispose(); assert.equal(f.revoked.length, f.urls.length)
})

test('media switches discard stale results, expose unsupported types and retry failures', async () => {
  const late = deferred()
  const f = await fixture((action, args) => {
    if (action !== 'latex_media_preview') return undefined
    if (args.path === 'media/late.svg') return late.promise
    if (args.path === 'media/unknown.bin') return { supported: false, bytes: 42, reason: 'unsupported type' }
    if (args.path === 'media/bad.svg') return Promise.reject(new Error('unsafe SVG'))
  })
  const first = f.ui.testHooks.openMedia('media/late.svg'); await tick()
  await f.ui.testHooks.openMedia('media/next.png')
  late.resolve(image); await first
  assert.equal(f.ids.get('latex-media-path').textContent, 'media/next.png')
  assert.equal(f.ids.get('latex-media-preview').querySelector('img').alt, 'media/next.png')
  await f.ui.testHooks.openMedia('media/unknown.bin')
  assert.match(f.ids.get('latex-media-preview').textContent, /unsupported/)
  await f.ui.testHooks.openMedia('media/bad.svg')
  assert.match(f.ids.get('latex-media-info').textContent, /失败/)
  f.ui.dispose()
})
