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

async function fixture(override = () => undefined, { review = false, spellChecker, writingTools, onContext, rail } = {}) {
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
  const FixtureURL = class extends URL {
    static createObjectURL() { const url = `blob:${urls.length}`; urls.push(url); return url }
    static revokeObjectURL(url) { revoked.push(url) }
  }
  const globals = { window, document, crypto: webcrypto, AbortController, Uint8Array, Blob, atob: value => Buffer.from(value, 'base64').toString('binary'), URL: FixtureURL, setTimeout: (fn, ms) => { const id = timers.size + 1; timers.set(id, { fn, ms }); return id }, clearTimeout: id => timers.delete(id), getComputedStyle: () => ({ lineHeight: '20' }) }
  if (spellChecker) window.PaperLatexSpelling = { checkSpelling: spellChecker }
  if (writingTools) window.PaperLatexWritingTools = { create: () => writingTools }
  if (review) vm.runInNewContext(reviewSource, globals)
  vm.runInNewContext(source, globals)
  const ui = window.PaperLatexWorkspace.create({ api, onContext, rail })
  await ui.open(); return { ui, ids, calls, revoked, urls, window, timers }
}

test('closing refuses to discard a writing-tool draft', async () => {
  let pending = true
  const f = await fixture(() => undefined, { writingTools: { hasDraft: () => pending, dispose() {} } })
  await f.ui.close(); assert.equal(f.ui.isOpen(), true)
  pending = false; await f.ui.close(); assert.equal(f.ui.isOpen(), false)
  f.ui.dispose()
})

test('the combined rail keeps drafts and collapses writing to one history button', async () => {
  const registered = []; let active = null
  const rail = {
    registerPanel(panel) { registered.push(panel); panel.element.hidden = true },
    setExternal(value) { if (!value) active = null },
    show(id) { active = id }, close(id) { if (active === id) active = null }, visible: id => active === id,
  }
  const f = await fixture(undefined, { review: true, rail })
  assert.equal(registered.length, 1)
  assert.equal(registered[0].id, 'latex-ai')
  assert.equal(registered[0].label, '批注与写作')
  assert.deepEqual(Array.from(registered[0].aliases), ['latex-review'])
  const panel = registered[0].element
  assert.equal(f.ids.get('latex-review-panel').parentElement, panel)
  assert.equal(f.ids.get('latex-ai').parentElement, panel)
  assert.equal(f.ids.get('latex-review-open').hidden, true)
  assert.equal(f.ids.get('latex-ai-open').textContent, '批注与写作')
  assert.equal(f.ids.get('latex-review-export-pdf').type, 'button')
  const history = f.ids.get('latex-writing-history'), historyBody = f.ids.get('latex-writing-history-body')
  assert.equal(history.textContent, '写作记录')
  assert.equal(historyBody.hidden, true)
  for (const id of ['latex-ai-input', 'latex-ai-ask', 'latex-ai-propose', 'latex-ai-add-note', 'latex-ai-scope']) assert.equal(f.ids.has(id), false)
  await history.dispatch('click')
  assert.equal(historyBody.hidden, false)
  await history.dispatch('click')
  assert.equal(historyBody.hidden, true)
  await f.ids.get('latex-source-note').dispatch('click')
  f.ids.get('latex-review-comment').value = 'Synthetic manual annotation'
  assert.equal(active, 'latex-ai')
  assert.equal(f.ids.get('latex-review-composer').hidden, false)
  await f.ids.get('latex-ai-open').dispatch('click')
  assert.equal(active, null)
  await f.ids.get('latex-ai-open').dispatch('click')
  assert.equal(active, 'latex-ai')
  assert.equal(f.ids.get('latex-review-comment').value, 'Synthetic manual annotation')
  await f.ui.close()
  assert.equal(f.ui.isOpen(), true, 'Hiding the combined rail never discards an unfinished manual note')
  await f.ids.get('latex-review-cancel').dispatch('click')
  await f.ui.close()
  assert.equal(f.ui.isOpen(), false)
  f.ui.dispose()
})

test('standalone review actions open the same combined preview instead of an additional overlay', async () => {
  const f = await fixture(undefined, { review: true })
  assert.equal(f.ui.testHooks.state().tab, 'pdf', 'Opening the writer still starts on its PDF')
  await f.ids.get('latex-source-note').dispatch('click')
  assert.equal(f.ui.testHooks.state().tab, 'ai')
  assert.equal(f.ids.get('latex-tab-ai').textContent, '批注与写作')
  assert.equal(f.ids.get('latex-review-panel').parentElement, f.ids.get('latex-writing-panel'))
  assert.equal(f.ids.get('latex-ai').parentElement, f.ids.get('latex-writing-panel'))
  assert.equal(f.ids.get('latex-review-composer').hidden, false)
  f.ui.dispose()
})

test('writer context reports only active project identity and stays put when unsaved work blocks leaving', async () => {
  const contexts = []; let pending = false
  const f = await fixture(undefined, { onContext: value => contexts.push(value && { ...value }), writingTools: { hasDraft: () => pending, dispose() {} } })
  assert.deepEqual({ ...f.ui.current() }, { kind: 'latex', id: 'one', title: 'one' })
  assert.deepEqual(contexts.at(-1), { ...f.ui.current() })
  pending = true
  const before = contexts.length
  await f.ui.testHooks.setProject('two'); await f.ui.close()
  assert.equal(contexts.length, before)
  assert.equal(f.ui.current().id, 'one')
  pending = false
  await f.ui.testHooks.setProject('two')
  assert.equal(f.ui.current().id, 'two')
  assert.equal(contexts.at(-1).id, 'two')
  assert.deepEqual(Object.keys(contexts.at(-1)).sort(), ['id', 'kind', 'title'])
  await f.ui.close()
  assert.equal(f.ui.current(), null)
  assert.equal(contexts.at(-1), null)
  f.ui.dispose()
})

test('empty writer reports no project context and a selected project keeps its identity when navigation reading fails', async () => {
  const emptyEvents = []
  const empty = await fixture(action => action === 'latex_project_list' ? { projects: [] } : undefined, { onContext: value => emptyEvents.push(value) })
  assert.equal(empty.ui.isOpen(), true)
  assert.equal(empty.ui.current(), null)
  assert.equal(emptyEvents.at(-1), null)
  empty.ui.dispose()
  const contexts = []
  const f = await fixture(action => { if (action === 'latex_tree') throw Error('synthetic tree error') }, { onContext: value => contexts.push(value && { ...value }) })
  assert.equal(f.ui.current().id, 'one')
  assert.equal(contexts.at(-1).id, 'one')
  assert.deepEqual(Object.keys(contexts.at(-1)).sort(), ['id', 'kind', 'title'])
  f.ui.dispose()
})

test('an explicit missing writer project never falls back or clears an existing draft', async () => {
  let rejectSave = false
  const contexts = []
  const f = await fixture((action, args) => {
    if (action === 'latex_project_get') throw Error('synthetic project missing')
    if (action === 'latex_write' && rejectSave) throw Error('synthetic unsaved draft')
  }, { onContext: value => contexts.push(value && { ...value }) })
  rejectSave = true
  await f.ui.testHooks.type('unsaved source must stay here')
  const original = { ...f.ui.current() }, before = contexts.length
  assert.equal(await f.ui.open('missing'), false)
  assert.deepEqual({ ...f.ui.current() }, original)
  assert.equal(contexts.length, before)
  assert.equal(f.ui.testHooks.state().dirty, true)
  assert.equal(f.ids.get('latex-editor').value, 'unsaved source must stay here')
  f.ui.dispose()
})

test('an exact writer project beyond the listing page is fetched by ID and an invalid identity is never selected', async () => {
  const contexts = []
  const f = await fixture((action, args) => {
    if (action === 'latex_project_get') return { project: { id: args.id === 'third' ? 'third' : 'unrelated', title: 'Third project', main_path: 'main.tex', pdf_present: false } }
  }, { onContext: value => contexts.push(value && { ...value }) })
  assert.equal(await f.ui.open('third'), true)
  assert.deepEqual({ ...f.ui.current() }, { kind: 'latex', id: 'third', title: 'Third project' })
  assert.equal(f.calls.some(call => call.action === 'latex_project_get' && call.id === 'third'), true)
  const before = contexts.length
  assert.equal(await f.ui.open('not-third'), false)
  assert.equal(f.ui.current().id, 'third')
  assert.equal(contexts.length, before)
  f.ui.dispose()
})

test('a missing or archived writer target cannot open a hidden workspace, and late lookup cannot reopen after close', async () => {
  const lookup = deferred()
  const f = await fixture((action, args) => {
    if (action === 'latex_project_get') return args.id === 'late' ? lookup.promise : { project: { id: args.id, title: 'Archived', archived: true } }
  })
  await f.ui.close()
  assert.equal(await f.ui.open('archived'), false)
  assert.equal(f.ui.isOpen(), false)
  assert.equal(f.ui.current(), null)
  const opening = f.ui.open('late'); await tick()
  await f.ui.close()
  lookup.resolve({ project: { id: 'late', title: 'Late project', main_path: 'main.tex', pdf_present: false } })
  assert.equal(await opening, false)
  assert.equal(f.ui.isOpen(), false)
  assert.equal(f.ui.current(), null)
  f.ui.dispose()
})

test('an explicitly unavailable writer folder is refused before replacing the current draft', async () => {
  let missingListedFolder = false, rejectSave = false
  const contexts = []
  const f = await fixture((action, args) => {
    if (action === 'latex_project_list' && missingListedFolder) return { projects: [{ id: 'one', title: 'Unavailable folder', exists: false }] }
    if (action === 'latex_project_get') return { project: { id: args.id, title: 'Unavailable folder', exists: false } }
    if (action === 'latex_write' && rejectSave) throw Error('synthetic unsaved source')
  }, { onContext: value => contexts.push(value && { ...value }) })
  rejectSave = true; await f.ui.testHooks.type('keep the current draft')
  const before = contexts.length
  assert.equal(await f.ui.open('outside-list'), false)
  missingListedFolder = true
  assert.equal(await f.ui.open('one'), false)
  assert.equal(contexts.length, before)
  assert.equal(f.ui.current().id, 'one')
  assert.equal(f.ids.get('latex-editor').value, 'keep the current draft')
  assert.equal(f.ui.testHooks.state().dirty, true)
  f.ui.dispose()
})

test('a project whose folder moved remains selectable for safe location repair', async () => {
  const missing = { id: 'moved', title: 'Moved', root: '/old/project', main_path: 'main.tex', binding_generation: 0, exists: false, pdf_present: false }
  const f = await fixture((action, args) => {
    if (action === 'latex_project_get' && args.id === 'moved') return { project: missing }
    if (action === 'latex_project_update') return { project: { ...missing, root: '/new/project', main_path: 'review/main.tex', binding_generation: 1, exists: true } }
  })
  assert.equal(await f.ui.open('moved'), true)
  assert.equal(f.ui.current().id, 'moved')
  assert.equal(f.ids.get('latex-location-root').value, '/old/project')
  assert.equal(f.ids.get('latex-location-main').value, 'main.tex')
  assert.equal(f.ids.get('latex-editor').disabled, true)
  assert.equal(f.ids.get('latex-compile').disabled, true)
  assert.equal(f.calls.some(call => call.id === 'moved' && ['latex_tree', 'latex_read'].includes(call.action)), false)
  assert.match(f.ids.get('latex-status').textContent, /项目文件夹已不可用/)
  await f.ids.get('latex-compile').dispatch('click')
  assert.equal(f.calls.some(call => call.id === 'moved' && call.action === 'latex_compile'), false)
  f.ids.get('latex-location-root').value = '/new/project'
  f.ids.get('latex-location-main').value = 'review/main.tex'
  await f.ids.get('latex-location-save').dispatch('click')
  assert.equal(f.ui.testHooks.state().file, 'review/main.tex')
  assert.equal(f.ids.get('latex-compile').disabled, false)
  const request = f.calls.find(call => call.action === 'latex_project_update')
  assert.equal(request.expected_root, '/old/project'); assert.equal(request.expected_binding_generation, 0)
  f.ui.dispose()
})

test('textarea fallback can turn on local spelling and navigate to a detected word', async () => {
  const f = await fixture(action => {
    if (action === 'state_get') return { value: null, revision: 0 }
    if (action === 'state_put') return { revision: 'saved' }
  }, { spellChecker: () => ({ items: [{ word: 'typoo', from: 0, to: 5 }], truncated: false }) })
  const editor = f.ids.get('latex-editor'); editor.value = 'typoo in text';
  await f.ids.get('latex-spell-toggle').dispatch('click')
  const job = [...f.timers.values()].find(timer => timer.ms === 450); assert.ok(job); await job.fn()
  const result = f.ids.get('latex-spelling-results'); assert.equal(result.hidden, false)
  const button = result.querySelector('button'); assert.equal(button.textContent, 'typoo'); await button.dispatch('click')
  assert.equal(editor.selectionStart, 0); assert.equal(editor.selectionEnd, 5)
  assert.equal(f.calls.some(call => call.action === 'state_put' && call.key === 'reader:latex-spelling'), true)
  f.ui.dispose()
})

test('translation sends only an unsaved selection and never writes the source', async () => {
  const f = await fixture((action) => {
    if (action === 'language_settings_get') return { models: [{ provider: 'host', id: 'mini', name: 'Mini' }] }
    if (action === 'state_get') return { value: null, revision: 0 }
    if (action === 'latex_ai_translate') return { answer: '合成译文', model: { provider: 'host', model: 'mini' }, prompt_version: 'latex-translate-v1:test' }
  })
  const editor = f.ids.get('latex-editor'); editor.value = 'UNSAVED draft selected text and private remainder'; editor.setSelectionRange(8, 27); await editor.dispatch('input')
  await f.ids.get('latex-translate-selection').dispatch('click')
  const request = f.calls.find(call => call.action === 'latex_ai_translate')
  assert.equal(request.selection, 'draft selected text'); assert.equal(request.target_language, undefined, 'the server resolves the current shared target')
  assert.equal(f.calls.some(call => call.action === 'latex_write'), false)
  assert.match(f.ids.get('latex-translation-results').textContent, /来源为编辑草稿/)
  assert.equal(f.ui.testHooks.state().dirty, true); f.ui.dispose()
})

test('project translation settings persist an explicit model, language and prompt with CAS', async () => {
  const f = await fixture((action, args) => {
    if (action === 'language_settings_get') return { models: [{ provider: 'host', id: 'mini', name: 'Mini' }] }
    if (action === 'state_get') return { value: null, revision: 0 }
    if (action === 'state_put') return { value: args.value, revision: 'revision-new' }
    if (action === 'project_list') return { projects: [] }
    if (action === 'latex_ai_translate') return { answer: 'Synthetic translation', model: { provider: 'host', model: 'mini' }, prompt_version: 'latex-translate-v1:test' }
  })
  await f.ids.get('latex-menu-open').dispatch('click'); await tick()
  f.ids.get('latex-translate-model').value = JSON.stringify({ provider: 'host', model: 'mini' })
  f.ids.get('latex-translate-target').value = 'en'; f.ids.get('latex-translate-prompt').value = '保留缩写'
  await f.ids.get('latex-translate-settings-save').dispatch('click')
  const saved = f.calls.find(call => call.action === 'state_put' && call.key === 'reader:latex-translation-one')
  assert.equal(saved.expected_revision, 0);assert.equal(saved.value.model.model, 'mini');assert.equal(saved.value.target_language, 'en')
  const editor = f.ids.get('latex-editor');editor.value = '合成草稿';editor.setSelectionRange(0, 4)
  await f.ids.get('latex-translate-selection').dispatch('click')
  const request = f.calls.find(call => call.action === 'latex_ai_translate')
  assert.equal(request.target_language, 'en');assert.equal(request.model_override.model, 'mini');assert.equal(request.prompt, '保留缩写')
  f.ui.dispose()
})

test('project translation can explicitly use auto or follow shared language settings', async () => {
  const f = await fixture((action, args) => {
    if (action === 'language_settings_get') return { value: { target_language: 'en' }, models: [{ provider: 'host', id: 'mini', name: 'Mini' }, { provider: 'other', id: 'basic', name: 'Basic' }] }
    if (action === 'state_get') return { value: null, revision: 0 }
    if (action === 'state_put') return { value: args.value, revision: 'next' }
    if (action === 'project_list') return { projects: [] }
    if (action === 'latex_ai_translate') return { answer: 'Synthetic', model: { provider: 'host', model: 'mini' }, target_language: 'en', prompt_version: 'test' }
  })
  await f.ids.get('latex-menu-open').dispatch('click'); await tick()
  assert.deepEqual(f.ids.get('latex-translate-model').children.filter(node => node.tagName === 'OPTGROUP').map(node => node.label), ['host', 'other'])
  f.ids.get('latex-translate-target').value = 'auto'
  await f.ids.get('latex-translate-settings-save').dispatch('click')
  const editor = f.ids.get('latex-editor'); editor.value = '合成选文'; editor.setSelectionRange(0, 4)
  await f.ids.get('latex-translate-selection').dispatch('click')
  assert.equal(f.calls.filter(call => call.action === 'latex_ai_translate').at(-1).target_language, 'auto')
  f.ids.get('latex-translate-target').value = ''
  await f.ids.get('latex-translate-settings-save').dispatch('click')
  assert.equal(f.calls.filter(call => call.action === 'state_put' && call.key === 'reader:latex-translation-one').at(-1).value.target_language, null)
  await f.ids.get('latex-translate-selection').dispatch('click')
  assert.equal(f.calls.filter(call => call.action === 'latex_ai_translate').at(-1).target_language, undefined)
  f.ui.dispose()
})

test('changing files cancels translation and ignores a late response', async () => {
  const late = deferred()
  const f = await fixture(action => {
    if (action === 'language_settings_get') return { models: [] }
    if (action === 'state_get') return { value: null, revision: 0 }
    if (action === 'latex_ai_translate') return late.promise
  })
  const editor = f.ids.get('latex-editor');editor.setSelectionRange(0, 4)
  const pending = f.ids.get('latex-translate-selection').dispatch('click');await tick()
  const request = f.calls.find(call => call.action === 'latex_ai_translate');assert.ok(request)
  await f.ui.testHooks.openFile('a.tex');assert.equal(request.signal.aborted, true)
  late.resolve({ answer: 'late result', model: { provider: 'host', model: 'default' }, prompt_version: 'v1' });await pending
  assert.equal(f.ids.get('latex-translation-results').hidden, true)
  assert.doesNotMatch(f.ids.get('latex-translation-results').textContent, /late result/)
  f.ui.dispose()
})

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

test('the approaching page preloads before it enters and keeps visible raster nodes', async () => {
  const f = await fixture()
  await tick(); await tick()
  const preview = f.ids.get('latex-preview')
  const second = preview.querySelectorAll('.latex-page-stage').find(stage => stage.dataset.page === '2')
  const image = second.querySelector('img')
  assert.ok(image)
  preview.scrollTop = 1153
  await preview.dispatch('scroll'); await tick(); await tick()
  assert.equal(f.ui.testHooks.state().page, 2, 'the fourth page loads while page two is still active')
  assert.ok(f.calls.some(call => call.action === 'latex_pdf_page' && call.page === 4))
  assert.equal(preview.querySelectorAll('.latex-page-stage').find(stage => stage.dataset.page === '2'), second)
  assert.equal(second.querySelector('img'), image)
  assert.ok(preview.querySelectorAll('img').length <= 3)
  assert.match(f.ids.get('latex-sync-hint').textContent, /^第 2 \/ 4 页 · /)
  f.ui.dispose()
})

test('scrolling into an in-flight prefetched page does not cancel or repeat its request', async () => {
  const next = deferred()
  const f = await fixture((action, args) => action === 'latex_pdf_page' && args.page === 2 ? next.promise : undefined)
  const request = f.calls.find(call => call.action === 'latex_pdf_page' && call.page === 2)
  assert.ok(request, 'the next page starts alongside the initial page')
  f.ids.get('latex-preview').scrollTop = 650
  await f.ids.get('latex-preview').dispatch('scroll')
  assert.equal(f.ui.testHooks.state().page, 2)
  assert.equal(request.signal.aborted, false)
  assert.equal(f.calls.filter(call => call.action === 'latex_pdf_page' && call.page === 2).length, 1)
  next.resolve(image); await tick(); await tick()
  assert.ok(f.ids.get('latex-preview').querySelectorAll('img').some(img => img.dataset.page === '2'))
  f.ui.dispose()
})

test('a confirmed PDF annotation patches only its overlay without reloading raster or selection layers', async () => {
  let annotations = []
  const anchor = { kind: 'pdf', page: 1, pdf_version: 'synthetic-sha', rects: [[10, 20, 50, 35]], text: 'synthetic selection' }
  const f = await fixture((action, args) => {
    if (action === 'latex_pdf_pages') return { page_count: 4, version: 'pdf-v1', build: { pdf_version: 'synthetic-sha', reason: 'SyncTeX 已核验' }, pages: Array.from({ length: 4 }, () => ({ width: 600, height: 800 })) }
    if (action === 'latex_review_list') return { annotations }
    if (action === 'latex_review_put') {
      annotations = [{ id: `pdf:synthetic-sha:${args.request_id}`, type: args.type, text: anchor.text, comment: '', status: 'open', anchor, version: 'saved-native' }]
      return { saved: true, pdf_version: 'synthetic-sha' }
    }
  }, { review: true })
  await tick(); await tick()
  const preview = f.ids.get('latex-preview')
  preview.scrollTop = 120
  const stage = preview.querySelectorAll('.latex-page-stage').find(stage => stage.dataset.page === '1')
  const image = stage.querySelector('img'), layer = stage.querySelector('.latex-text-layer')
  const rasterCalls = f.calls.filter(call => call.action === 'latex_pdf_page').length
  const urls = f.urls.length
  f.ui.testHooks.reviewer().beginPdf(anchor, 'highlight')
  await f.ui.testHooks.reviewer().testHooks.saveDraft()
  assert.equal(f.calls.filter(call => call.action === 'latex_pdf_page').length, rasterCalls)
  assert.equal(f.urls.length, urls)
  assert.equal(preview.scrollTop, 120)
  assert.equal(stage.querySelector('img'), image)
  assert.equal(stage.querySelector('.latex-text-layer'), layer)
  assert.equal(stage.querySelectorAll('.latex-saved-mark').length, 1)
  assert.equal(f.ui.testHooks.reviewer().hasDraft(), false)
  f.ui.dispose()
})

test('automatic matches project current PDF marks across pages while preserving the saved annotation anchor', async () => {
  const original = { kind: 'pdf', page: 4, pdf_version: 'old-sha', rects: [[1, 1, 12, 15]] }
  const anchors = [1, 2].map(page => ({ kind: 'pdf', page, pdf_version: 'current-sha', rects: [[20, 30, 120, 45]], text: 'Synthetic current quotation' }))
  const note = { id: 'pdf:old-sha:synthetic', type: 'highlight', text: 'Synthetic original quotation', comment: 'preserved', status: 'open', stale: true, version: 'saved-version', anchor: original,
    relocation: { status: 'matched', method: 'normalized', score: 1, anchor: anchors[0], anchors } }
  const f = await fixture(action => {
    if (action === 'latex_pdf_pages') return { page_count: 4, version: 'pdf-v1', build: { pdf_version: 'current-sha' }, pages: Array.from({ length: 4 }, () => ({ width: 600, height: 800, rotation: 90 })) }
    if (action === 'latex_review_list') return { annotations: [note] }
  }, { review: true })
  await tick(); await tick(); await f.ui.testHooks.reviewer().refresh()
  const stages = f.ids.get('latex-preview').querySelectorAll('.latex-page-stage')
  for (const page of [1, 2]) {
    const stage = stages.find(value => value.dataset.page === String(page)), marks = stage.querySelectorAll('.latex-saved-mark')
    assert.equal(marks.length, 1); assert.match(marks[0].style.outline, /dashed/)
    assert.equal(marks[0].style.left, `${20 / 600 * 100}%`)
  }
  assert.equal(f.ui.testHooks.reviewer().annotations()[0].anchor, original)
  assert.equal(f.calls.some(call => call.action === 'latex_review_put'), false)
  f.ui.dispose()
})

test('display-coordinate PDF anchors can flash on rotated pages while unconverted SyncTeX coordinates remain guarded', async () => {
  const snippet = source.slice(source.indexOf('    async function highlightPdf('), source.indexOf('    async function jumpToPdf('))
  const markers = [], messages = [], stage = { querySelector: () => null, append: value => markers.push(value) }
  const img = { parentElement: stage, decode: async () => {}, getBoundingClientRect: () => ({ width: 300, height: 400 }) }
  const context = vm.createContext({ pageGeometry: [{ width: 600, height: 800, rotation: 90 }], preview: { querySelector: () => img }, say: message => messages.push(message),
    make: () => ({ style: {}, scrollIntoView() {}, remove() {} }), clearTimeout() {}, setTimeout: () => 1, syncFlash: null })
  vm.runInContext(snippet, context)
  const target = { page: 1, h: 20, v: 50, W: 40, H: 20 }
  await context.highlightPdf(target); assert.equal(markers.length, 0); assert.equal(messages.length, 1)
  await context.highlightPdf({ ...target, displayCoordinates: true })
  assert.equal(markers.length, 1); assert.equal(markers[0].style.left, '10px'); assert.equal(markers[0].style.top, '15px')
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

test('writing model selection belongs to settings and remains the route for DSH questions', async () => {
  const note = savedReview()
  const f = await fixture(action => {
    if (action === 'latex_review_list') return { annotations: [note] }
    if (action === 'models') return { models: [{ provider: 'first', id: 'basic', name: 'Basic' }, { provider: 'second', id: 'chosen', name: 'Chosen' }] }
    if (action === 'latex_ai_status') return { configured: false, entries: [] }
    if (action === 'latex_ai_ask') return { answer: 'Synthetic answer', model: { provider: 'second', model: 'chosen' }, material: { truncated: false } }
  }, { review: true })
  const selector = f.ids.get('latex-ai-model'), settings = f.ids.get('latex-writing-model-settings')
  assert.equal(selector.parentElement, settings)
  assert.equal(settings.parentElement, f.ids.get('latex-menu'))
  assert.equal(f.ids.get('latex-ai').querySelectorAll('select').length, 0)
  assert.equal(f.ids.get('latex-menu-open').getAttribute('aria-label'), '设置')
  assert.equal(f.ids.get('latex-menu-open').title, '设置')
  await f.ids.get('latex-ai-open').dispatch('click'); await tick()
  selector.value = '1'
  await f.ids.get('latex-menu-open').dispatch('click'); await tick()
  await f.ids.get('latex-menu-open').dispatch('click'); await tick()
  assert.equal(selector.value, '1', 'Toggling settings must retain the original selector and its current value')
  await f.ui.testHooks.reviewer().refresh()
  assert.equal(await f.ui.testHooks.reviewer().testHooks.runNote('ask', note), true)
  const request = f.calls.find(call => call.action === 'latex_ai_ask')
  assert.equal(request.provider, 'second'); assert.equal(request.model, 'chosen')
  f.ui.dispose()
})

test('registering a folder sends the explicitly chosen nested main file', async () => {
  const nested = { id: 'nested', title: 'Nested', root: '/synthetic/project', main_path: 'review/main.tex', pdf_present: false }
  let registered = false
  const f = await fixture((action, args) => {
    if (action === 'latex_project_create') { registered = true; return { project: nested } }
    if (action === 'latex_project_list' && registered) return { projects: [nested] }
    if (action === 'latex_ws_pick_tex') return { path: '/synthetic/project/review/main.tex' }
  })
  f.ids.get('latex-new-root').value = '/synthetic/project'
  await f.ids.get('latex-new-main-pick').dispatch('click'); await tick()
  assert.equal(f.ids.get('latex-new-main').value, '/synthetic/project/review/main.tex')
  await f.ids.get('latex-new-submit').dispatch('click')
  const call = f.calls.find(call => call.action === 'latex_project_create')
  assert.equal(call.root, '/synthetic/project'); assert.equal(call.main_path, '/synthetic/project/review/main.tex')
  assert.equal(f.ui.testHooks.state().file, 'review/main.tex')
  f.ui.dispose()
})

test('updating project location protects drafts and locks the workspace until the new root is loaded', async () => {
  const pending = deferred(); let failSave = true
  const initial = { id: 'one', title: 'one', root: '/old/project', main_path: 'main.tex', binding_generation: 0, pdf_present: true }
  const f = await fixture((action, args) => {
    if (action === 'latex_project_list') return { projects: [initial, { ...initial, id: 'two', title: 'two' }] }
    if (action === 'latex_write' && failSave) throw Error('synthetic unsaved draft')
    if (action === 'latex_project_update') return pending.promise
  })
  f.ids.get('latex-location-root').value = '/new/project'
  f.ids.get('latex-location-main').value = 'review/main.tex'
  await f.ui.testHooks.type('unsaved source')
  await f.ids.get('latex-location-save').dispatch('click')
  assert.equal(f.calls.some(call => call.action === 'latex_project_update'), false)
  assert.equal(f.ids.get('latex-editor').value, 'unsaved source')
  failSave = false
  const update = f.ids.get('latex-location-save').dispatch('click'); await tick()
  const request = f.calls.find(call => call.action === 'latex_project_update')
  assert.equal(request.root, '/new/project'); assert.equal(request.main_path, 'review/main.tex'); assert.equal(request.expected_root, '/old/project'); assert.equal(request.expected_binding_generation, 0)
  const write = f.calls.filter(call => call.action === 'latex_write').at(-1); assert.equal(write.expected_root, '/old/project'); assert.equal(write.expected_binding_generation, 0)
  await f.ids.get('latex-compile').dispatch('click'); await f.ui.testHooks.setProject('two'); await f.ui.close()
  assert.equal(f.ui.current().id, 'one'); assert.equal(f.ui.isOpen(), true)
  assert.equal(f.calls.some(call => call.action === 'latex_compile'), false)
  pending.resolve({ project: { ...initial, root: '/new/project', main_path: 'review/main.tex', binding_generation: 1, pdf_present: false } })
  await update
  assert.equal(f.ui.testHooks.state().file, 'review/main.tex')
  const read = f.calls.filter(call => call.action === 'latex_read').at(-1)
  assert.equal(read.expected_root, '/new/project'); assert.equal(read.expected_binding_generation, 1)
  assert.equal(f.ids.get('latex-location-root').value, '/new/project')
  f.ui.dispose()
})

test('a delayed main file picker cannot replace a different project location', async () => {
  const pick = deferred()
  const f = await fixture(action => action === 'latex_ws_pick_tex' ? pick.promise : undefined)
  f.ids.get('latex-location-main-pick').dispatch('click'); await tick()
  await f.ui.testHooks.setProject('two')
  pick.resolve({ path: '/old/review/main.tex' }); await tick()
  assert.equal(f.ids.get('latex-location-main').value, 'main.tex')
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

function sectionOutline() {
  return { events: [{ kind: 'file', path: 'main.tex', line: 1, title: 'main.tex' },
    { kind: 'file', path: 'a.tex', line: 1, title: 'a.tex' },
    ...[1, 4, 8].map(line => ({ kind: 'heading', path: 'a.tex', line, title: `Section ${line}`, level: 2 })),
    { kind: 'file', path: 'b.tex', line: 1, title: 'b.tex' }, { kind: 'heading', path: 'b.tex', line: 1, title: 'Other section', level: 2 }],
    entries: ['main.tex'], unreferenced: [], entry_scan_complete: true }
}
const sectionText = Array.from({ length: 10 }, (_, index) => `Synthetic line ${index + 1}`).join('\n')
const outlineButtons = f => f.ids.get('latex-outline').querySelectorAll('button[data-path]')
const strongOutline = f => outlineButtons(f).filter(button => button.classList.contains('active'))

test('outline distinguishes one current heading from same-file context and follows the cursor', async () => {
  const f = await fixture((action, args) => {
    if (action === 'latex_outline') return sectionOutline()
    if (action === 'latex_read') return { path: args.path, content: sectionText, revision: 'synthetic', bytes: sectionText.length, lines: 10 }
  })
  await f.ui.testHooks.gotoSource('a.tex', 4)
  assert.equal(strongOutline(f).length, 1); assert.equal(strongOutline(f)[0].dataset.line, '4')
  assert.equal(strongOutline(f)[0].getAttribute('aria-current'), 'location')
  assert.equal(outlineButtons(f).filter(button => button.classList.contains('current-file')).length, 4)
  const editor = f.ids.get('latex-editor'), offset = sectionText.split('\n').slice(0, 7).join('\n').length + 1
  editor.setSelectionRange(offset, offset); await editor.dispatch('select')
  assert.equal(strongOutline(f).length, 1); assert.equal(strongOutline(f)[0].dataset.line, '8')
  await f.ui.testHooks.loadOutline()
  assert.equal(strongOutline(f)[0].dataset.line, '8', 'navigation refresh keeps the current section')
  await f.ui.testHooks.gotoSource('b.tex', 1)
  assert.equal(strongOutline(f).length, 1); assert.equal(strongOutline(f)[0].dataset.path, 'b.tex')
  assert.ok(outlineButtons(f).filter(button => button.dataset.path === 'a.tex').every(button => !button.classList.contains('current-file')))
  f.ui.dispose()
})

test('a failed cross-file jump preserves the current heading and unsaved draft', async () => {
  const f = await fixture((action, args) => {
    if (action === 'latex_outline') return sectionOutline()
    if (action === 'latex_read') return { path: args.path, content: sectionText, revision: 'synthetic', bytes: sectionText.length, lines: 10 }
    if (action === 'latex_write') throw Object.assign(new Error('changed elsewhere'), { code: 'STATE_CONFLICT', current: { revision: 'other', content: 'external edit' } })
  })
  await f.ui.testHooks.gotoSource('a.tex', 4)
  const editor = f.ids.get('latex-editor'); editor.value += '\nMy unsaved synthetic draft'; await editor.dispatch('input')
  await f.ui.testHooks.gotoSource('b.tex', 1)
  assert.equal(f.ui.testHooks.state().file, 'a.tex'); assert.equal(strongOutline(f).length, 1)
  assert.equal(strongOutline(f)[0].dataset.path, 'a.tex'); assert.equal(strongOutline(f)[0].dataset.line, '4')
  assert.match(editor.value, /My unsaved synthetic draft$/); assert.equal(f.ui.testHooks.state().dirty, true)
  f.ui.dispose()
})

test('a late heading jump cannot steal highlight from a newer file', async () => {
  const pending = deferred()
  const f = await fixture((action, args) => {
    if (action === 'latex_outline') return sectionOutline()
    if (action === 'latex_read' && args.path === 'a.tex') return pending.promise
    if (action === 'latex_read') return { path: args.path, content: sectionText, revision: 'synthetic', bytes: sectionText.length, lines: 10 }
  })
  const earlier = f.ui.testHooks.gotoSource('a.tex', 4); await tick()
  await f.ui.testHooks.gotoSource('b.tex', 1)
  pending.resolve({ path: 'a.tex', content: sectionText, revision: 'late', bytes: sectionText.length, lines: 10 }); await earlier
  assert.equal(f.ui.testHooks.state().file, 'b.tex'); assert.equal(strongOutline(f).length, 1); assert.equal(strongOutline(f)[0].dataset.path, 'b.tex')
  f.ui.dispose()
})

test('UI accent follows DSH by default and saves presets, custom colour and reset', async () => {
  let preferences = { latex_accent: 'system', latex_auto_compile: false }, revision = 1
  const f = await fixture((action, args) => {
    if (action === 'settings_get') return { value: preferences, revision: String(revision) }
    if (action === 'settings_update') { preferences = { ...preferences, ...args.patch }; return { value: preferences, revision: String(++revision) } }
  })
  const root = f.ids.get('latex-view'), select = f.ids.get('latex-setting-accent'), colour = f.ids.get('latex-setting-accent-color')
  assert.equal(root.dataset.latexAccent, 'system'); assert.equal(select.value, 'system'); assert.equal(colour.hidden, true)
  select.value = '#4176e6'; await select.dispatch('change'); await tick()
  assert.equal(preferences.latex_accent, '#4176e6'); assert.equal(root.dataset.latexAccent, 'custom')
  select.value = 'custom'; await select.dispatch('change'); assert.equal(colour.hidden, false)
  colour.value = '#c13d82'; await colour.dispatch('change'); await tick()
  assert.equal(preferences.latex_accent, '#c13d82'); assert.equal(root.style['--latex-accent-color'], '#c13d82')
  select.value = 'system'; await select.dispatch('change'); await tick()
  assert.equal(preferences.latex_accent, 'system'); assert.equal(root.dataset.latexAccent, 'system'); assert.equal(colour.hidden, true)
  f.ui.dispose()
})

function savedReview(id = 'note-source', kind = 'source') {
  return { id, version: 'note-v1', status: 'open', text: 'Synthetic original excerpt', comment: 'Explain this saved annotation', stale: kind === 'pdf',
    anchor: kind === 'source' ? { kind, path: 'a.tex', line: 1, revision: 'revision', start: 0, end: 5, text: 'a.tex' } : { kind, page: 1, pdf_version: 'old-build', rects: [[1, 2, 10, 12]] } }
}
function reviewAiResponse(action, note) {
  const review_note = { id: note.id, version: note.version, kind: note.anchor.kind, stale: note.stale }, model = { provider: 'synthetic', model: 'small' }
  const entry = { kind: action === 'latex_ai_ask' ? 'ask' : 'proposal', created: 'synthetic-time', review_note, answer: 'Synthetic note-specific reply', summary: 'Synthetic revision', path: 'a.tex', model: 'synthetic/small' }
  if (action === 'latex_ai_ask') return { answer: entry.answer, model, material: {}, review_note, entry }
  return { changed: true, proposal: { id: 'note-proposal', path: 'a.tex', summary: entry.summary, replacements: [{ find: 'a.tex', replace: 'revised' }], model, review_note }, entry }
}

test('saved note actions use their own reference and source file instead of unrelated editor selection', async () => {
  const note = savedReview()
  const f = await fixture((action) => {
    if (action === 'latex_review_list') return { annotations: [note] }
    if (action === 'latex_ai_status') return { configured: true, entries: [] }
    if (action === 'models') return [{ provider: 'synthetic', id: 'small' }]
    if (action === 'latex_ai_ask') return reviewAiResponse(action, note)
  }, { review: true })
  await tick(); f.ids.get('latex-review-filter').value = 'open'; await f.ui.testHooks.reviewer().refresh()
  const editor = f.ids.get('latex-editor'); editor.setSelectionRange(0, 4)
  assert.equal(await f.ui.testHooks.reviewer().testHooks.runNote('ask', note), true)
  const request = f.calls.find(call => call.action === 'latex_ai_ask')
  assert.equal(request.path, 'a.tex'); assert.equal(request.review_note.id, note.id); assert.equal(request.review_note.version, note.version)
  assert.equal(Object.hasOwn(request, 'selection'), false)
  assert.match(f.ids.get('latex-review-list').textContent, /Synthetic note-specific reply/)
  assert.equal(f.calls.some(call => call.action === 'latex_write'), false)
  f.ui.dispose()
})

test('a historical PDF note explicitly targets current source and proposal acceptance opens the proposed file', async () => {
  const note = savedReview('note-pdf', 'pdf')
  const f = await fixture(action => {
    if (action === 'latex_review_list') return { annotations: [note] }
    if (action === 'latex_ai_status') return { configured: true, entries: [] }
    if (action === 'models') return [{ provider: 'synthetic', id: 'small' }]
    if (action === 'latex_ai_propose') return reviewAiResponse(action, note)
    if (action === 'latex_ai_accept') return { origin: 'ai:synthetic/small', written: { bytes: 20 } }
  }, { review: true })
  await tick(); f.ids.get('latex-review-filter').value = 'open'; await f.ui.testHooks.reviewer().refresh()
  assert.equal(await f.ui.testHooks.reviewer().testHooks.runNote('propose', note), true)
  const request = f.calls.find(call => call.action === 'latex_ai_propose')
  assert.equal(request.path, 'main.tex'); assert.equal(Object.hasOwn(request, 'selection'), false)
  assert.match(f.ids.get('latex-ai-proposal').textContent, /目标源码 a\.tex/)
  assert.equal(f.ids.get('latex-writing-history-body').hidden, false)
  await f.ids.get('latex-ai-accept').dispatch('click'); await tick()
  assert.equal(f.ui.testHooks.state().file, 'a.tex')
  f.ui.dispose()
})

test('late note answers cannot attach to a different writing project', async () => {
  const pending = deferred(), note = savedReview()
  const f = await fixture(action => {
    if (action === 'latex_review_list') return { annotations: [note] }
    if (action === 'latex_ai_status') return { configured: true, entries: [] }
    if (action === 'models') return [{ provider: 'synthetic', id: 'small' }]
    if (action === 'latex_ai_ask') return pending.promise
  }, { review: true })
  await tick(); f.ids.get('latex-review-filter').value = 'open'; await f.ui.testHooks.reviewer().refresh()
  const asking = f.ui.testHooks.reviewer().testHooks.runNote('ask', note); await tick()
  await f.ui.testHooks.setProject('two'); await tick()
  pending.resolve(reviewAiResponse('latex_ai_ask', note)); assert.equal(await asking, false)
  assert.doesNotMatch(f.ids.get('latex-review-list').textContent, /Synthetic note-specific reply/)
  const actions = f.ids.get('latex-review-list').querySelector('.latex-review-card-actions')
  assert.equal(actions.children[2].disabled, false)
  f.ui.dispose()
})

test('the source annotation composer saves a manual note with four actions', async () => {
  let notes = []
  const f = await fixture((action, args) => {
    if (action === 'latex_review_list') return { annotations: notes }
    if (action === 'latex_ai_status') return { configured: true, entries: [] }
    if (action === 'models') return [{ provider: 'synthetic', id: 'small' }]
    if (action === 'latex_review_put') { const note = { ...savedReview(), anchor: args.anchor, text: args.anchor.text, comment: args.comment }; notes = [note]; return { annotation: note } }
  }, { review: true })
  await tick(); f.ids.get('latex-review-filter').value = 'open'
  await f.ids.get('latex-source-note').dispatch('click')
  f.ids.get('latex-review-comment').value = 'Synthetic saved comment'
  await f.ids.get('latex-review-save').dispatch('click'); await tick()
  assert.equal(notes[0].comment, 'Synthetic saved comment'); assert.equal(notes[0].anchor.path, 'main.tex')
  assert.equal(f.ids.get('latex-review-composer').hidden, true)
  const actions = f.ids.get('latex-review-list').querySelector('.latex-review-card-actions')
  assert.deepEqual(actions.children.map(child => child.textContent), ['编辑', '解决', '问 DSH', '生成修改提案'])
  assert.equal(f.calls.some(call => call.action === 'latex_ai_ask' || call.action === 'latex_ai_propose'), false)
  f.ui.dispose()
})

test('an older collaboration status cannot erase a newly generated note proposal or its card entry', async () => {
  const status = deferred(), note = savedReview()
  const f = await fixture(action => {
    if (action === 'latex_review_list') return { annotations: [note] }
    if (action === 'latex_ai_status') return status.promise
    if (action === 'models') return [{ provider: 'synthetic', id: 'small' }]
    if (action === 'latex_ai_propose') return reviewAiResponse(action, note)
  }, { review: true })
  f.ids.get('latex-review-filter').value = 'open'; await f.ui.testHooks.reviewer().refresh()
  assert.equal(await f.ui.testHooks.reviewer().testHooks.runNote('propose', note), true)
  status.resolve({ configured: true, proposal: null, entries: [] }); await tick()
  assert.equal(f.ui.testHooks.state().ai.proposal, 'note-proposal')
  assert.match(f.ids.get('latex-review-list').textContent, /DSH 修改提案/)
  f.ui.dispose()
})

const writingAnswer = (answer = 'Synthetic writing answer', retrieval) => ({ answer, model: { provider: 'synthetic', model: 'small' }, entry: { kind: 'ask', answer, retrieval } })
const requestScope = call => JSON.parse(JSON.stringify(call.retrieval))

test('public queries require explicit one-use input and never fall back to the question or selected source', async () => {
  const note = savedReview()
  const f = await fixture(action => {
    if (action === 'latex_review_list') return { annotations: [note] }
    if (action === 'latex_ai_ask') return reviewAiResponse(action, note)
  }, { review: true })
  const local = f.ids.get('latex-retrieval-project'), external = f.ids.get('latex-retrieval-public'), queries = f.ids.get('latex-retrieval-queries')
  const reviewer = f.ui.testHooks.reviewer()
  await reviewer.refresh()
  assert.equal(local.checked, true); assert.equal(external.checked, false)
  assert.equal(f.ids.get('latex-retrieval-public-options').hidden, true)
  f.ids.get('latex-editor').setSelectionRange(0, 8)
  assert.equal(await reviewer.testHooks.runNote('ask', note), true)
  let requests = f.calls.filter(call => call.action === 'latex_ai_ask')
  assert.deepEqual(requestScope(requests[0]), { project: true, public_queries: [] })
  assert.equal(requests[0].review_note.id, note.id)
  assert.equal(Object.hasOwn(requests[0], 'selection'), false)
  await f.ids.get('latex-menu-open').dispatch('click')
  assert.equal(f.ids.get('latex-menu').hidden, false)
  local.checked = false; await local.dispatch('change')
  external.checked = true; await external.dispatch('change')
  assert.equal(f.ids.get('latex-retrieval-public-options').hidden, false)
  queries.value = '  synthetic graph theory  \n\nsynthetic networks'
  assert.equal(await reviewer.testHooks.runNote('ask', note), true)
  requests = f.calls.filter(call => call.action === 'latex_ai_ask')
  assert.deepEqual(requestScope(requests[1]), { project: false, public_queries: ['synthetic graph theory', 'synthetic networks'] })
  assert.equal(requests[1].question, requests[0].question)
  assert.equal(external.checked, false); assert.equal(queries.value, '')
  assert.equal(await reviewer.testHooks.runNote('ask', note), true)
  requests = f.calls.filter(call => call.action === 'latex_ai_ask')
  assert.deepEqual(requestScope(requests[2]), { project: false, public_queries: [] })
  assert.equal(f.calls.some(call => ['state_put', 'settings_update'].includes(call.action)), false)
  f.ui.dispose()
})

test('empty or over-limit public queries block the request without silently trimming away a line', async () => {
  const note = savedReview()
  const f = await fixture(action => action === 'latex_review_list' ? { annotations: [note] } : undefined, { review: true })
  const reviewer = f.ui.testHooks.reviewer()
  await reviewer.refresh()
  const external = f.ids.get('latex-retrieval-public'), queries = f.ids.get('latex-retrieval-queries');
  external.checked = true; await external.dispatch('change')
  for (const invalid of ['', 'one\ntwo\nthree\nfour', 'x'.repeat(201), 'invalid\tterm', '???']) {
    queries.value = invalid
    assert.equal(await reviewer.testHooks.runNote('ask', note), false)
    assert.equal(queries.value, invalid)
    assert.match(f.ids.get('latex-review-message').textContent, /公开检索词/)
  }
  assert.equal(f.calls.some(call => call.action === 'latex_ai_ask'), false)
  f.ui.dispose()
})

test('writing history displays earlier answers and proposals with their recorded provenance', async () => {
  const retrieval = {
    project: true, truncated: true, rounds: 2, calls: 3, used_tools: true,
    sources: [
      { id: 'F1', kind: 'file', path: 'sections/synthetic.tex', line: 4, end_line: 7, revision: 'file-rev', evidence_level: 'project-text', text: 'source content should not render' },
      { id: 'F2', kind: 'pdf', page: 3, pdf_version: 'pdf-version', evidence_level: 'project-text' },
      { id: 'S1', kind: 'scholar', title: 'Synthetic paper', authors: ['Alice Example'], year: 2025, doi: '10.1234/synthetic', url: 'https://doi.org/10.1234/synthetic', evidence_level: 'abstract', abstract: 'abstract text should not render' },
    ],
    trace: [{ name: 'search_project', status: 'ok', round: 1, args: { query: 'trace query should not render' } }, { name: 'scholar_search', status: 'ok', round: 2 }],
    public_search: { requested: 2, attempted: 2, outcomes: [{ index: 1, status: 'ok', providers: [{ provider: 'crossref', status: 'ok', count: 1 }] }, { index: 2, status: 'unavailable', providers: [{ provider: 'arxiv', status: 'error', count: 0 }] }] },
  }
  const note = savedReview()
  const f = await fixture(action => {
    if (action === 'latex_review_list') return { annotations: [note] }
    if (action === 'latex_ai_status') return { configured: true, entries: [writingAnswer('Evidence summary', retrieval).entry] }
    if (action === 'models') return [{ provider: 'synthetic', id: 'small' }]
    if (action === 'latex_ai_propose') {
      const response = reviewAiResponse(action, note)
      response.proposal.retrieval = retrieval
      return response
    }
  }, { review: true })
  await f.ids.get('latex-writing-history').dispatch('click'); await tick()
  const answer = f.ids.get('latex-writing-history-list')
  assert.match(answer.textContent, /Evidence summary/)
  assert.match(answer.textContent, /\[F1\]sections\/synthetic\.tex:4–7/)
  assert.match(answer.textContent, /第 3 页.*pdf-version/)
  assert.match(answer.textContent, /Alice Example.*2025.*10\.1234\/synthetic/)
  assert.match(answer.textContent, /题录或摘要；未读取论文全文/)
  assert.match(answer.textContent, /检索不可用/); assert.match(answer.textContent, /已截断/)
  assert.doesNotMatch(answer.textContent, /should not render/)
  assert.equal(answer.querySelector('a').href, 'https://doi.org/10.1234/synthetic')
  const reviewer = f.ui.testHooks.reviewer()
  await reviewer.refresh()
  assert.equal(await reviewer.testHooks.runNote('propose', note), true)
  assert.match(f.ids.get('latex-ai-proposal').textContent, /检索来源 · 3 条/)
  assert.deepEqual(requestScope(f.calls.find(call => call.action === 'latex_ai_propose')), { project: true, public_queries: [] })
  f.ui.dispose()
})

test('stop, project switch, workspace close and disposal abort in-flight writing calls and ignore late responses', async () => {
  let pending
  const note = savedReview()
  const f = await fixture(action => {
    if (action === 'latex_review_list') return { annotations: [note] }
    if (action === 'latex_ai_ask' || action === 'latex_ai_propose') { pending = deferred(); return pending.promise }
  }, { review: true })
  const stop = f.ids.get('latex-review-ai-stop')
  for (const [kind, leave] of [
    ['ask', () => stop.dispatch('click')],
    ['propose', () => f.ui.testHooks.setProject('two')],
    ['ask', () => f.ui.close()],
    ['ask', () => f.ui.dispose()],
  ]) {
    if (!f.ui.isOpen()) assert.equal(await f.ui.open('two'), true)
    const reviewer = f.ui.testHooks.reviewer()
    await reviewer.refresh()
    const running = reviewer.testHooks.runNote(kind, note); await tick()
    const request = f.calls.filter(call => call.action === `latex_ai_${kind}`).at(-1)
    assert.equal(stop.hidden, false); assert.equal(request.signal.aborted, false)
    await leave(); assert.equal(request.signal.aborted, true)
    pending.resolve(kind === 'propose' ? { changed: true, proposal: { id: 'late', path: 'main.tex', summary: 'Late proposal must not appear', replacements: [], model: { provider: 'synthetic', model: 'small' } } } : writingAnswer('Late result must not appear'))
    assert.equal(await running, false)
    assert.doesNotMatch(f.ids.get('latex-writing-history-list').textContent, /Late result/)
    assert.doesNotMatch(f.ids.get('latex-ai-proposal').textContent, /Late proposal/)
    if (f.ui.isOpen()) assert.equal(stop.hidden, true)
  }
})

test('a note-specific stop aborts its request and immediately re-enables the saved annotation actions', async () => {
  const pending = deferred(), note = savedReview()
  const f = await fixture(action => {
    if (action === 'latex_review_list') return { annotations: [note] }
    if (action === 'latex_ai_ask') return pending.promise
  }, { review: true })
  f.ids.get('latex-review-filter').value = 'open'; await f.ui.testHooks.reviewer().refresh()
  const asking = f.ui.testHooks.reviewer().testHooks.runNote('ask', note); await tick()
  const stop = f.ids.get('latex-review-ai-stop'); assert.equal(stop.hidden, false)
  await stop.dispatch('click')
  const request = f.calls.find(call => call.action === 'latex_ai_ask')
  assert.equal(request.signal.aborted, true); assert.equal(stop.hidden, true)
  assert.match(f.ids.get('latex-review-message').textContent, /已停止/)
  const row = f.ids.get('latex-review-list').querySelector('.latex-review-card-actions')
  assert.equal(row.children[2].disabled, false)
  pending.reject(Error('Late transport error')); assert.equal(await asking, false)
  assert.doesNotMatch(f.ids.get('latex-review-message').textContent, /Late transport error/)
  f.ui.dispose()
})
