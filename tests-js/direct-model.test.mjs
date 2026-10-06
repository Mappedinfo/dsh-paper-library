import test from 'node:test'
import assert from 'node:assert/strict'
import { createDirectModelAgent } from '../src/direct-model.mjs'

function response(payload, status = 200, headers = {}) {
  return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), { status, headers })
}

const glmResult = (content = '{"title":"A paper"}', finish_reason = 'stop') => ({
  choices: [{ finish_reason, message: { content } }], usage: { prompt_tokens: 12, completion_tokens: 4 },
})
const kimiResult = (text = '{"title":"A paper"}', stop_reason = 'end_turn') => ({
  content: [{ type: 'text', text }], stop_reason, usage: { input_tokens: 9, output_tokens: 3 },
})

test('GLM uses fixed OpenAI endpoint, disabled thinking and bounded JSON text', async () => {
  let request
  const agent = await createDirectModelAgent({ provider: 'glm', model: 'glm-4.7-flash', keyEnv: 'GLM_KEY' }, {
    env: { GLM_KEY: 'secret' }, fetchImpl: async (url, init) => { request = { url, init }; return response(glmResult()) },
  })
  assert.equal(await agent({ prompt: 'Return JSON' }), '{"title":"A paper"}')
  assert.equal(request.url, 'https://open.bigmodel.cn/api/paas/v4/chat/completions')
  assert.equal(request.init.redirect, 'manual')
  assert.equal(request.init.headers.authorization, 'Bearer secret')
  assert.match(request.init.headers['user-agent'], /dsh-paper-library/)
  assert.deepEqual(JSON.parse(request.init.body).thinking, { type: 'disabled' })
  assert.deepEqual(agent.model, { provider: 'glm', model: 'glm-4.7-flash' })
  assert.deepEqual(agent.usage(), { calls: 1, input_tokens: 12, output_tokens: 4, failures: 0 })
})

test('Kimi uses fixed Anthropic endpoint and unwraps only a single answer object', async () => {
  let request
  const agent = await createDirectModelAgent({ provider: 'kimi', model: 'kimi-for-coding', keyEnv: 'KIMI_KEY' }, {
    env: { KIMI_KEY: 'secret' }, fetchImpl: async (url, init) => { request = { url, init }; return response(kimiResult('{"answer":{"title":"A paper"}}')) },
  })
  assert.equal(await agent({ prompt: 'Return JSON' }), '{"title":"A paper"}')
  assert.equal(request.url, 'https://api.kimi.com/coding/v1/messages')
  assert.equal(request.init.headers['x-api-key'], 'secret')
  assert.equal(request.init.headers['anthropic-version'], '2023-06-01')
  assert.equal(JSON.parse(request.init.body).stream, false)
  assert.deepEqual(JSON.parse(request.init.body).thinking, { type: 'disabled' })
  assert.deepEqual(agent.usage(), { calls: 1, input_tokens: 9, output_tokens: 3, failures: 0 })
})

test('explicit env file takes precedence and accepts export/quoted comment syntax', async t => {
  const fs = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'direct-model-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, '.env')
  await fs.writeFile(file, 'OTHER_KEY=ignored\nexport WANTED=\'only-this\' # selected value\nCOMMAND=$(not-evaluated)\n')
  let authorization
  const agent = await createDirectModelAgent({ provider: 'glm', model: 'glm-4.7-flash', keyEnv: 'WANTED', envFile: file }, {
    env: { WANTED: 'stale-environment-value' }, fetchImpl: async (_url, init) => { authorization = init.headers.authorization; return response(glmResult()) },
  })
  await agent({ prompt: 'ok' })
  assert.equal(authorization, 'Bearer only-this')
})

test('env file rejects duplicate assignments, expansion syntax, whitespace and oversized files', async t => {
  const fs = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'direct-model-invalid-env-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, '.env')
  for (const contents of [
    'WANTED=one\nexport WANTED=two\n',
    'WANTED=$(command)\n',
    'WANTED=${OTHER}\n',
    'WANTED=two words\n',
  ]) {
    await fs.writeFile(file, contents)
    await assert.rejects(createDirectModelAgent({ provider: 'glm', model: 'm', keyEnv: 'WANTED', envFile: file }, { env: { WANTED: 'must-not-win' }, fetchImpl: async () => response(glmResult()) }), { code: 'DIRECT_MODEL_ENV_FILE_INVALID' })
  }
  await fs.writeFile(file, 'WANTED=x'.padEnd(1024 * 1024 + 1, 'z'))
  await assert.rejects(createDirectModelAgent({ provider: 'glm', model: 'm', keyEnv: 'WANTED', envFile: file }, { env: {}, fetchImpl: async () => response(glmResult()) }), { code: 'DIRECT_MODEL_ENV_FILE_INVALID' })
})

test('effective provider, model and key source cannot change after construction begins', async () => {
  const config = { provider: 'glm', model: 'glm-4.7-flash', keyEnv: 'KEY' }
  let request
  const creating = createDirectModelAgent(config, { env: { KEY: 'original-key' }, fetchImpl: async (url, init) => { request = { url, init }; return response(glmResult()) } })
  config.provider = 'kimi'
  config.model = 'other-model'
  config.keyEnv = 'OTHER_KEY'
  const agent = await creating
  assert.deepEqual(agent.model, { provider: 'glm', model: 'glm-4.7-flash' })
  await agent({ prompt: 'ok' })
  assert.equal(request.url, 'https://open.bigmodel.cn/api/paas/v4/chat/completions')
  assert.equal(request.init.headers.authorization, 'Bearer original-key')
  const body = JSON.parse(request.init.body)
  assert.equal(body.model, 'glm-4.7-flash')
  assert.deepEqual(body.response_format, { type: 'json_object' })
})

test('maxCalls is atomic across concurrent calls and every attempt consumes budget', async () => {
  let entered = 0
  const agent = await createDirectModelAgent({ provider: 'glm', model: 'm', keyEnv: 'K', maxCalls: 2 }, {
    env: { K: 'x' }, fetchImpl: async () => { entered++; await new Promise(resolve => setTimeout(resolve, 5)); return response(glmResult()) },
  })
  const results = await Promise.allSettled([agent({ prompt: '1' }), agent({ prompt: '2' }), agent({ prompt: '3' })])
  assert.equal(entered, 2)
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 2)
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'DIRECT_MODEL_BUDGET_EXHAUSTED')
  assert.deepEqual(agent.usage(), { calls: 2, input_tokens: 24, output_tokens: 8, failures: 0 })
})

test('HTTP, redirect, incomplete and malformed output errors are sanitized', async () => {
  for (const [mock, code, status] of [
    [async () => response('private body with secret', 429), 'DIRECT_MODEL_HTTP_ERROR', 429],
    [async () => response('', 302, { location: 'https://elsewhere.invalid' }), 'DIRECT_MODEL_REDIRECT_REFUSED', 302],
    [async () => response(glmResult('{"x":1}', 'length')), 'DIRECT_MODEL_INCOMPLETE', 502],
    [async () => response(glmResult('not json')), 'DIRECT_MODEL_INVALID_OUTPUT', 502],
  ]) {
    const agent = await createDirectModelAgent({ provider: 'glm', model: 'm', keyEnv: 'K' }, { env: { K: 'sensitive-key' }, fetchImpl: mock })
    await assert.rejects(agent({ prompt: 'ok' }), error => error.code === code && error.status === status && !error.message.includes('private') && !error.message.includes('sensitive-key'))
    assert.equal(agent.usage().failures, 1)
  }
})

test('route mismatch and oversized prompts reject before consuming call budget', async () => {
  const agent = await createDirectModelAgent({ provider: 'glm', model: 'm', keyEnv: 'K', maxCalls: 1 }, { env: { K: 'x' }, fetchImpl: async () => response(glmResult()) })
  await assert.rejects(agent({ prompt: 'ok', model: 'other' }), { code: 'DIRECT_MODEL_ROUTE_MISMATCH' })
  await assert.rejects(agent({ prompt: 'x'.repeat(128 * 1024 + 1) }), { code: 'DIRECT_MODEL_PROMPT_INVALID' })
  assert.equal(agent.usage().calls, 0)
})

test('unknown token usage stays null and tool calls are refused', async () => {
  const agent = await createDirectModelAgent({ provider: 'glm', model: 'm', keyEnv: 'K' }, {
    env: { K: 'x' }, fetchImpl: async () => response({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{}] } }] }),
  })
  await assert.rejects(agent({ prompt: 'ok' }), { code: 'DIRECT_MODEL_INCOMPLETE' })
  assert.deepEqual(agent.usage(), { calls: 1, input_tokens: null, output_tokens: null, failures: 1 })
})

test('accepts one JSON code fence, refuses key disclosure, and honors cancellation before success', async () => {
  const fenced = await createDirectModelAgent({ provider: 'glm', model: 'm', keyEnv: 'K' }, {
    env: { K: 'private-key' }, fetchImpl: async () => response(glmResult('```json\n{"title":"A paper"}\n```')),
  })
  assert.equal(await fenced({ prompt: 'ok' }), '{"title":"A paper"}')
  const leak = await createDirectModelAgent({ provider: 'glm', model: 'm', keyEnv: 'K' }, {
    env: { K: 'private-key' }, fetchImpl: async () => response(glmResult('{"title":"private-key"}')),
  })
  await assert.rejects(leak({ prompt: 'ok' }), { code: 'DIRECT_MODEL_OUTPUT_CONTAINS_SECRET' })
  const escapedLeak = await createDirectModelAgent({ provider: 'glm', model: 'm', keyEnv: 'K' }, {
    env: { K: 'private-key' }, fetchImpl: async () => response(glmResult('{"title":"\\u0070rivate-key"}')),
  })
  await assert.rejects(escapedLeak({ prompt: 'ok' }), { code: 'DIRECT_MODEL_OUTPUT_CONTAINS_SECRET' })
  const controller = new AbortController()
  const cancelled = await createDirectModelAgent({ provider: 'glm', model: 'm', keyEnv: 'K' }, {
    env: { K: 'x' }, fetchImpl: async () => { await new Promise(resolve => setTimeout(resolve, 10)); return response(glmResult()) },
  })
  const pending = cancelled({ prompt: 'ok', signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, { code: 'DIRECT_MODEL_ABORTED' })
})
