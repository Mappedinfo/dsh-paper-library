import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyModelHttpError, isFatalModelError } from '../src/model-errors.mjs'

test('provider quota and authentication failures have fixed fatal classifications', () => {
  for (const [status, body] of [
    [403, JSON.stringify({ error: { type: 'permission_error', message: "You've reached your 5-hour usage limit." } })],
    [402, JSON.stringify({ error: { code: 'quota_exhausted', message: 'Usage quota exhausted' } })],
    [402, JSON.stringify({ error: { message: 'Payment Required' } })],
    [402, ''],
    [429, JSON.stringify({ error: { code: 'insufficient_quota', message: 'quota exhausted' } })],
    [429, JSON.stringify({ error: { message: 'The account usage limit has been reached.' } })],
  ]) {
    const code = classifyModelHttpError('kimi', status, body)
    assert.equal(code, 'DIRECT_MODEL_QUOTA_EXHAUSTED')
    assert.equal(isFatalModelError({ code }), true)
  }
  const auth = classifyModelHttpError('glm', 401, JSON.stringify({ error: { message: 'invalid api key' } }))
  assert.equal(auth, 'DIRECT_MODEL_AUTH_ERROR')
  assert.equal(isFatalModelError({ code: auth }), true)
})

test('ordinary throttling and server errors stay nonfatal even if body mentions quota', () => {
  for (const [status, body, expected] of [
    [429, JSON.stringify({ error: { type: 'rate_limit_error', message: 'too many requests' } }), 'DIRECT_MODEL_RATE_LIMITED'],
    [500, JSON.stringify({ error: { message: 'quota backend unavailable' } }), 'DIRECT_MODEL_HTTP_ERROR'],
    [403, JSON.stringify({ error: { type: 'permission_error', message: 'forbidden' } }), 'DIRECT_MODEL_AUTH_ERROR'],
  ]) {
    const code = classifyModelHttpError('glm', status, body)
    assert.equal(code, expected)
    assert.equal(isFatalModelError({ code }), expected === 'DIRECT_MODEL_AUTH_ERROR')
  }
})
