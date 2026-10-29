import test from 'node:test'
import assert from 'node:assert/strict'
import { createTransitionGuard } from './transition.ts'

test('transition reserves before awaiting and never installs over a changed draft', async () => {
  const guard = createTransitionGuard()
  const owner = {}, expected = { owner, revision: 5, clean: true }
  let release
  const waiting = new Promise(resolve => { release = resolve })
  let installed = false
  async function delayedOpen() {
    assert.equal(guard.reserve(), true)
    try {
      await waiting
      if (guard.matches(expected, { owner, revision: 6, clean: false })) installed = true
    } finally { guard.release() }
  }
  const first = delayedOpen()
  assert.equal(guard.reserve(), false)
  release(); await first
  assert.equal(installed, false)
  assert.equal(guard.reserve(), true)
  assert.equal(guard.matches(expected, { owner: {}, revision: 5, clean: true }), false)
  assert.equal(guard.matches(expected, expected), true)
  guard.release()
})
