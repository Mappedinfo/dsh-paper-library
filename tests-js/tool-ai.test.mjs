import test from 'node:test'
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHarnessToolAI } from '../src/harness/tool-ai.mjs'

// Exercise the boundary against synthetic provider streams. The real host
// supplies these public protocol helpers; no provider/account is contacted.
class FixtureAssembler {
  content = []
  push(chunk) {
    if (chunk.type === 'block-end') this.content.push(chunk.block)
    if (chunk.type === 'finish') this.replayState = chunk.replayState
  }
  blocks() { return this.content }
}
const factories = {
  BlockAssembler: FixtureAssembler,
  createUserMessage: input => ({ ...input, role: 'user' }),
  createAssistantMessage: input => ({ ...input, role: 'assistant' }),
  createToolResultMessage: ({ callId, ...input }) => ({ ...input, role: 'tool', toolCallId: callId }),
  assertSupportedJsonSchema: schema => assert.equal(schema.properties.query_index?.type, 'integer'),
  validateJsonSchemaValue: (schema, args) => args && Object.keys(args).length === 1
    && schema.properties.query_index.enum.includes(args.query_index) ? [] : ['invalid query index'],
}
const tools = [{ name: 'scholar_search', description: 'Use one explicitly supplied public query.',
  parameters: { type: 'object', additionalProperties: false, required: ['query_index'], properties: { query_index: { type: 'integer', enum: [1, 2] } } } }]
const textBlock = text => ({ type: 'text', text })
const request = (id, args = '{"query_index":1}', name = 'scholar_search') => ({ type: 'tool-call', id, name, arguments: args })
const end = (kind, blocks = [], replayState) => [...blocks.map((block, index) => ({ type: 'block-end', index, block })),
  { type: 'finish', reason: { kind }, replayState }]
const feedback = text => end('stop', [textBlock(text)])

function fixture(turns, { prepared = true, helpers = factories, network } = {}) {
  const sent = []
  const preparations = []
  const resolved = []
  async function* stream(options) {
    const turn = turns[sent.length]
    sent.push(options)
    assert.ok(turn, 'unexpected model round')
    const result = typeof turn === 'function' ? await turn(options) : turn
    if (result instanceof Error) throw result
    yield* result
  }
  const llm = prepared ? {
    async prepareCall(config, signal) {
      preparations.push({ config, signal })
      return { config: { ...config, temperature: 0 }, stream }
    },
  } : { stream, async resolveModelInfo(provider, model) { resolved.push([provider, model]) } }
  const ai = createHarnessToolAI(llm, helpers, { provider: 'synthetic', model: 'fake', maxOutputTokens: 1024 }, { network })
  const executed = []
  const run = options => ai({ prompt: '核对相关证据', tools, requireToolUse: true,
    executeTool(name, args) { executed.push({ name, args }); return { ok: true, source_id: 'S1', excerpt: 'synthetic evidence' } }, ...options })
  return { run, executed, sent, preparations, resolved }
}

test('native tool exchange keeps assistant reasoning, replay and the matching tool result', async () => {
  const replayState = { response: { model: 'fake' }, blocks: [{ signature: 'fake' }, null] }
  const reasoning = { type: 'reasoning', text: 'Choose a public query.' }
  const call = request('call-a')
  const { run, sent, executed, preparations } = fixture([
    end('tool-calls', [reasoning, call], replayState), feedback('证据 [S1]'),
  ])
  const result = await run({ reasoningEffort: 'low' })
  assert.equal(result.text, '证据 [S1]')
  assert.deepEqual(executed, [{ name: 'scholar_search', args: { query_index: 1 } }])
  assert.deepEqual(sent[0].tools, tools)
  assert.equal(preparations.length, 2)
  assert.equal(preparations[0].config.reasoningEffort, 'low')
  assert.equal(sent[1].temperature, 0)
  assert.deepEqual(sent[1].messages.map(message => message.role), ['user', 'assistant', 'tool'])
  assert.deepEqual(sent[1].messages[1].content, [reasoning, call])
  assert.deepEqual(sent[1].messages[1].source, { provider: 'synthetic', model: 'fake', replayState })
  assert.equal(sent[1].messages[2].toolCallId, 'call-a')
  assert.equal(sent[1].messages[2].isError, false)
  assert.equal(JSON.parse(sent[1].messages[2].content[0].text).source_id, 'S1')
  assert.equal(result.usedTools, true)
  assert.deepEqual(Object.keys(result.trace[0]).sort(), ['name', 'result_characters', 'round', 'status'])
  assert.equal(JSON.stringify(result.trace).includes('synthetic evidence'), false)
})

test('invalid arguments never dispatch, and a later valid read can recover', async () => {
  const { run, sent, executed, resolved } = fixture([
    end('tool-calls', [request('a', 'not-json'), request('b', '{"query_index":3}'), request('c', '{"query_index":2,"url":"secret"}')]),
    end('tool-calls', [request('d', '{"query_index":2}')]), feedback('根据 [S1] 回答'),
  ], { prepared: false })
  const result = await run()
  assert.deepEqual(resolved, [['synthetic', 'fake']])
  assert.deepEqual(executed, [{ name: 'scholar_search', args: { query_index: 2 } }])
  for (const message of sent[1].messages.slice(2)) {
    assert.equal(message.role, 'tool')
    assert.equal(message.isError, true)
    assert.equal(JSON.parse(message.content[0].text).error.code, 'INVALID_ARGUMENTS')
  }
  assert.deepEqual(result.trace.map(item => item.status), ['error', 'error', 'error', 'ok'])
  assert.equal(result.calls, 4)
})

test('an unknown tool invalidates the complete batch before any dispatch', async () => {
  const { run, executed } = fixture([end('tool-calls', [request('a'), request('b', '{}', 'shell')])])
  await assert.rejects(run(), { code: 'TOOL_AI_UNKNOWN_TOOL' })
  assert.deepEqual(executed, [])
})

test('invalid schemas or unpaired/duplicate call identities fail closed', async () => {
  const bad = fixture([])
  await assert.rejects(bad.run({ tools: [{ ...tools[0], parameters: { ...tools[0].parameters, additionalProperties: true } }] }), { code: 'TOOL_AI_SCHEMA' })
  assert.equal(bad.sent.length, 0)
  for (const blocks of [[request('dup'), request('dup')], [], [request('')]]) {
    const { run, executed } = fixture([end('tool-calls', blocks)])
    await assert.rejects(run(), { code: 'TOOL_AI_INCOMPLETE' })
    assert.deepEqual(executed, [])
  }
})

test('the last model turn has no tools and keeps the earlier evidence', async () => {
  const { run, sent, executed } = fixture([end('tool-calls', [request('a')]), feedback('根据 [S1] 回答')])
  const result = await run({ maxRounds: 2 })
  assert.equal(sent[1].tools, undefined)
  assert.equal(sent[1].messages[2].role, 'tool')
  assert.match(sent[1].messages.at(-1).content[0].text, /不再调用工具/)
  assert.equal(result.limits.exhausted, true)
  assert.equal(result.rounds, 2)
  assert.equal(executed.length, 1)
  const retry = fixture([end('tool-calls', [request('a')]), end('tool-calls', [request('b')])])
  await assert.rejects(retry.run({ maxRounds: 2 }), { code: 'TOOL_AI_INCOMPLETE' })
  assert.equal(retry.executed.length, 1)
})

test('a batch over the remaining call budget is omitted without replaying orphan calls', async () => {
  const { run, sent, executed } = fixture([
    end('tool-calls', [request('a')]), end('tool-calls', [request('b'), request('c')]), feedback('根据 [S1] 回答'),
  ])
  const result = await run({ maxCalls: 2 })
  assert.equal(result.calls, 1)
  assert.equal(result.limits.exhausted, true)
  assert.equal(executed.length, 1)
  assert.equal(sent[2].tools, undefined)
  assert.equal(sent[2].messages.filter(message => message.role === 'assistant').length, 1)
  assert.equal(sent[2].messages.filter(message => message.role === 'tool').length, 1)
})

test('large results remain valid JSON within the aggregate model context budget', async () => {
  const { run, sent } = fixture([
    end('tool-calls', Array.from({ length: 5 }, (_, i) => request(`call-${i}`))), feedback('按有限证据回答'),
  ])
  const allowances = []
  const result = await run({ executeTool(_name, _args, { maxResultCharacters }) {
    allowances.push(maxResultCharacters)
    return { ok: true, excerpt: '文\n"\\'.repeat(15_000) }
  } })
  const results = sent[1].messages.filter(message => message.role === 'tool').map(message => message.content[0].text)
  assert.equal(results.length, 5)
  assert.equal(allowances.length, 4)
  assert.ok(allowances[3] < allowances[0])
  assert.equal(result.truncated, true)
  assert.equal(result.limits.exhausted, true)
  assert.equal(result.limits.result_characters, results.reduce((sum, text) => sum + text.length, 0))
  assert.ok(result.limits.result_characters <= 32_000)
  for (const text of results.slice(0, 4)) {
    assert.ok(text.length <= 8_000)
    const envelope = JSON.parse(text)
    assert.equal(envelope.truncated, true)
    assert.ok(envelope.omitted_characters > 0)
    assert.equal(typeof envelope.content, 'string')
  }
  assert.equal(JSON.parse(results[4]).error.code, 'RESULT_BUDGET')
})

test('a bounded result can declare its own truncation without being rewrapped', async () => {
  const { run, sent } = fixture([end('tool-calls', [request('a')]), feedback('根据 [S1] 回答')])
  const source = { ok: true, source_id: 'S1', truncated: true, excerpt: 'part of a source' }
  const result = await run({ executeTool() { return source } })
  assert.deepEqual(JSON.parse(sent[1].messages[2].content[0].text), source)
  assert.equal(result.truncated, true)
  assert.equal(result.trace[0].truncated, true)
})

test('no-call or failed retrieval is not reported as verified research', async () => {
  const plain = fixture([feedback('I did not search.')])
  await assert.rejects(plain.run(), { code: 'TOOL_AI_NO_RETRIEVAL' })
  const optional = fixture([feedback('I did not search.')])
  assert.equal((await optional.run({ requireToolUse: false })).usedTools, false)
  for (const executeTool of [() => ({ ok: false, status: 'unavailable' }), () => { throw new Error('private provider details') }]) {
    const failure = fixture([end('tool-calls', [request('a')]), feedback('I could not search.')])
    await assert.rejects(failure.run({ executeTool }), { code: 'TOOL_AI_NO_RETRIEVAL' })
    assert.equal(failure.sent[1].messages[2].isError, true)
    assert.doesNotMatch(failure.sent[1].messages[2].content[0].text, /private provider details/)
  }
})

test('a partial or failed response cannot dispatch tools or save final text', async () => {
  for (const [turn, code] of [[end('max-tokens', [request('a')]), 'TOOL_AI_TRUNCATED'], [end('error', [textBlock('partial')]), 'TOOL_AI_PROVIDER_ERROR'], [end('tool-calls', [request('a')]).slice(0, -1), 'TOOL_AI_INCOMPLETE']]) {
    const { run, executed } = fixture([turn])
    await assert.rejects(run(), { code })
    assert.deepEqual(executed, [])
  }
})

test('cancellation interrupts a stuck tool and prevents subsequent calls', async () => {
  const { run, sent } = fixture([end('tool-calls', [request('a'), request('b')])])
  const caller = new AbortController()
  let started
  const invoking = new Promise(resolve => { started = resolve })
  let executions = 0
  const pending = run({ signal: caller.signal, executeTool(_name, _args, { signal }) {
    executions++
    started(signal)
    return new Promise(() => {})
  } })
  const activeSignal = await invoking
  caller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(activeSignal.aborted, true)
  assert.equal(executions, 1)
  assert.equal(sent.length, 1)
})

test('all native writing turns and reads inherit the configured request-local network route', async () => {
  const scope = new AsyncLocalStorage(); let runs = 0
  const network = { run(callback) { runs++; return scope.run('writing-route', callback) } }
  const f = fixture([
    () => { assert.equal(scope.getStore(), 'writing-route'); return end('tool-calls', [request('network-a')]) },
    () => { assert.equal(scope.getStore(), 'writing-route'); return feedback('已核对 [S1]') },
  ], { network })
  const result = await f.run({ executeTool() { assert.equal(scope.getStore(), 'writing-route'); return { ok: true, source_id: 'S1' } } })
  assert.equal(result.usedTools, true); assert.equal(runs, 1); assert.equal(scope.getStore(), undefined)
})

test('a transient failure retries only the unfinished turn and never repeats completed tool reads', async () => {
  const disconnect = Object.assign(Error('fetch failed: SYNTHETIC_PRIVATE_PROVIDER_TEXT'), { cause: Object.assign(Error('disconnected'), { code: 'ECONNRESET' }) })
  async function* partial() { yield* end('tool-calls', [request('partial')]).slice(0, -1); throw disconnect }
  const f = fixture([partial(), end('tool-calls', [request('complete')]), disconnect, feedback('已核对 [S1]')])
  const result = await f.run({ maxRounds: 2 })
  assert.equal(result.retries, 2); assert.equal(result.rounds, 2); assert.equal(result.calls, 1); assert.equal(f.executed.length, 1)
  assert.equal(f.sent.length, 4); assert.equal(f.preparations.length, 4)
  assert.deepEqual(f.sent[0].messages, f.sent[1].messages)
  assert.equal(f.sent[2].messages.filter(m => m.role === 'tool').length, 1)
  assert.deepEqual(f.sent[2].messages, f.sent[3].messages)
  assert.equal(f.sent[3].messages.filter(m => m.role === 'assistant')[0].content[0].id, 'complete')
})

test('permanent network failure stops after one retry with keyless diagnostics', async () => {
  const failure = end('error'); failure.at(-1).reason.failure = { code: 'TRANSPORT', message: 'DeepSeek Messages transport failed SYNTHETIC_SECRET https://private.invalid/?token=synthetic' }
  const f = fixture([failure, failure])
  await assert.rejects(f.run(), error => error.code === 'TOOL_AI_NETWORK' && error.status === 503 && !/SYNTHETIC_SECRET|private.invalid|token=/.test(error.message))
  assert.equal(f.sent.length, 2); assert.equal(f.executed.length, 0)
})

test('authentication, quota, rate limits and unsupported tools do not retry or masquerade as protocol failures', async () => {
  for (const [failure, code] of [
    [{ code: 'AUTH', status: 401, message: 'SYNTHETIC_SECRET' }, 'TOOL_AI_AUTH'],
    [{ code: 'QUOTA', status: 403, message: 'insufficient_quota SYNTHETIC_SECRET' }, 'TOOL_AI_QUOTA'],
    [{ code: 'RATE_LIMIT', status: 429, message: 'SYNTHETIC_SECRET' }, 'TOOL_AI_RATE_LIMITED'],
    [{ code: 'BAD_REQUEST', status: 400, message: 'tools not supported SYNTHETIC_SECRET' }, 'TOOL_AI_TOOLS_UNSUPPORTED'],
    [{ code: 'UNSUPPORTED_REASONING_EFFORT', message: 'SYNTHETIC_SECRET' }, 'TOOL_AI_REASONING_EFFORT'],
    [{ code: 'CONTEXT_WINDOW_EXCEEDED', message: 'SYNTHETIC_SECRET' }, 'TOOL_AI_CONTEXT_LIMIT'],
    [{ code: 'UNKNOWN_MODEL', message: 'SYNTHETIC_SECRET' }, 'TOOL_AI_MODEL_REQUIRED'],
    [{ code: 'ACCOUNT_QUOTA', message: 'SYNTHETIC_SECRET' }, 'TOOL_AI_QUOTA'],
    [{ code: 'RATE_LIMIT', message: 'SYNTHETIC_SECRET' }, 'TOOL_AI_RATE_LIMITED'],
  ]) {
    const chunks = end('error'); chunks.at(-1).reason.failure = failure
    const f = fixture([chunks]); await assert.rejects(f.run(), error => error.code === code && !error.message.includes('SYNTHETIC_SECRET'))
    assert.equal(f.sent.length, 1); assert.equal(f.executed.length, 0)
  }
})

test('a missing proxy fails before any model call; cancellation also interrupts the retry wait', async () => {
  const missing = fixture([], { network: { run() { throw Object.assign(Error('synthetic-private-address'), { code: 'MODEL_PROXY_REQUIRED' }) } } })
  await assert.rejects(missing.run(), error => error.code === 'MODEL_PROXY_REQUIRED' && !error.message.includes('synthetic-private-address'))
  assert.equal(missing.sent.length, 0)
  const controller = new AbortController(), failure = Object.assign(Error('fetch failed'), { code: 'ECONNRESET' })
  const cancel = fixture([() => { setImmediate(() => controller.abort()); return failure }])
  await assert.rejects(cancel.run({ signal: controller.signal }), { name: 'AbortError' }); assert.equal(cancel.sent.length, 1)
})
