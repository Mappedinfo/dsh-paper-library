/** The shipped panel under a small DOM: deterministic races and failure recovery. */
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import { webcrypto } from 'node:crypto'

const source = await readFile(new URL('../web/latex-workspace.js', import.meta.url), 'utf8')
const reviewSource = await readFile(new URL('../web/latex-review.js', import.meta.url), 'utf8')
const tick = () => new Promise(done => setImmediate(done))
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const image = { image: 'aW1hZ2U=', width: 600, height: 800, pixel_width: 1200, pixel_height: 1600, page_count: 4, bytes: 5, supported: true }

async function fixture(override = () => undefined, { review = false } = {}) {
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
    async dispatch(key, args = {}) { await Promise.all((this.events.get(key) || []).map(fn => fn({ target: this, preventDefault() {}, stopPropagation() {}, ...args }))) }
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
    if (action === 'latex_review_list') return { annotations: [] }
    throw new Error(`unexpected action ${action}`)
  }
  const globals = { window, document, crypto: webcrypto, AbortController, Uint8Array, Blob, atob: value => Buffer.from(value, 'base64').toString('binary'), URL: { createObjectURL() { const url = `blob:${urls.length}`; urls.push(url); return url }, revokeObjectURL: url => revoked.push(url) }, setTimeout: (fn, ms) => { const id = timers.size + 1; timers.set(id, { fn, ms }); return id }, clearTimeout: id => timers.delete(id), getComputedStyle: () => ({ lineHeight: '20' }) }
  if (review) vm.runInNewContext(reviewSource, globals)
  vm.runInNewContext(source, globals)
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

test('an unsaved review draft blocks entry/project changes, compilation, close and browser unload', async () => {
  const f = await fixture(undefined, { review: true })
  f.ui.testHooks.reviewer().beginSource()
  f.ids.get('latex-review-comment').value = 'My unfinished thought'
  await f.ui.testHooks.setProject('two')
  f.ids.get('latex-entry').value = 'draft.tex'; await f.ids.get('latex-entry').dispatch('change')
  await f.ui.testHooks.compile(); await f.ui.close()
  let prevented = false
  await f.window.dispatch('beforeunload', { preventDefault() { prevented = true } })
  assert.equal(prevented, true)
  assert.equal(f.ui.testHooks.state().project, 'one')
  assert.equal(f.ui.isOpen(), true)
  assert.equal(f.ids.get('latex-entry').value, 'main.tex')
  assert.equal(f.ids.get('latex-review-comment').value, 'My unfinished thought')
  assert.equal(f.calls.some(call => ['latex_compile', 'latex_project_update'].includes(call.action)), false)
  await f.ids.get('latex-review-cancel').dispatch('click')
  assert.equal(f.ui.testHooks.reviewer().hasDraft(), false)
  f.ui.dispose()
})

test('engine choice is saved and shared by manual and automatic compilation', async () => {
  let preferences = { latex_engine: 'xelatex', latex_auto_compile: false }
  const f = await fixture((action, args) => {
    if (action === 'settings_get') return { value: preferences, revision: '1' }
    if (action === 'settings_update') { preferences = { ...preferences, ...args.patch }; return { value: preferences, revision: '2' } }
    if (action === 'latex_compile') return { ok: false, engine: args.engine, duration_ms: 1, errors: [], warnings: [], log_tail: 'synthetic log', exit_code: 1 }
  })
  for (const engine of ['xelatex', 'pdflatex', 'lualatex']) {
    f.ids.get('latex-setting-engine').value = engine
    await f.ids.get('latex-setting-engine').dispatch('change'); await tick()
    await f.ui.testHooks.compile('manual'); await f.ui.testHooks.compile('auto')
    assert.deepEqual(f.calls.filter(call => call.action === 'latex_compile').slice(-2).map(call => call.engine), [engine, engine])
  }
  assert.equal(preferences.latex_engine, 'lualatex')
  assert.equal(f.ids.get('latex-diagnostics-toggle').getAttribute('aria-expanded'), 'true')
  assert.match(f.ids.get('latex-errors').textContent, /synthetic log/)
  f.ui.dispose()
})

test('settings changes serialize and keep the newest choice until all writes complete', async () => {
  const firstWrite = deferred(); let revision = 1
  let preferences = { latex_engine: 'xelatex', latex_auto_compile: true }
  let updates = 0
  const f = await fixture((action, args) => {
    if (action === 'settings_get') return { value: { ...preferences }, revision: String(revision) }
    if (action === 'settings_update') {
      assert.equal(args.expected_revision, String(revision))
      updates++
      if (updates === 1) return firstWrite.promise
      preferences = { ...preferences, ...args.patch }; revision++
      return { value: { ...preferences }, revision: String(revision) }
    }
    if (action === 'latex_compile') return { ok: false, engine: args.engine, duration_ms: 1, errors: [], warnings: [], exit_code: 1 }
  })
  f.ids.get('latex-setting-auto').checked = false
  await f.ids.get('latex-setting-auto').dispatch('change')
  f.ids.get('latex-setting-engine').value = 'pdflatex'
  await f.ids.get('latex-setting-engine').dispatch('change')
  await tick()
  assert.equal(updates, 1, 'the second write must wait for the first')
  assert.equal(f.ids.get('latex-setting-engine').value, 'pdflatex')
  const compile = f.ui.testHooks.compile()
  preferences = { ...preferences, latex_auto_compile: false }; revision++
  firstWrite.resolve({ value: { ...preferences }, revision: String(revision) })
  await compile
  assert.equal(updates, 2)
  assert.equal(preferences.latex_auto_compile, false)
  assert.equal(preferences.latex_engine, 'pdflatex')
  assert.equal(f.calls.find(call => call.action === 'latex_compile').engine, 'pdflatex')
  f.ui.dispose()
})

test('compile waits for an engine selection queued during another settings save', async () => {
  const firstWrite = deferred(), secondWrite = deferred(); let revision = 1, count = 0
  let preferences = { latex_engine: 'xelatex', latex_auto_compile: true }
  const f = await fixture((action, args) => {
    if (action === 'settings_get') return { value: { ...preferences }, revision: String(revision) }
    if (action === 'settings_update') {
      count++
      return count === 1 ? firstWrite.promise : secondWrite.promise
    }
    if (action === 'latex_compile') return { ok: false, engine: args.engine, duration_ms: 1, errors: [], warnings: [], exit_code: 1 }
  })
  f.ids.get('latex-setting-auto').checked = false
  await f.ids.get('latex-setting-auto').dispatch('change'); await tick()
  const compile = f.ui.testHooks.compile()
  f.ids.get('latex-setting-engine').value = 'pdflatex'
  await f.ids.get('latex-setting-engine').dispatch('change')
  preferences.latex_auto_compile = false; revision++
  firstWrite.resolve({ value: { ...preferences }, revision: String(revision) })
  await tick()
  assert.equal(count, 2)
  assert.equal(f.calls.some(call => call.action === 'latex_compile'), false)
  preferences.latex_engine = 'pdflatex'; revision++
  secondWrite.resolve({ value: { ...preferences }, revision: String(revision) })
  await compile
  assert.equal(f.calls.find(call => call.action === 'latex_compile').engine, 'pdflatex')
  f.ui.dispose()
})

test('external settings conflict rebases the chosen engine and preserves other fields', async () => {
  let revision = 1, first = true
  let preferences = { latex_engine: 'xelatex', latex_auto_compile: true }
  const f = await fixture((action, args) => {
    if (action === 'settings_get') return { value: { ...preferences }, revision: String(revision) }
    if (action === 'settings_update') {
      if (first) { first = false; revision++; preferences.latex_auto_compile = false; return Promise.reject(Object.assign(new Error('external change'), { code: 'STATE_CONFLICT' })) }
      assert.equal(args.expected_revision, String(revision))
      preferences = { ...preferences, ...args.patch }; revision++
      return { value: { ...preferences }, revision: String(revision) }
    }
    if (action === 'latex_compile') return { ok: false, engine: args.engine, duration_ms: 1, errors: [], warnings: [], exit_code: 1 }
  })
  f.ids.get('latex-setting-engine').value = 'lualatex'
  await f.ids.get('latex-setting-engine').dispatch('change')
  await f.ui.testHooks.compile()
  assert.equal(preferences.latex_engine, 'lualatex')
  assert.equal(preferences.latex_auto_compile, false)
  assert.equal(f.ids.get('latex-setting-auto').checked, false)
  assert.equal(f.calls.find(call => call.action === 'latex_compile').engine, 'lualatex')
  f.ui.dispose()
})

test('a failed engine save preserves the choice and requires retry before compiling', async () => {
  let fail = true, revision = 1
  let preferences = { latex_engine: 'xelatex' }
  const f = await fixture((action, args) => {
    if (action === 'settings_get') return { value: { ...preferences }, revision: String(revision) }
    if (action === 'settings_update') {
      if (fail) return Promise.reject(new Error('synthetic failure'))
      preferences = { ...preferences, ...args.patch }; revision++
      return { value: { ...preferences }, revision: String(revision) }
    }
    if (action === 'latex_compile') return { ok: false, engine: args.engine, duration_ms: 1, errors: [], warnings: [], exit_code: 1 }
  })
  f.ids.get('latex-setting-engine').value = 'pdflatex'
  await f.ids.get('latex-setting-engine').dispatch('change')
  await f.ui.testHooks.compile()
  assert.equal(f.ids.get('latex-setting-engine').value, 'pdflatex')
  assert.equal(f.ids.get('latex-settings-retry').hidden, false)
  assert.equal(f.calls.some(call => call.action === 'latex_compile'), false)
  fail = false
  await f.ids.get('latex-settings-retry').dispatch('click')
  await f.ui.testHooks.compile()
  assert.equal(f.ids.get('latex-settings-retry').hidden, true)
  assert.equal(f.calls.find(call => call.action === 'latex_compile').engine, 'pdflatex')
  f.ui.dispose()
})

test('retry reloads the settings revision after the service was initially unavailable', async () => {
  let reads = 0, saved = false
  const f = await fixture((action, args) => {
    if (action === 'settings_get') {
      if (++reads <= 2) return Promise.reject(new Error('settings offline'))
      return { value: { latex_engine: 'xelatex', latex_auto_compile: false }, revision: 'recovered' }
    }
    if (action === 'settings_update') {
      assert.equal(args.expected_revision, 'recovered')
      saved = true
      return { value: { latex_engine: args.patch.latex_engine, latex_auto_compile: false }, revision: 'saved' }
    }
    if (action === 'latex_compile') return { ok: false, engine: args.engine, duration_ms: 1, errors: [], warnings: [], exit_code: 1 }
  })
  f.ids.get('latex-setting-engine').value = 'lualatex'
  await f.ids.get('latex-setting-engine').dispatch('change')
  await f.ui.testHooks.compile()
  assert.equal(saved, false)
  assert.equal(f.ids.get('latex-setting-engine').value, 'lualatex')
  assert.equal(f.ids.get('latex-settings-retry').hidden, false)
  await f.ids.get('latex-settings-retry').dispatch('click')
  await f.ui.testHooks.compile()
  assert.equal(saved, true)
  assert.equal(f.calls.find(call => call.action === 'latex_compile').engine, 'lualatex')
  f.ui.dispose()
})

test('diagnostics only link project files and preserve a conflicting draft when navigating', async () => {
  const f = await fixture(action => {
    if (action === 'latex_compile') return { ok: false, engine: 'xelatex', duration_ms: 1, errors: ['./a.tex:2: broken', '../outside.tex:1: unsafe', '! unknown'], warnings: [], log_tail: 'synthetic log', exit_code: 1 }
    if (action === 'latex_write') return Promise.reject(Object.assign(new Error('changed elsewhere'), { code: 'STATE_CONFLICT', current: { revision: 'other', content: 'other' } }))
  })
  await f.ui.testHooks.compile()
  const diagnostics = f.ids.get('latex-errors')
  const links = diagnostics.querySelectorAll('button')
  assert.equal(links.length, 1)
  assert.match(links[0].textContent, /a.tex:2/)
  assert.match(diagnostics.textContent, /outside.tex/)
  await f.ui.testHooks.type('my unsaved writing')
  await links[0].dispatch('click'); await tick(); await tick()
  assert.equal(f.ui.testHooks.state().file, 'main.tex')
  assert.equal(f.ids.get('latex-editor').value, 'my unsaved writing')
  assert.equal(f.ids.get('latex-conflict').hidden, false)
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

test('returning to the current file cancels an in-flight switch to another file', async () => {
  const late = deferred()
  const f = await fixture((action, args) => action === 'latex_read' && args.path === 'a.tex' ? late.promise : undefined)
  const opening = f.ui.testHooks.openFile('a.tex'); await tick()
  assert.equal(f.ids.get('latex-editor').disabled, true)
  await f.ui.testHooks.openFile('main.tex')
  late.resolve({ path: 'a.tex', content: 'late A', revision: 'a', bytes: 6, lines: 1 }); await opening
  assert.equal(f.ui.testHooks.state().file, 'main.tex')
  assert.equal(f.ids.get('latex-editor').disabled, false)
  assert.notEqual(f.ids.get('latex-editor').value, 'late A')
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
  assert.ok(f.ids.get('latex-preview').querySelectorAll('img').some(img => img.dataset.page === '3'))
  await f.ui.testHooks.renderPage(4)
  assert.match(f.ids.get('latex-render-state').textContent, /失败/)
  fail = false; await f.ui.testHooks.renderPage(4)
  assert.ok(f.ids.get('latex-preview').querySelectorAll('img').some(img => img.dataset.page === '4'))
  f.ui.dispose(); assert.equal(f.revoked.length, f.urls.length)
})

test('scrolling moves through PDF pages while rendering at most three nearby pages', async () => {
  const f = await fixture()
  const preview = f.ids.get('latex-preview')
  preview.scrollTop = 2000
  await preview.dispatch('scroll'); await tick(); await tick()
  assert.equal(f.ui.testHooks.state().page, 3)
  const pages = preview.querySelectorAll('img').map(img => Number(img.dataset.page))
  assert.ok(pages.includes(3))
  assert.ok(pages.length <= 3 && pages.every(number => Math.abs(number - 3) <= 1))
  f.ui.dispose()
})

test('historical PDF preview isolates page requests and disables editing until current PDF returns', async () => {
  const f = await fixture((action, args) => {
    if (action === 'latex_version_get') return { version: { id: args.version_id, project_id: 'one' } }
    if (action === 'latex_version_pdf_pages') return { version: 'historical', page_count: 2, pages: [{ width: 600, height: 800 }, { width: 600, height: 800 }] }
    if (action === 'latex_version_pdf_page') return image
  })
  assert.equal(await f.ui.showVersion('v1', 'review-sha'), true)
  assert.equal(f.ui.testHooks.state().pdfSource.kind, 'version')
  assert.equal(f.ids.get('latex-tool-highlight').disabled, true)
  assert.equal(f.ids.get('latex-synctex-forward').disabled, true)
  assert.equal(f.calls.find(call => call.action === 'latex_version_pdf_page').review_pdf_version, 'review-sha')
  assert.equal(await f.ui.showCurrentPdf(), true)
  assert.equal(f.ui.testHooks.state().pdfSource.kind, 'current')
  assert.equal(f.ids.get('latex-tool-highlight').disabled, false)
  assert.equal(f.ids.get('latex-synctex-forward').disabled, false)
  f.ui.dispose()
})

test('a delayed historical version cannot replace a newer requested version', async () => {
  const old = deferred()
  const f = await fixture((action, args) => {
    if (action === 'latex_version_get') return args.version_id === 'old' ? old.promise : { version: { id: args.version_id, project_id: 'one' } }
    if (action === 'latex_version_pdf_pages') return { version: 'historical', page_count: 1, pages: [{ width: 600, height: 800 }] }
    if (action === 'latex_version_pdf_page') return image
  })
  const first = f.ui.showVersion('old'); await tick()
  assert.equal(await f.ui.showVersion('new'), true)
  old.resolve({ version: { id: 'old', project_id: 'one' } }); assert.equal(await first, false)
  assert.equal(f.ui.testHooks.state().pdfSource.versionId, 'new')
  f.ui.dispose()
})

test('a late historical page cannot overwrite the current PDF after returning', async () => {
  const late = deferred()
  const f = await fixture((action, args) => {
    if (action === 'latex_version_get') return { version: { id: args.version_id, project_id: 'one' } }
    if (action === 'latex_version_pdf_pages') return { version: 'historical', page_count: 1, pages: [{ width: 600, height: 800 }] }
    if (action === 'latex_version_pdf_page') return late.promise
  })
  const opening = f.ui.showVersion('old'); await tick(); await tick()
  assert.equal(await f.ui.showCurrentPdf(), true)
  late.resolve(image); assert.equal(await opening, false)
  assert.equal(f.ui.testHooks.state().pdfSource.kind, 'current')
  assert.ok(f.ids.get('latex-preview').querySelectorAll('img').some(img => img.dataset.page === '1'))
  f.ui.dispose()
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

test('navigation and focus modes preserve split and reveal a selected source or media', async () => {
  const f = await fixture((action, args) => action === 'settings_update'
    ? { value: { latex_auto_compile: false, ...args.patch }, revision: '2' }
    : undefined)
  const nav = f.ids.get('latex-navigator'), toggle = f.ids.get('latex-nav-toggle')
  const source = f.ids.get('latex-current-file').parentElement
  const preview = f.ids.get('latex-pane-pdf').parentElement
  const splitter = f.ids.get('latex-splitter')

  await splitter.dispatch('keydown', { key: 'ArrowRight' })
  const split = f.ui.testHooks.state().split
  await toggle.dispatch('click')
  assert.equal(nav.hidden, true)
  assert.equal(toggle.getAttribute('aria-expanded'), 'false')
  assert.equal(nav.parentElement.classList.contains('latex-nav-collapsed'), true)
  await toggle.dispatch('click')
  assert.equal(nav.hidden, false)
  assert.equal(toggle.getAttribute('aria-expanded'), 'true')

  await f.ids.get('latex-layout-source').dispatch('click')
  assert.equal(source.hidden, false)
  assert.equal(preview.hidden, true)
  assert.equal(splitter.hidden, true)
  assert.equal(f.ids.get('latex-layout-source').getAttribute('aria-pressed'), 'true')
  await f.ui.testHooks.openMedia('media/picture.png')
  assert.equal(preview.hidden, false)
  assert.equal(f.ids.get('latex-layout-split').getAttribute('aria-pressed'), 'true')
  await f.ids.get('latex-layout-pdf').dispatch('click')
  assert.equal(source.hidden, true)
  assert.equal(preview.hidden, false)
  const sourceButton = f.ids.get('latex-outline').querySelector('button')
  await sourceButton.dispatch('click'); await tick(); await tick()
  assert.equal(source.hidden, false)
  assert.equal(f.ui.testHooks.state().file, 'a.tex')
  assert.equal(f.ui.testHooks.state().split, split)
  assert.equal(f.ids.get('latex-layout-split').getAttribute('aria-pressed'), 'true')
  f.ui.dispose()
})

test('workspace title and return action share the main toolbar and retain the project menu', async () => {
  const f = await fixture()
  const title = f.ids.get('latex-workspace-title')
  const toolbar = title.parentElement
  assert.equal(toolbar.tagName, 'HEADER')
  assert.equal(toolbar.getAttribute('aria-label'), 'LaTeX 工作台工具栏')
  assert.equal(f.ids.get('latex-back').parentElement, toolbar)
  assert.equal(f.ids.get('latex-project').parentElement, toolbar)
  assert.equal(f.ids.get('latex-menu').parentElement, toolbar.parentElement)
  await f.ids.get('latex-menu-open').dispatch('click', { stopPropagation() {} })
  assert.equal(f.ids.get('latex-menu').hidden, false)
  assert.equal(f.ids.get('latex-menu-open').getAttribute('aria-expanded'), 'true')
  await f.ids.get('latex-back').dispatch('click')
  await tick()
  assert.equal(f.ui.isOpen(), false)
  f.ui.dispose()
})

test('compile entry is selected from the project menu and the toolbar shows it once', async () => {
  const f = await fixture((action, args) => action === 'latex_project_update'
    ? { project: { id: args.id, title: args.id, main_path: args.main_path, pdf_present: false } }
    : undefined)
  const entry = f.ids.get('latex-entry'), main = f.ids.get('latex-main')
  assert.equal(entry.parentElement.parentElement, f.ids.get('latex-menu'))
  assert.equal(entry.getAttribute('aria-label'), '编译主文件')
  assert.equal(main.textContent, '编译：main.tex')
  assert.equal(f.ids.get('latex-project').selectedOptions[0].textContent, 'one')
  entry.value = 'draft.tex'; await entry.dispatch('change')
  assert.equal(main.textContent, '编译：draft.tex')
  assert.equal(f.ids.get('latex-project').selectedOptions[0].textContent, 'one')
  assert.equal(f.ui.testHooks.state().file, 'draft.tex')
  f.ui.dispose()
})

test('preview actions share a toolbar and switch with the active preview', async () => {
  const f = await fixture()
  const tabs = f.ids.get('latex-tab-pdf').parentElement
  const bar = tabs.parentElement
  assert.equal(f.ids.get('latex-page-prev').parentElement.parentElement, bar)
  assert.equal(f.ids.get('latex-tool-highlight').parentElement.parentElement, bar)
  assert.equal(f.ids.get('latex-media-prev').parentElement.parentElement, bar)
  assert.equal(f.ids.get('latex-page-prev').parentElement.hidden, false)
  assert.equal(f.ids.get('latex-media-prev').parentElement.hidden, true)
  await f.ids.get('latex-tab-media').dispatch('click')
  assert.equal(f.ids.get('latex-page-prev').parentElement.hidden, true)
  assert.equal(f.ids.get('latex-tool-highlight').parentElement.hidden, true)
  assert.equal(f.ids.get('latex-media-prev').parentElement.hidden, false)
  f.ui.dispose()
})

test('workspace theme persists as a local preference without changing the host', async () => {
  let preferences = { latex_theme: 'system', latex_auto_compile: false }
  const f = await fixture((action, args) => {
    if (action === 'settings_get') return { value: preferences, revision: '1' }
    if (action === 'settings_update') { preferences = { ...preferences, ...args.patch }; return { value: preferences, revision: '2' } }
  })
  const theme = f.ids.get('latex-setting-theme')
  theme.value = 'midnight'; await theme.dispatch('change'); await tick()
  assert.equal(preferences.latex_theme, 'midnight')
  assert.equal(f.ids.get('latex-view').dataset.latexTheme, 'midnight')
  assert.equal(f.window.dataset.latexTheme, undefined)
  theme.value = 'parchment'; await theme.dispatch('change'); await tick()
  assert.equal(preferences.latex_theme, 'parchment')
  assert.equal(f.ids.get('latex-view').dataset.latexTheme, 'parchment')
  f.ui.dispose()
})
