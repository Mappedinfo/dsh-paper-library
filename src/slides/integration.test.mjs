/** Headless DOM test; provide JSDOM_MODULE when jsdom is not installed in this project. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { createDeckTemplate, PresentationBriefSchema } from '../../lib/plaindeck-core.mjs'

const require = createRequire(import.meta.url)
let JSDOM
try { ({ JSDOM } = require(process.env.JSDOM_MODULE || 'jsdom')) } catch { /* optional DOM runtime */ }
const until = async (predicate, label) => {
  for (let attempt = 0; attempt < 250; attempt++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  throw new Error(`Timed out: ${label}`)
}
test('deep link opens its slide, serializes revisions, and retains a conflict draft on navigation', { skip: !JSDOM }, async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1/slides.html?project=pd-00000000000000000000000000000000', runScripts: 'outside-only', pretendToBeVisual: true })
  const window = dom.window, calls = [], errors = []
  window.structuredClone = structuredClone
  window.ResizeObserver = class { observe() {} disconnect() {} }
  const project = { id: 'pd-00000000000000000000000000000000', title: '合成项目', slide_count: 1, updated_at: '2026-01-01' }
  const document = createDeckTemplate('blank', { title: project.title, lang: 'zh' })
  let releaseFirst
  const first = new Promise(resolve => { releaseFirst = resolve })
  window.addEventListener('error', event => errors.push(event.error?.message || event.message))
  window.fetch = async (_url, init) => {
    const input = JSON.parse(init.body); calls.push(input)
    let result
    if (input.action === 'slides_list') result = { projects: [project], next_offset: null }
    else if (input.action === 'slides_get') result = { project, document, revision: 'rev-1' }
    else if (input.action === 'slides_save') {
      const saves = calls.filter(call => call.action === 'slides_save')
      if (saves.length === 1) { await first; result = { project, revision: 'rev-2' } }
      else if (saves.length === 2) result = { project, revision: 'rev-3' }
      else return { ok: false, status: 409, json: async () => ({ ok: false, error: '其他窗口已修改', code: 'STATE_CONFLICT' }) }
    } else throw new Error(`Unexpected ${input.action}`)
    return { ok: true, json: async () => ({ ok: true, result }) }
  }
  try {
    window.eval(await readFile(new URL('../../lib/slides-editor.js', import.meta.url), 'utf8'))
    await until(() => window.document.querySelector('button[aria-label="添加文本"]'), 'editor opened')
    assert.equal(calls.find(call => call.action === 'slides_list').limit, 50)
    assert.equal(calls.find(call => call.action === 'slides_get').id, project.id)
    const add = window.document.querySelector('button[aria-label="添加文本"]')
    add.click()
    await until(() => calls.filter(call => call.action === 'slides_save').length === 1, 'first save')
    add.click(); releaseFirst()
    await until(() => calls.filter(call => call.action === 'slides_save').length === 2, 'second save')
    const saves = calls.filter(call => call.action === 'slides_save')
    assert.equal(saves[0].expected_revision, 'rev-1'); assert.equal(saves[1].expected_revision, 'rev-2')
    assert.equal(saves[1].document.slides[saves[1].document.deck.slides[0]].elements.length, saves[0].document.slides[saves[0].document.deck.slides[0]].elements.length + 1)
    await until(() => window.document.querySelector('.save-pill.saved'), 'saved state')
    add.click()
    await until(() => window.document.querySelector('.slides-save-warning'), 'conflict message')
    assert.match(window.document.querySelector('.slides-save-warning').textContent, /草稿保留/)
    window.dispatchEvent(new window.MessageEvent('message', { origin: window.location.origin, source: window, data: { type: 'paper-library:open-slide-project', id: 'pd-' + '1'.repeat(32) } }))
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(calls.filter(call => call.action === 'slides_get').length, 1, 'a conflicted draft blocks deep-link navigation')
    assert.ok(window.document.querySelector('.slides-save-warning'), 'the unsaved draft remains visible')
    window.document.querySelector('button[aria-label="打开演示项目"]').click()
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(window.document.querySelector('.slides-chooser'), null)
    assert.equal(errors.length, 0, errors.join('\n'))
  } finally { dom.window.close() }
})

test('guidance persists consecutive brief edits with the returned revision', { skip: !JSDOM }, async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1/slides.html', runScripts: 'outside-only', pretendToBeVisual: true })
  const window = dom.window, calls = []
  window.structuredClone = structuredClone
  window.ResizeObserver = class { observe() {} disconnect() {} }
  const project = { id: 'pd-00000000000000000000000000000000', title: '合成项目', slide_count: 1, updated_at: '2026-01-01' }
  const document = createDeckTemplate('blank', { title: project.title, lang: 'zh' })
  let releaseFirst
  const first = new Promise(resolve => { releaseFirst = resolve })
  window.fetch = async (_url, init) => {
    const input = JSON.parse(init.body); calls.push(input); let result
    if (input.action === 'slides_list') result = { projects: [project], next_offset: null }
    else if (input.action === 'slides_get') result = { project, document, revision: 'deck' }
    else if (input.action === 'slides_brief_get') result = { value: PresentationBriefSchema.parse({}), revision: '0' }
    else if (input.action === 'slides_brief_save') {
      const count = calls.filter(call => call.action === 'slides_brief_save').length
      if (count === 1) await first
      result = { value: input.value, revision: `brief-${count}` }
    } else throw new Error(`Unexpected ${input.action}`)
    return { ok: true, json: async () => ({ ok: true, result }) }
  }
  try {
    window.eval(await readFile(new URL('../../lib/slides-editor.js', import.meta.url), 'utf8'))
    await until(() => window.document.querySelector('.slides-projects button'), 'project list')
    window.document.querySelector('.slides-projects button').click()
    await until(() => window.document.querySelector('.guide-action'), 'editor opened')
    window.document.querySelector('.guide-action').click()
    await until(() => window.document.querySelector('.slides-guide fieldset:not(:disabled)'), 'brief loaded')
    const textarea = window.document.querySelector('.slides-guide textarea')
    const change = value => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(textarea, value)
      textarea.dispatchEvent(new window.Event('input', { bubbles: true }))
    }
    change('第一条目的')
    await until(() => calls.filter(call => call.action === 'slides_brief_save').length === 1, 'first brief save')
    change('更新后的目的'); releaseFirst()
    await until(() => calls.filter(call => call.action === 'slides_brief_save').length === 2, 'second brief save')
    const saves = calls.filter(call => call.action === 'slides_brief_save')
    assert.equal(saves[0].expected_revision, '0'); assert.equal(saves[1].expected_revision, 'brief-1')
    assert.equal(saves[1].value.purpose, '更新后的目的')
    await until(() => window.document.querySelector('.slides-guide-actions [role="status"]').textContent.includes('已保存'), 'brief saved')
  } finally { dom.window.close() }
})
