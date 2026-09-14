import test from 'node:test'
import assert from 'node:assert/strict'
import { bindModelContext, modelContext } from '../src/client/model-context.mjs'

function environment() {
  const listeners = new Set()
  const messages = []
  const target = { postMessage: (value, origin) => messages.push({ value, origin }) }
  const window = { location: { origin: 'http://localhost:3080' }, addEventListener: (_type, listener) => listeners.add(listener), removeEventListener: (_type, listener) => listeners.delete(listener) }
  let state = { current: { provider: 'configured-provider', model: 'selected-model', secret: 'must-not-cross' }, routable: true, status: 'ready' }
  const subscribers = new Set()
  const directory = { store: { getSnapshot: () => state, subscribe: listener => { subscribers.add(listener); return () => subscribers.delete(listener) } }, load: async () => state }
  return { window, target, directory, messages, listeners, subscribers, update: next => { state = next; for (const subscriber of [...subscribers]) subscriber() } }
}

test('composer model updates reach the same iframe without navigation or credential fields', async () => {
  const fixture = environment()
  const dispose = bindModelContext({ ...fixture, sessionId: 'session-a' })
  await Promise.resolve()
  const first = fixture.messages.at(-1).value
  assert.equal(first.model, 'selected-model')
  assert.equal(first.provider, 'configured-provider')
  assert.equal(first.sessionId, 'session-a')
  assert.equal(Object.hasOwn(first, 'secret'), false)
  fixture.update({ current: { provider: 'other-provider', model: 'new-model', reasoningEffort: 'high' }, routable: true, status: 'ready' })
  assert.equal(fixture.messages.at(-1).value.model, 'new-model')
  assert.equal(fixture.messages.at(-1).value.reasoningEffort, 'high')
  dispose()
})

test('handshake requires the exact iframe window, same origin and supported message version', () => {
  const fixture = environment()
  const dispose = bindModelContext({ ...fixture, sessionId: 'session-a' })
  const listener = [...fixture.listeners][0]
  const before = fixture.messages.length
  const data = { type: 'paper-library:ready', version: 1 }
  listener({ source: {}, origin: fixture.window.location.origin, data })
  listener({ source: fixture.target, origin: 'https://attacker.invalid', data })
  listener({ source: fixture.target, origin: fixture.window.location.origin, data: { ...data, version: 2 } })
  assert.equal(fixture.messages.length, before)
  listener({ source: fixture.target, origin: fixture.window.location.origin, data })
  assert.equal(fixture.messages.length, before + 1)
  assert.equal(fixture.messages.at(-1).origin, fixture.window.location.origin)
  dispose()
})

test('session disposal clears old route and prevents old subscriber or ready message restoring it', async () => {
  const old = environment()
  const dispose = bindModelContext({ ...old, sessionId: 'session-a' })
  const lateSubscriber = [...old.subscribers][0]
  const lateMessage = [...old.listeners][0]
  dispose()
  assert.equal(old.messages.at(-1).value.sessionId, null)
  assert.equal(old.messages.at(-1).value.provider, null)
  assert.equal(old.messages.at(-1).value.model, null)
  const after = old.messages.length
  lateSubscriber()
  lateMessage({ source: old.target, origin: old.window.location.origin, data: { type: 'paper-library:ready', version: 1 } })
  await Promise.resolve()
  assert.equal(old.messages.length, after)
  assert.equal(old.subscribers.size, 0)
  assert.equal(old.listeners.size, 0)
  const current = environment()
  const stopCurrent = bindModelContext({ ...current, sessionId: 'session-b' })
  assert.equal(current.messages.at(-1).value.sessionId, 'session-b')
  stopCurrent()
})

test('loading, unavailable and switching contexts explicitly clear prior route', () => {
  for (const state of [null, { current: null }, { current: { provider: 'p', model: 'm' }, status: 'selecting' }, { current: { provider: 'p', model: 'm' }, routable: false }]) {
    const result = modelContext('session', state)
    assert.equal(result.provider, null)
    assert.equal(result.model, null)
  }
  assert.equal(modelContext(null, { current: { provider: 'p', model: 'm' } }).status, 'unavailable')
})
