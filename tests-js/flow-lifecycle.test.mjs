import test from 'node:test'
import assert from 'node:assert/strict'
import { bindFlowWindow, retainFlowFrame } from '../src/client/flow-lifecycle.mjs'
import { bindFlowUnloadGuard } from '../src/paper-flow/unload.mjs'

function mockWindow() {
  const listeners = new Map()
  return { location: { origin: 'https://synthetic.invalid' }, addEventListener: (type, handler) => listeners.set(type, handler), removeEventListener: (type, handler) => { if (listeners.get(type) === handler) listeners.delete(type) }, dispatch: (type, event) => listeners.get(type)?.(event), listeners }
}

test('only the current iframe can toggle retained flow state, including while hidden', () => {
  const window = mockWindow(), first = {}, second = {}, changes = []; let frame = { contentWindow: first }
  const dispose = bindFlowWindow({ window, getFrame: () => frame, onChange: value => changes.push(value) })
  const send = (source, data, origin = window.location.origin) => window.dispatch('message', { source, data, origin })
  const message = active => ({ type: 'paper-library:flow-window', version: 1, active })
  send({}, message(true)); send(first, message(true), 'https://other.invalid'); send(first, { ...message(true), version: 2 }); send(first, message('true'))
  assert.deepEqual(changes, [])
  send(first, message(true)); frame = { contentWindow: second }; send(first, message(false)); send(second, message(false))
  assert.deepEqual(changes, [true, false]); dispose(); send(second, message(true)); assert.deepEqual(changes, [true, false])
})

test('hidden PDFs are released while active flows and Slides retain their iframe', () => {
  assert.equal(retainFlowFrame({ visible: false, slides: false, flowActive: false }), false)
  assert.equal(retainFlowFrame({ visible: false, slides: false, flowActive: true }), true)
  assert.equal(retainFlowFrame({ visible: false, slides: true, flowActive: false }), true)
  assert.equal(retainFlowFrame({ visible: true, slides: false, flowActive: false }), true)
})

test('page unload warns for every unsaved condition and unregisters on disposal', () => {
  const window = mockWindow(); let snapshot = { dirty: false, saving: false, invalid: false, blocked: false }
  const dispose = bindFlowUnloadGuard({ window, state: () => snapshot })
  const event = () => ({ prevented: false, returnValue: undefined, preventDefault() { this.prevented = true } })
  let e = event(); window.dispatch('beforeunload', e); assert.equal(e.prevented, false)
  for (const key of ['dirty', 'saving', 'invalid', 'blocked']) {
    snapshot = { dirty: false, saving: false, invalid: false, blocked: false, [key]: true }
    e = event(); window.dispatch('beforeunload', e); assert.equal(e.prevented, true, key); assert.equal(e.returnValue, '')
  }
  dispose(); e = event(); window.dispatch('beforeunload', e); assert.equal(e.prevented, false)
})
