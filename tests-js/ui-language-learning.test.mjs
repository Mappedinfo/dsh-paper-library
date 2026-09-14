import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
const script = await readFile(new URL('../web/language-learning.js', import.meta.url), 'utf8')
const clone = value => JSON.parse(JSON.stringify(value))
const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function fixture({ get, put, respond } = {}) {
  const elements = new Map(), requests = [], writes = [], storage = new Map(), toasts = [], chats = []
  let currentPaper = null, selection = null, serial = 0
  class Element {
    constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = new Map(); this.value = ''; this.hidden = false; this.disabled = false; this.dataset = {}; this.classList = { toggle() {} } }
    set id(value) { this._id = value; if (value) elements.set(value, this) } get id() { return this._id }
    set textContent(value) { this.text = String(value); this.children = [] } get textContent() { return this.text || '' }
    append(...nodes) { for (const node of nodes) { this.children.push(node); node.parentElement = this } }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes) }
    replaceWith(node) { const parent = this.parentElement; parent.children.splice(parent.children.indexOf(this), 1, node); node.parentElement = parent }
    setAttribute() {} focus() {}
    addEventListener(type, fn) { const listeners = this.listeners.get(type) || []; listeners.push(fn); this.listeners.set(type, listeners) }
    async dispatch(type) { for (const fn of this.listeners.get(type) || []) await fn({ preventDefault() {} }) }
  }
  const element = id => { if (!elements.has(id)) { const node = new Element(); node.id = id; if (id === 'language-target') node.value = 'zh-CN' } return elements.get(id) }
  const document = { body: new Element('body'), createElement: tag => new Element(tag), getElementById: element }
  const window = { crypto: { randomUUID: () => `request-${++serial}` } }
  vm.runInNewContext(script, { window, document, setTimeout, clearTimeout, navigator: { clipboard: { writeText: async () => {} } }, URL, Blob }, { filename: 'web/language-learning.js' })
  const result = args => ({ id: `result-${args.request_id}`, request_id: args.request_id, paper_id: args.id, page: args.page || null, mode: args.mode, source_text: args.text, result: 'Synthetic translated result', explanation: 'Synthetic explanation', model: { provider: 'dsh', model: 'current' }, vocabulary: [], status: 'complete' })
  const ui = window.PaperLanguageLearning.create({
    api: async (action, args) => { requests.push({ action, ...clone(args) }); const value = respond?.(action, args, result); if (value !== undefined) return value; return action === 'language_generate' ? result(args) : { items: [], total: 0 } },
    persistence: { get: async key => get ? get(key) : clone(storage.get(key) || null), put: async (key, value) => { writes.push({ key, value: clone(value) }); if (put) await put(key, value); storage.set(key, clone(value)) }, flush: async () => {} },
    getPaper: () => currentPaper, getSelection: () => selection, toast: text => toasts.push(text), prepareChat: (...args) => chats.push(args),
  })
  ui.setAvailable(true)
  return { ui, element, requests, writes, storage, toasts, chats, result,
    async open(id) { currentPaper = { id, title: id }; return ui.paperChanged(currentPaper) },
    setCurrent(id) { currentPaper = id ? { id, title: id } : null; ui.sync() },
    select(text = 'Selected PDF source.', page = 2) { selection = { id: currentPaper.id, text, page } },
    async type(text) { element('language-source').value = text; await element('language-source').dispatch('input') },
    async click(id) { await element(id).dispatch('click'); await tick() },
    async settle() { for (let i = 0; i < 20 && ui.snapshot().busy; i++) await tick() },
  }
}

test('selection action waits for the shared paper draft read and cannot be overwritten by its late response', async () => {
  const load = deferred(); let reads = 0
  const f = fixture({ get: () => { reads++; return load.promise } })
  const opening = f.open('paper-a'); f.select(); const translating = f.ui.useSelection('translate')
  assert.equal(f.element('language-source').disabled, true); assert.equal(f.requests.length, 0)
  load.resolve({ text: 'Previous durable draft.', target_language: 'en' }); await opening; await translating
  assert.equal(reads, 1); assert.equal(f.requests[0].text, 'Selected PDF source.'); assert.equal(f.requests[0].page, 2)
  assert.equal(f.element('language-source').value, 'Selected PDF source.')
})

test('request identity write is awaited before the model request begins', async () => {
  const durable = deferred(); const f = fixture({ put: () => durable.promise })
  await f.open('paper-a'); await f.type('Text to translate.'); await f.click('language-translate')
  assert.equal(f.requests.length, 0); durable.resolve(); await f.settle()
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].request_id, f.writes.find(row => row.value.failed_request)?.value.failed_request.request_id)
})

test('editing while generation runs preserves new draft and does not render the stale result as current', async () => {
  const generated = deferred(); let args; const f = fixture({ respond: (action, input) => { if (action === 'language_generate') { args = input; return generated.promise } } })
  await f.open('paper-a'); await f.type('Original request.'); await f.click('language-translate'); await f.type('New unsent draft.')
  generated.resolve(f.result(args)); await f.settle()
  assert.equal(f.element('language-source').value, 'New unsent draft.'); assert.equal(f.ui.snapshot().lastResultId, undefined)
  assert.equal(f.storage.get('language-draft:paper-a').failed_request, null); assert.equal(f.toasts.length, 1)
})

test('A to B to A navigation invalidates the previous generation response', async () => {
  const generated = deferred(); let args; const f = fixture({ respond: (action, input) => { if (action === 'language_generate') { args = input; return generated.promise } } })
  await f.open('paper-a'); await f.type('Original A source.'); await f.click('language-translate')
  await f.open('paper-b'); await f.type('B draft.'); await f.open('paper-a'); await f.type('New A draft.')
  generated.resolve(f.result(args)); await f.settle()
  assert.equal(f.element('language-source').value, 'New A draft.'); assert.equal(f.ui.snapshot().lastResultId, undefined)
  assert.equal(f.storage.get('language-draft:paper-b').text, 'B draft.')
})

test('uncertain network retry keeps request identity but terminal failure permits a new explicit invocation', async () => {
  let count = 0
  const f = fixture({ respond: action => {
    if (action !== 'language_generate') return
    if (++count === 1) throw new Error('Synthetic lost response')
    if (count === 2) throw Object.assign(new Error('Synthetic terminal failure'), { code: 'LANGUAGE_FAILED', retry_with_new_request: true })
  } })
  await f.open('paper-a'); await f.type('Retry source.')
  for (let i = 0; i < 3; i++) { await f.click('language-translate'); await f.settle() }
  assert.equal(f.requests[0].request_id, f.requests[1].request_id); assert.notEqual(f.requests[1].request_id, f.requests[2].request_id)
})

test('late history response cannot overwrite another active view status', async () => {
  const history = deferred(), f = fixture({ respond: action => action === 'language_history' ? history.promise : undefined })
  await f.open('paper-a'); f.ui.show('history'); f.ui.show('work'); f.element('language-status').textContent = 'Current status'
  history.resolve({ items: [], total: 0 }); await tick()
  assert.equal(f.element('language-status').textContent, 'Current status')
})

test('paper authority prevents stale generation and sending another paper result into current chat', async () => {
  const f = fixture(); await f.open('paper-a'); await f.type('Source A.'); await f.click('language-translate'); await f.settle()
  f.setCurrent('paper-b'); assert.equal(f.element('language-translate').disabled, true)
  await f.click('language-discuss'); await f.click('language-translate')
  assert.equal(f.chats.length, 0); assert.equal(f.requests.length, 1)
  f.setCurrent('paper-a'); await f.click('language-discuss')
  assert.equal(f.chats[0][1].paperId, 'paper-a')
})
