import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../web/latex-versions.js', import.meta.url), 'utf8')
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const version = (id, project = 'one') => ({ id, project_id: project, project_title: project, created: '2026-01-01T00:00:00Z', main_path: 'main.tex', engine: 'xelatex', source_count: 1, review_count: 0 })

function fixture(override = () => undefined) {
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.className = ''; this.events = new Map(); this.dataset = {}; this.hidden = false; this.disabled = false; this.value = '' }
    set textContent(value) { this.text = String(value); this.children = [] }
    get textContent() { return this.text || this.children.map(child => child.textContent).join('') }
    append(...nodes) { for (const child of nodes) { child.parentNode = this; this.children.push(child) } }
    setAttribute(key, value) { this[key] = value }
    addEventListener(type, callback) { const callbacks = this.events.get(type) || []; callbacks.push(callback); this.events.set(type, callbacks) }
    click() { if (!this.disabled && !this.hidden) for (const callback of this.events.get('click') || []) callback({ target: this }) }
    querySelector(selector) { return this.children.find(child => selector[0] === '.' ? child.className.split(/\s+/).includes(selector.slice(1)) : child.tagName === selector) || this.children.map(child => child.querySelector(selector)).find(Boolean) || null }
  }
  let selection = { id: 'one' }
  const calls = [], root = new Element('section'), document = { createElement: tag => new Element(tag) }, window = {}
  const api = async (action, args) => {
    calls.push({ action, ...args }); const result = override(action, args)
    if (result !== undefined) return result
    if (action === 'latex_version_list') return { versions: [version(`${args.id}-v1`, args.id)], total: 1 }
    if (action === 'latex_version_get') return { review_pdfs: [], sources: [] }
    if (action === 'latex_version_review') return { annotations: [] }
    throw Error(`unexpected ${action}`)
  }
  vm.runInNewContext(source, { window, document, Option: function(text, value) { const node = new Element('option'); node.textContent = text; node.value = value; return node } })
  const ui = window.PaperLatexVersions.create({ root, api, scope: () => selection, openVersion: () => {} })
  return { ui, calls, root, refresh: root.children[0], message: root.children[1], list: root.children[2], more: root.children[3], scope: value => { selection = value } }
}

test('clear resets paging and controls; a late old page cannot append into the next writer project', async () => {
  const oldPage = deferred()
  const f = fixture((action, args) => {
    if (action === 'latex_version_list' && args.id === 'one') return args.offset ? oldPage.promise : { versions: Array.from({ length: 20 }, (_, index) => version(`old-${index}`)), total: 30 }
  })
  await f.ui.refresh(); assert.equal(f.more.hidden, false)
  const loading = f.ui.refresh(true); assert.equal(f.refresh.disabled, true)
  f.scope(null); f.ui.clear()
  assert.equal(f.list.children.length, 0); assert.equal(f.more.hidden, true); assert.equal(f.more.disabled, false); assert.equal(f.refresh.disabled, false)
  assert.match(f.message.textContent, /当前写作项目/)
  oldPage.resolve({ versions: [version('late')], total: 30 }); await loading
  assert.equal(f.list.children.length, 0)
  assert.match(f.message.textContent, /当前写作项目/)
  f.scope({ id: 'two' }); await f.ui.refresh(true)
  assert.deepEqual(f.calls.filter(call => call.action === 'latex_version_list').map(call => [call.id, call.offset]), [['one', 0], ['one', 20], ['two', 0]])
  assert.deepEqual(f.list.children.map(card => card.dataset.versionId), ['two-v1'])
  assert.equal(f.more.hidden, true)
})

test('changing scope resets append offsets even without a separate clear and no-scope refresh remains recoverable', async () => {
  const f = fixture((action, args) => action === 'latex_version_list' && args.id === 'one' ? { versions: [version('old')], total: 2 } : undefined)
  await f.ui.refresh(); f.scope({ id: 'two' }); await f.ui.refresh(true)
  assert.equal(f.calls.at(-1).offset, 0)
  assert.deepEqual(f.list.children.map(card => card.dataset.versionId), ['two-v1'])
  f.scope(null); await f.ui.refresh()
  assert.equal(f.refresh.disabled, false); assert.equal(f.more.hidden, true)
  assert.match(f.message.textContent, /当前写作项目/)
})

test('late version details failures cannot replace the status of the next project', async () => {
  const detail = deferred()
  const f = fixture(action => action === 'latex_version_get' ? detail.promise : undefined)
  await f.ui.refresh()
  const button = f.list.children[0].children[2].children[1]; button.click(); await tick()
  f.scope({ id: 'two' }); f.ui.clear(); await f.ui.refresh()
  const status = f.message.textContent
  detail.reject(Error('old version failed')); await tick()
  assert.equal(f.message.textContent, status)
  assert.equal(f.calls.some(call => call.action === 'latex_version_review'), false)
  assert.equal(f.list.children[0].querySelector('.latex-version-detail'), null)
})

test('late review responses are discarded before details can attach to a replacement list', async () => {
  const reviews = deferred()
  const f = fixture(action => action === 'latex_version_review' ? reviews.promise : undefined)
  await f.ui.refresh()
  const oldCard = f.list.children[0], button = oldCard.children[2].children[1]; button.click(); await tick()
  f.scope({ id: 'two' }); f.ui.clear(); await f.ui.refresh()
  reviews.resolve({ annotations: [{ id: 'old', comment: 'Old note' }] }); await tick()
  assert.equal(oldCard.querySelector('.latex-version-detail'), null)
  assert.equal(f.list.children[0].querySelector('.latex-version-detail'), null)
  assert.match(f.message.textContent, /共 1/)
})

test('unchanged version IDs still update pagination visibility and restore controls', async () => {
  let total = 2
  const f = fixture(action => action === 'latex_version_list' ? { versions: [version('same')], total } : undefined)
  await f.ui.refresh(); const card = f.list.children[0]; assert.equal(f.more.hidden, false)
  total = 1; await f.ui.refresh()
  assert.equal(f.list.children[0], card)
  assert.equal(f.more.hidden, true); assert.equal(f.more.disabled, false); assert.equal(f.refresh.disabled, false)
})
