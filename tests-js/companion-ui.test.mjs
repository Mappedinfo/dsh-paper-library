import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../web/companion.js', import.meta.url), 'utf8')
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const plain = value => JSON.parse(JSON.stringify(value))

function fixture(t, request) {
  const calls = [], errors = [], timers = new Map(), cards = []
  let nextTimer = 0, paper = { id: 'paper-a', pdf: true }, enabled = false
  const toolbar = element()
  function element() {
    return {
      children: [], attributes: {}, events: {}, dataset: {},
      append(child) { child.parent = this; this.children.push(child) },
      remove() { this.parent.children = this.parent.children.filter(child => child !== this) },
      setAttribute(name, value) { this.attributes[name] = value },
      addEventListener(type, listener) { this.events[type] = listener },
      querySelector(selector) {
        const cls = selector.slice(selector.lastIndexOf('.') + 1)
        return this.children.find(child => child.className?.split(' ').includes(cls))
          || (!selector.startsWith(':scope') && this.children.map(child => child.querySelector(selector)).find(Boolean)) || null
      },
      click() {
        const event = { stopped: false, stopPropagation() { this.stopped = true } }
        this.events.click?.(event)
        return event
      },
    }
  }
  function addCard(annotationId, paperId = 'paper-a', companionText = 'true', annotationVersion) {
    const card = element(), actions = element()
    card.dataset = { annotationId, paperId, companionText, annotationVersion }
    actions.className = 'annotation-actions'; card.append(actions); cards.push(card)
    return card
  }
  const document = {
    createElement: element, getElementById: () => toolbar, querySelectorAll: () => cards,
    addEventListener() {}, removeEventListener() {},
  }
  const window = {}
  vm.runInNewContext(source, {
    window, document,
    setTimeout: run => { timers.set(++nextTimer, run); return nextTimer },
    clearTimeout: id => timers.delete(id),
  })
  const refreshed = []
  const ui = window.PaperCompanion.create({
    getPaper: () => paper,
    api: async (action, args) => { calls.push({ action, ...plain(args) }); return request?.(action, args) ?? { enabled, entries: [] } },
    persistence: { async patch(_key, value) { enabled = value['auto-paper-conversation'] } },
    refreshAnnotations: async id => { refreshed.push(id); return refreshed.length > 1 },
    toast: message => errors.push(message),
  })
  t.after(() => ui.dispose())
  return { ui, toolbar, calls, errors, addCard, refreshed, select: value => { paper = value; ui.sync() }, async poll() {
    for (const [id, run] of [...timers]) { timers.delete(id); run() }
    await tick()
  } }
}

test('the companion control keeps its label and exposes the saved switch state', async t => {
  const f = fixture(t)
  f.ui.applyPreferences({ 'auto-paper-conversation': false }, true)
  f.ui.setAvailable(true); await tick()
  const [toggle] = f.toolbar.children
  assert.equal(toggle.textContent, '实时伴学')
  assert.equal(toggle.attributes.role, 'switch')
  assert.equal(toggle.attributes['aria-checked'], 'false')
  toggle.click(); await tick()
  assert.equal(toggle.attributes['aria-checked'], 'true')
  assert.equal(toggle.textContent, '实时伴学')
})

test('manual ask runs with auto off, targets only the chosen card, and reloads the saved AI reply', async t => {
  const admitted = deferred()
  const queued = { annotation_id: 'second', request_id: 'request', manual: true, status: 'queued' }
  let entries = [{ ...queued, request_id: 'automatic', manual: false }]
  const f = fixture(t, action => action === 'companion_ask' ? admitted.promise : { enabled: false, entries })
  const first = f.addCard('first'), second = f.addCard('second', 'paper-a', 'true', 'a'.repeat(64))
  const blank = f.addCard('blank', 'paper-a', 'false')
  f.ui.setAvailable(true); await tick()
  const ask = second.querySelector('.companion-ask')
  assert.equal(ask.textContent, '问 DSH')
  assert.equal(ask.disabled, false, 'a paused automatic job still permits an explicit ask')
  assert.equal(blank.querySelector('.companion-ask').disabled, true)
  assert.equal(ask.click().stopped, true, 'asking does not jump to the page')
  ask.click()
  assert.deepEqual(f.calls.filter(call => call.action === 'companion_ask'), [{ action: 'companion_ask', id: 'paper-a', annotation_id: 'second', version: 'a'.repeat(64) }])
  assert.equal(first.querySelector('.companion-state'), null)
  assert.equal(ask.disabled, true)

  entries = [queued]; admitted.resolve(queued); await tick()
  assert.match(second.querySelector('.companion-state').children[0].textContent, /已排队/)
  assert.equal(ask.disabled, true)
  entries = [{ ...queued, status: 'saved' }]
  await f.poll()
  assert.deepEqual(f.refreshed, ['paper-a'])
  await f.poll()
  assert.deepEqual(f.refreshed, ['paper-a', 'paper-a'], 'a failed PDF readback is retried after saving')
  assert.match(second.querySelector('.companion-state').children[0].textContent, /AI 批注已保存/)
  assert.deepEqual(f.errors, [])
})

test('a failed request retries the same identity and a card from another paper cannot ask', async t => {
  let entries = [{ annotation_id: 'first', request_id: 'failed', manual: true, status: 'failed', error: 'fixture failure' }]
  const f = fixture(t, action => action === 'companion_retry' ? { status: 'queued' } : { enabled: false, entries })
  const first = f.addCard('first'), next = f.addCard('first', 'paper-b')
  f.ui.setAvailable(true); await tick()
  const stale = first.querySelector('.companion-ask')
  assert.equal(stale.disabled, true)
  first.querySelector('.companion-state').children.find(child => child.textContent === '重试').click()
  assert.deepEqual(f.calls.filter(call => call.action === 'companion_retry'), [{ action: 'companion_retry', id: 'paper-a', request_id: 'failed' }])
  entries = []
  f.select({ id: 'paper-b', pdf: true }); await tick(); await f.poll()
  assert.equal(first.querySelector('.companion-ask'), null)
  assert.equal(next.querySelector('.companion-ask').disabled, false)
  stale.click()
  assert.equal(f.calls.some(call => call.action === 'companion_ask'), false)
})
