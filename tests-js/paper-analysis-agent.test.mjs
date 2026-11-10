import test from 'node:test'
import assert from 'node:assert/strict'
import { createHarnessAI } from '../src/harness/ai.mjs'
import { createPaperAnalysisAgent } from '../src/harness/paper-analysis-agent.mjs'
import { renderAnalysisAgentPersona } from '../src/prompt-templates.mjs'

const input = { prompt: 'Read only FIXED_SELECTED_PAGES and return JSON.', provider: 'fixture', model: 'paper-model', reasoningEffort: 'high' }
function fixture() {
  const events = [], calls = [], f = { result: { stopReason: 'completed', output: [{ type: 'text', text: '{"title":"Synthetic result"}' }] }, events, calls }
  const tools = { guard(fn) { f.guard = fn; events.push('guard'); return () => { events.push('unguard'); f.guard = null } } }
  const agents = {
    withoutInitiator(fn) { events.push('without-initiator'); return fn() },
    async create(options) {
      calls.push({ type: 'parent', options }); events.push('parent')
      await options.setup({ tools: { restrict: filter => { f.parentFilter = filter } } })
      f.parent = { session: { id: options.sessionId, header: options.meta } }
      if (f.createError) throw f.createError
      return { agent: f.parent, async dispose() { events.push('dispose-parent'); if (f.parentDisposeError) throw f.parentDisposeError } }
    },
  }
  const subagents = {
    list: () => f.providers ?? ['spawn'],
    async start(provider, options) {
      calls.push({ type: 'child', provider, options }); events.push('child')
      if (f.startError) throw f.startError
      if (f.duringStart) f.duringStart(options)
      return { result: f.pending ?? Promise.resolve(f.result), async dispose() { events.push('dispose-child'); if (f.childDisposeError) throw f.childDisposeError } }
    },
  }
  f.handle = createPaperAnalysisAgent({ get: name => ({ agents, subagents, tools })[name] }, { cwd: '/synthetic/library' })
  return f
}

test('native spawn has an owned empty parent, paper route, fixed source and no main Agent lookup', async () => {
  const f = fixture(), value = await f.handle(input)
  assert.deepEqual(JSON.parse(value), { title: 'Synthetic result' })
  const [parent, child] = f.calls
  assert.match(parent.options.sessionId, /^paper-analysis-/)
  assert.deepEqual(parent.options.meta, { cwd: '/synthetic/library', origin: 'subagent', delegationDepth: 0 })
  assert.equal(parent.options.seed, undefined); assert.equal(parent.options.parentAgent, undefined)
  assert.equal(child.options.parent, f.parent); assert.equal(child.provider, 'spawn')
  assert.deepEqual(child.options.prompt, [{ type: 'text', text: input.prompt }])
  assert.equal(child.options.persona, renderAnalysisAgentPersona())
  assert.match(child.options.persona, /Do not use tools, inspect files, browse, send messages, or delegate/)
  assert.deepEqual(child.options.agentOptions, { provider: 'fixture', model: 'paper-model', reasoningEffort: 'high', maxTokens: 8192 })
  assert.deepEqual(child.options.toolFilter, { allow: [] }); assert.deepEqual(f.parentFilter, { allow: [] }); assert.equal(child.options.maxDepth, 1)
  assert.deepEqual(f.events, ['without-initiator', 'guard', 'parent', 'child', 'dispose-child', 'dispose-parent', 'unguard'])
})

test('native image capability is explicit and an empty image list keeps the legacy text shape', async () => {
  const f = fixture()
  assert.equal(f.handle.supportsImages, false)
  await f.handle({ ...input, images: [] })
  assert.deepEqual(f.calls[1].options.prompt, [{ type: 'text', text: input.prompt }])
})

test('native images are refused before host access, attachment persistence or owned allocation', async () => {
  const data = Buffer.from('SYNTHETIC_IMAGE_PRIVATE_BYTES').toString('base64')
  const image = { mime_type: 'image/png', data, page: 1, width: 1, height: 1, sha256: 'a'.repeat(64) }
  let hostAccesses = 0
  const handle = createPaperAnalysisAgent({ get() { hostAccesses++; throw new Error('Host must not be accessed for unsupported images') } }, { cwd: '/synthetic/library' })
  for (const images of [[image], [image, image], null, data, { image }]) {
    await assert.rejects(handle({ ...input, images }), error => {
      assert.equal(error.code, 'PAPER_ANALYSIS_IMAGES_UNSUPPORTED')
      assert.equal(error.status, 409)
      assert.match(error.message, /视觉模型/)
      assert.equal(error.message.includes(data), false)
      assert.equal(error.message.includes(input.prompt), false)
      return true
    })
  }
  assert.equal(hostAccesses, 0)
  const f = fixture()
  await assert.rejects(f.handle({ ...input, images: [image] }), { code: 'PAPER_ANALYSIS_IMAGES_UNSUPPORTED' })
  assert.deepEqual(f.calls, [])
  assert.deepEqual(f.events, [])
})

test('cancelled native image requests allocate nothing and do not expose image bytes', async () => {
  const controller = new AbortController()
  const data = Buffer.from('SYNTHETIC_CANCELLED_IMAGE_BYTES').toString('base64')
  controller.abort(new Error('synthetic cancellation'))
  const f = fixture()
  await assert.rejects(f.handle({ ...input, images: [{ mime_type: 'image/png', data, page: 1, width: 1, height: 1, sha256: 'b'.repeat(64) }], signal: controller.signal }), error => {
    assert.equal(error.code, 'PAPER_ANALYSIS_IMAGES_UNSUPPORTED')
    assert.equal(error.message.includes(data), false)
    return true
  })
  assert.deepEqual(f.calls, [])
  assert.deepEqual(f.events, [])
})

test('execution guard denies scoped and PTC tools for owned analysis only', async () => {
  const f = fixture()
  f.duringStart = () => {
    for (const name of ['run_code', 'scoped-secret-reader', 'send_message']) {
      assert.match(f.guard({ name, agent: f.parent }), /cannot execute/)
      assert.match(f.guard({ name, agent: { session: { id: 'child', header: { parentSession: f.parent.session.id } } } }), /cannot execute/)
      assert.equal(f.guard({ name, agent: { session: { id: 'main', header: {} } } }), undefined)
    }
    assert.equal(f.guard({ name: 'unrelated-tool' }), undefined)
  }
  await f.handle(input); assert.equal(f.guard, null)
})

test('native start rollback releases parent and guard; creation failure releases guard only', async () => {
  const f = fixture(); f.startError = new Error('native unavailable')
  await assert.rejects(f.handle(input), /native unavailable/)
  assert.deepEqual(f.events.slice(-2), ['dispose-parent', 'unguard'])
  const second = fixture(); second.createError = new Error('creation rollback')
  await assert.rejects(second.handle(input), /creation rollback/)
  assert.equal(second.events.at(-1), 'unguard'); assert.equal(second.events.includes('child'), false)
})

test('request cancellation is forwarded and resources released', async () => {
  const f = fixture(), controller = new AbortController()
  f.pending = new Promise(resolve => { f.resolve = resolve })
  f.duringStart = options => options.signal.addEventListener('abort', () => f.resolve({ stopReason: 'aborted', output: [] }), { once: true })
  const result = f.handle({ ...input, signal: controller.signal })
  while (!f.events.includes('child')) await new Promise(resolve => setImmediate(resolve))
  controller.abort(new Error('cancel-selected-analysis'))
  await assert.rejects(result, /cancel-selected-analysis/)
  assert.deepEqual(f.events.slice(-3), ['dispose-child', 'dispose-parent', 'unguard'])
  const aborted = fixture(); await assert.rejects(aborted.handle({ ...input, signal: controller.signal }), /cancel-selected-analysis/)
  assert.equal(aborted.calls.length, 0)
})

test('120-second deadline cancels the owned native run and clears its handles', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  f.pending = new Promise(resolve => { f.resolve = resolve })
  f.duringStart = options => options.signal.addEventListener('abort', () => f.resolve({ stopReason: 'aborted', output: [] }), { once: true })
  const result = f.handle(input)
  while (!f.events.includes('child')) await new Promise(resolve => setImmediate(resolve))
  t.mock.timers.tick(120000)
  await assert.rejects(result, /120 秒/)
  assert.deepEqual(f.events.slice(-3), ['dispose-child', 'dispose-parent', 'unguard'])
})

test('partial, invalid, non-object and oversized results never become completed analysis', async () => {
  for (const result of [
    { stopReason: 'max-tokens', output: [{ type: 'text', text: '{}' }] },
    { stopReason: 'completed', output: [{ type: 'text', text: '{"unfinished"' }] },
    { stopReason: 'completed', output: [{ type: 'text', text: '[]' }] },
    { stopReason: 'completed', output: [{ type: 'text', text: `{"body":"${'x'.repeat(160000)}"}` }] },
  ]) {
    const f = fixture(); f.result = result
    await assert.rejects(f.handle(input), error => error.code === 'PAPER_ANALYSIS_INCOMPLETE')
    assert.deepEqual(f.events.slice(-3), ['dispose-child', 'dispose-parent', 'unguard'])
  }
})

test('empty sources, excessive input and missing native spawn fail before allocation', async () => {
  const f = fixture()
  for (const request of [{ ...input, prompt: '' }, { ...input, prompt: 'x'.repeat(128 * 1024 + 1) }, { ...input, model: '' }]) await assert.rejects(f.handle(request))
  f.providers = []; await assert.rejects(f.handle(input), error => error.code === 'PAPER_ANALYSIS_UNAVAILABLE')
  assert.equal(f.calls.length, 0)
})

test('child disposal failure still disposes parent and removes guard', async () => {
  const f = fixture(); f.childDisposeError = new Error('synthetic teardown error')
  await assert.rejects(f.handle(input), error => error.code === 'PAPER_ANALYSIS_CLEANUP_FAILED')
  assert.deepEqual(f.events.slice(-3), ['dispose-child', 'dispose-parent', 'unguard'])
})

test('host text generation works without the removed subagent service and keeps source bounds', async () => {
  const calls = []
  const handle = createPaperAnalysisAgent({ get() { throw Error('No subagent API access expected') } }, {
    cwd: '/synthetic/library', generate: async request => { calls.push(request); return '```json\n{"answers":[]}\n```' },
  })
  assert.deepEqual(JSON.parse(await handle(input)), { answers: [] })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].provider, input.provider)
  assert.equal(calls[0].model, input.model)
  assert.equal(calls[0].reasoningEffort, 'high')
  assert.ok(calls[0].prompt.endsWith(input.prompt))
  assert.match(calls[0].prompt, /Do not use tools/)
  await assert.rejects(handle({ ...input, signal: AbortSignal.abort(Error('cancelled')) }), /cancelled/)
  assert.equal(calls.length, 1)
})

test('host generation deadline rejects an adapter that ignores cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let received
  const handle = createPaperAnalysisAgent({}, { cwd: '/synthetic/library', generate: request => {
    received = request; return new Promise(() => {})
  } })
  const result = handle(input)
  t.mock.timers.tick(120000)
  await assert.rejects(result, /120 秒/)
  assert.equal(received.signal.aborted, true)
})

test('host generation rejects caller cancellation without accepting a late complete JSON', async () => {
  let finish
  const controller = new AbortController()
  const handle = createPaperAnalysisAgent({}, { cwd: '/synthetic/library', generate: () => new Promise(resolve => { finish = resolve }) })
  const result = handle({ ...input, signal: controller.signal })
  controller.abort(new Error('stop stalled generation'))
  await assert.rejects(result, /stop stalled generation/)
  finish('{"answers":[]}')
})


test('direct analysis forwards session identity to host generation and rejects malformed identities', async () => {
  const calls = []
  const analyze = createPaperAnalysisAgent({}, { cwd: '/synthetic/library', generate: async options => {
    calls.push(options); return '{"title":"Synthetic"}'
  } })
  await analyze({ ...input, sessionId: 'paper-session-123' })
  assert.equal(calls[0].sessionId, 'paper-session-123')
  await analyze(input)
  assert.equal(Object.hasOwn(calls[1], 'sessionId'), false)
  for (const sessionId of ['', null, 4, ' bad', 'bad\nheader', 'x'.repeat(201)]) {
    await assert.rejects(analyze({ ...input, sessionId }), /sessionId/)
  }
  assert.equal(calls.length, 2)
})


test('analysis adapter and Harness AI preserve session routing end to end with a synthetic host stream', async () => {
  const sent = []
  const llm = { resolveModelInfo: async () => ({}), async *stream(options) {
    sent.push(options)
    yield { type: 'block-end', block: { type: 'text', text: '{"title":"Synthetic"}' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const generate = createHarnessAI(llm, value => value, { maxOutputTokens: 8192 })
  const analyze = createPaperAnalysisAgent({}, { cwd: '/synthetic/library', generate })
  await analyze({ ...input, sessionId: 'actual-paper-session' })
  assert.equal(sent[0].sessionId, 'actual-paper-session')
  assert.equal(sent[0].provider, input.provider)
  assert.equal(sent[0].model, input.model)
  assert.equal(sent[0].maxTokens, 8192)
  assert.equal(sent[0].tools, undefined)
})
