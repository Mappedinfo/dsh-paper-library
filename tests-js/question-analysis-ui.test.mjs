import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

class Element {
  constructor(tag, document) { this.tagName = tag; this.document = document; this.children = []; this.listeners = {}; this.attributes = {}; this.className = ''; this.hidden = false; this.disabled = false; this.checked = false; this.value = ''; this._text = ''; this._html = ''; this.classList = { toggle: () => {} } }
  set id(value) { this._id = value; this.document.ids.set(value, this) }
  get id() { return this._id }
  set textContent(value) { this._text = String(value ?? ''); this.children = [] }
  get textContent() { return this._text + this.children.map(child => child.textContent).join('') }
  set innerHTML(value) {
    this._html = String(value)
    for (const match of this._html.matchAll(/<([a-z]+)\b[^>]*\bid="([^"]+)"[^>]*>/gi)) {
      const child = new Element(match[1], this.document); child.id = match[2]; this.children.push(child)
    }
  }
  get innerHTML() { return this._html }
  append(...values) { for (const value of values) this.children.push(typeof value === 'string' ? Object.assign(new Element('#text', this.document), { _text: value }) : value) }
  replaceChildren(...values) { this.children = []; this._text = ''; this.append(...values) }
  setAttribute(name, value) { this.attributes[name] = String(value) }
  addEventListener(name, fn) { this.listeners[name] = fn }
}

function documentFixture() {
  const document = { ids: new Map(), hidden: false, listeners: {}, createElement(tag) { return new Element(tag, this) }, getElementById(id) { return this.ids.get(id) }, addEventListener(name, fn) { this.listeners[name] = fn }, removeEventListener(name) { delete this.listeners[name] } }
  document.body = new Element('body', document)
  const tools = new Element('div', document); tools.id = 'paper-tools'; document.body.append(tools)
  return document
}

async function settle() { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)) }

test('question analysis UI renders partial answers and errors as text, never HTML', async () => {
  const document = documentFixture(), window = {}
  vm.runInNewContext(readFileSync(new URL('../web/paper-analysis.js', import.meta.url), 'utf8'), { window, document, setTimeout, clearTimeout, crypto: { randomUUID: () => 'synthetic' } })
  const malicious = '<img src=x onerror="alert(1)">'
  const job = {
    id: 'synthetic-paper', request_id: 'synthetic-job', status: 'partial', stage: 'partial review',
    coverage: { read_pages: [1], completed_pages: [1], requested_pages: [1, 2], page_count: 2, characters: 50, full_document: false, blank_pages: [], no_extractable_text_pages: [2] },
    question_coverage: { complete: false, by_question: { q1: { answered_batches: 0, expected_batches: 1, failed_batches: [0], unread_batches: [] } } },
    batch_answers: [{ question_id: 'q1', choice: 'method', valid: false, judgment: malicious,
      evidence: [{ page: 1, quote: malicious }], errors: [{ message: 'Synthetic quote validation failed.' }] }],
    question_results: [{ question_ids: ['q1', 'q2'], errors: [{ code: 'MODEL_REQUEST_FAILED', message: 'Synthetic group failed.' }] }],
  }
  const ui = window.PaperAnalysis.create({
    state: { active: { id: job.id, pdf: true, title: 'Synthetic paper' } },
    api: async action => action === 'paper_analysis_get' ? job : {},
    persistence: { async get() { return {} }, async patch() {}, async flush() {} },
    toast() {}, prepareChat() {}, openKnowledge() {}, metadataChanged() {},
  })
  await ui.setAvailable(true); await settle()
  const result = document.getElementById('analysis-result')
  assert.match(result.textContent, /问题尚未全部完成/)
  assert.match(result.textContent, /q1：0\/1 批已回答；失败批次 1/)
  assert.match(result.textContent, /引用或格式未通过/)
  assert.match(result.textContent, /Synthetic quote validation failed/)
  assert.match(result.textContent, /Synthetic group failed/)
  assert.ok(result.textContent.includes(malicious), 'untrusted strings appear as literal text')
  const dynamicElements = []
  const walk = element => { dynamicElements.push(element); for (const child of element.children) walk(child) }
  walk(result)
  assert.ok(dynamicElements.every(element => element.innerHTML === ''), 'no answer or error content was assigned through innerHTML')
  ui.dispose()
})
