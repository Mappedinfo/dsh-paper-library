import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { bindReturnToDsh } from '../src/client/return-to-dsh.mjs'

test('only the current same-origin iframe may hide its own host tab', () => {
  const listeners = new Map(), target = {}, calls = []
  let mounted = 'session-a'
  const window = { location: { origin: 'https://synthetic.invalid' }, addEventListener: (type, callback) => listeners.set(type, callback), removeEventListener: type => listeners.delete(type) }
  const dispose = bindReturnToDsh({ window, target, tabId: 'tab-a', sessionId: 'session-a', sidebar: { mounted: { getSnapshot: () => mounted }, hide: id => calls.push(id) } })
  const send = (source = target, origin = window.location.origin, data = { type: 'paper-library:return-to-dsh', version: 1 }) => listeners.get('message')({ source, origin, data })
  send({}, window.location.origin); send(target, 'https://other.invalid'); send(target, window.location.origin, { type: 'paper-library:return-to-dsh', version: 2 })
  mounted = 'session-b'; send(); assert.deepEqual(calls, [])
  mounted = 'session-a'; send(); assert.deepEqual(calls, ['tab-a'])
  dispose(); assert.equal(listeners.has('message'), false)
})

test('return waits for successful draft protection and never acts standalone', async () => {
  const code = readFileSync(new URL('../web/return-to-dsh.js', import.meta.url), 'utf8'), sent = []
  const parent = { postMessage: (...args) => sent.push(args) }
  const window = { parent, location: { origin: 'https://synthetic.invalid', pathname: '/' } }
  let click, allowed = false
  const button = { setAttribute() {}, addEventListener: (_, callback) => { click = callback } }
  const document = { createElement: () => button }
  vm.runInNewContext(code, { window, document })
  window.PaperReturnToDsh.create({ host: { prepend() {} }, prepare: async () => allowed })
  await click(); assert.equal(sent.length, 0)
  allowed = true; await click(); assert.equal(sent.length, 1); assert.equal(sent[0][0].type, 'paper-library:return-to-dsh'); assert.equal(sent[0][1], window.location.origin)
  window.parent = window; assert.equal(window.PaperReturnToDsh.create({ host: {}, prepare: () => true }), null)
})

test('a top-level DSH plugin page returns to the same-origin host only after preparation', async () => {
  const code = readFileSync(new URL('../web/return-to-dsh.js', import.meta.url), 'utf8'), navigations = []
  let click, allowed = false
  const window = { location: { origin: 'https://synthetic.invalid', pathname: '/api/paper-library/', assign: value => navigations.push(value) } }; window.parent = window
  const document = { createElement: () => ({ setAttribute() {}, addEventListener: (_, callback) => { click = callback } }) }
  vm.runInNewContext(code, { window, document })
  assert.ok(window.PaperReturnToDsh.create({ host: { prepend() {} }, prepare: async () => allowed }))
  await click(); assert.deepEqual(navigations, [])
  allowed = true; await click(); assert.deepEqual(navigations, ['/'])
  window.location.pathname = '/'; assert.equal(window.PaperReturnToDsh.create({ host: {}, prepare: () => true }), null)
})

test('Slides keeps its save guard for the top-level DSH route and embedded tabs', async () => {
  const source = readFileSync(new URL('../src/slides/main.tsx', import.meta.url), 'utf8')
  const start = source.indexOf('  const returnToDsh = async () => {'), end = source.indexOf('  const reloadLatest =', start)
  assert.ok(start >= 0 && end > start)
  const calls = [], location = { pathname: '/api/paper-library/slides.html', origin: 'https://synthetic.invalid', assign: value => calls.push(['navigate', value]) }
  const window = {}; window.parent = window
  let canLeave = false
  const context = { window, location, document: { fullscreenElement: null }, reserveSwitch: () => true, canSwitch: async () => canLeave, endSwitch() {}, setPresent() {}, setMessage() {} }
  const snippet = source.slice(start, end).replace('catch (error: any)', 'catch (error)')
  vm.runInNewContext(`${snippet}\nglobalThis.go = returnToDsh`, context)
  await context.go(); assert.deepEqual(calls, [])
  canLeave = true; await context.go(); assert.deepEqual(calls, [['navigate', '/']])
  window.parent = { postMessage: (message, origin) => calls.push(['message', message.type, origin]) }
  await context.go(); assert.deepEqual(calls.at(-1), ['message', 'paper-library:return-to-dsh', location.origin])
  window.parent = window; location.pathname = '/slides.html'; await context.go(); assert.equal(calls.length, 2)
})

test('library return checks the active workbench and preserves the page after a save failure', async () => {
  const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8')
  const start = source.indexOf('let returningToDsh = false;'), end = source.indexOf('for(const host of [', start)
  assert.ok(start >= 0 && end > start)
  const errors = [], state = { active: null }, document = { body: { inert: false }, fullscreenElement: null }
  let boardSaved = true, latexOpen = false, flushFails = false, chatCalls = 0
  const context = { state, document, readerPaperId: null, annotationSaveBusy: false, restoringReader: false, restoringInkDraft: false, inkSaveBusy: false, inkDraftStorageBlocked: false,
    pdfReader: { isInking: () => false }, handwritingUI: { isOpen: () => false },
    boardUI: { isOpen: () => true, prepareLeave: async () => boardSaved },
    latexUI: { isOpen: () => latexOpen, close: async () => {} },
    publishReaderState: () => true, paperChatUI: { saveDraft: async () => { chatCalls++ } },
    persistence: { flush: async () => { if (flushFails) throw new Error('synthetic failure') } }, toast: value => errors.push(value) }
  vm.runInNewContext(source.slice(start, end), context)
  assert.equal(await context.prepareReturnToDsh(), true, 'empty library returns without requiring a paper chat')
  assert.equal(chatCalls, 0)
  boardSaved = false; assert.equal(await context.prepareReturnToDsh(), false)
  boardSaved = true; latexOpen = true; assert.equal(await context.prepareReturnToDsh(), false, 'an unresolved LaTeX draft blocks return')
  latexOpen = false; flushFails = true; assert.equal(await context.prepareReturnToDsh(), false)
  assert.match(errors.at(-1), /草稿仍在当前页面/); assert.equal(document.body.inert, false)
})
