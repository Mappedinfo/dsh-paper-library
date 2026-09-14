import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../src/harness/config.mjs'
import { collectFeedback, createHarnessAI, discoverModels } from '../src/harness/ai.mjs'
import { requestFromTool, TOOL_SPECS, registerLibraryTools } from '../src/harness/tools.mjs'

test('deployment paths reject relative locations and malformed bounds', () => {
  assert.throws(() => resolveConfig({ library: '../escape' }), /absolute/)
  assert.throws(() => resolveConfig({ python: 'python' }), /absolute/)
  assert.throws(() => resolveConfig({ maxOutputTokens: 1 }), /64/)
  assert.throws(() => resolveConfig({ requireToolApproval: 'false' }), /boolean/)
  assert.equal(resolveConfig({ library: '/tmp/papers' }).requireToolApproval, true)
})

test('tool requests remove deployment overrides and resolve imports from calling workspace', () => {
  const spec = TOOL_SPECS.find(spec => spec.name === 'library_import')
  assert.deepEqual(requestFromTool(spec, { path: 'paper.pdf', library: '/wrong', python: '/wrong', action: 'save_feedback', content_base64: 'abc' }, { agent: { session: { header: { cwd: '/tmp/workspace' } } } }), { action: 'import', path: '/tmp/workspace/paper.pdf' })
})

async function* complete(text = 'Grounded response') {
  yield { type: 'block-end', block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

test('AI feedback requires a successful non-empty terminal response', async () => {
  assert.equal(await collectFeedback(complete()), 'Grounded response')
  await assert.rejects(collectFeedback(complete('')), /no text/)
  await assert.rejects(collectFeedback((async function* () { yield { type: 'block-end', block: { type: 'text', text: 'partial' } } })()), /without a finish/)
  for (const kind of ['max-tokens', 'error', 'aborted', 'tool-calls']) {
    await assert.rejects(collectFeedback((async function* () { yield { type: 'finish', reason: { kind } } })()), /did not complete/)
  }
})

test('AI uses configured Harness routes and cancellation without accessing credentials', async () => {
  const signal = new AbortController().signal
  let options
  const llm = { resolveModelInfo: async (...args) => assert.deepEqual(args, ['local', 'reader', signal]), stream: input => { options = input; return complete() } }
  const ai = createHarnessAI(llm, message => message, { maxOutputTokens: 1600 })
  await assert.rejects(ai({ prompt: 'x' }), /Select/)
  assert.equal(await ai({ prompt: 'annotation context', provider: 'local', model: 'reader', reasoningEffort: 'high', signal }), 'Grounded response')
  assert.equal(options.messages[0].source.plugin, 'paper-library')
  assert.equal(options.messages[0].content[0].text, 'annotation context')
  assert.equal(options.signal, signal)
  assert.equal(options.reasoningEffort, 'high')
  await ai({ prompt: 'annotation context', provider: 'local', model: 'reader', signal })
  assert.equal(Object.hasOwn(options, 'reasoningEffort'), false)
  await assert.rejects(ai({ prompt: 'annotation context', provider: 'local', model: 'reader', reasoningEffort: '' }), /reasoningEffort/)
})

test('model discovery returns the UI route format and preserves a failed provider', async () => {
  const result = await discoverModels({
    listProviders: () => [{ id: 'local', name: 'Local' }, { id: 'missing' }],
    listModels: async provider => { if (provider === 'missing') throw new Error('unavailable'); return [{ id: 'reader', name: 'Reader' }] },
  })
  assert.deepEqual(result.models, [{ id: 'reader', name: 'Reader', provider: 'local' }])
  assert.equal(result.configured, true)
  assert.equal(result.providers[1].error, 'unavailable')
})

test('tool mutation approval preserves denial and does not ask for reads', async () => {
  const tools = new Map()
  let policy
  const ctx = {
    on: (_event, callback) => { policy = callback; return () => { policy = undefined } },
    tools: { register: definition => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
  }
  const dispose = registerLibraryTools(ctx, value => value, async request => request, { library: '/tmp/library' }, resolveConfig({ library: '/tmp/library' }))
  const allow = async () => ({ kind: 'allow' })
  assert.equal((await policy({ name: 'library_search' }, allow)).kind, 'allow')
  assert.equal((await policy({ name: 'library_import' }, allow)).kind, 'ask')
  for (const spec of TOOL_SPECS.filter(spec => spec.mutate)) assert.equal((await policy({ name: spec.name }, allow)).kind, 'ask', spec.name)
  const deny = { kind: 'deny', reason: 'blocked' }
  assert.equal(await policy({ name: 'library_import' }, async () => deny), deny)
  assert.equal(await policy({ name: 'library_graph_node_delete' }, async () => deny), deny)
  await assert.rejects(tools.get('library_import').execute({}, { signal: new AbortController().signal }), /exactly one/)
  assert.equal(tools.size, TOOL_SPECS.length)
  dispose()
  assert.equal(tools.size, 0)
  assert.equal(policy, undefined)
})

test('catalog and graph direct calls retain only structured evidence and bounded metadata', () => {
  const spec = name => TOOL_SPECS.find(value => value.name === name)
  assert.deepEqual(requestFromTool(spec('library_search'), { sort: 'year', order: 'desc', archived: true, limit: 20, library: '/wrong' }, {}), { action: 'list', limit: 20, sort: 'year', order: 'desc', archived: true })
  assert.deepEqual(requestFromTool(spec('library_get'), { id: 'paper', include_archived: true }, {}), { action: 'get', id: 'paper', include_archived: true })
  const metadata = { title: 'Synthetic paper', author: [{ given: 'Ada', family: 'Reader', affiliation: [{ name: 'Synthetic Institute' }] }], publication_dates: { accepted: '2026-09-01' }, journal_rankings: [{ system: 'JCR', year: 2025, category: 'Synthetic category', quartile: 'Q2', source: 'Synthetic source' }] }
  assert.deepEqual(requestFromTool(spec('library_create'), { metadata }, {}), { action: 'create', metadata })
  assert.throws(() => requestFromTool(spec('library_update'), { id: 'paper', metadata: { path: '/wrong.pdf' } }, {}), /not a supported/)
  assert.throws(() => requestFromTool(spec('library_create'), { metadata: {} }, {}), /title is required/)
  assert.throws(() => requestFromTool(spec('library_create'), { metadata: { title: 'x'.repeat(128 * 1024) } }, {}), /128 KiB/)
  assert.throws(() => requestFromTool(spec('library_update'), { metadata: { author: Array.from({ length: 301 }, () => ({ family: 'x' })) } }, {}), /300/)
  const graphRequest = { id: 'paper', type: 'claim', label: 'Synthetic claim', evidence: { page: null, quote: 'Known source', note: 'Reader interpretation' } }
  assert.deepEqual(requestFromTool(spec('library_graph_node_put'), graphRequest, {}), { action: 'graph_node_put', ...graphRequest })
  assert.throws(() => requestFromTool(spec('library_graph_node_put'), { ...graphRequest, evidence: { page: true } }, {}), /invalid value type/)
  assert.throws(() => requestFromTool(spec('library_graph_node_put'), { ...graphRequest, evidence: { model: 'invented' } }, {}), /not a supported/)
})

test('feedback tools follow the calling conversation route before deployment fallback', async () => {
  const tools = new Map()
  let options
  const config = resolveConfig({ library: '/tmp/library', requireToolApproval: false, provider: 'fallback', model: 'fallback-model' })
  const ctx = { tools: { register: definition => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } } }
  const dispose = registerLibraryTools(ctx, value => value, async (_request, input) => { options = input; return {} }, { library: config.library }, config)
  const execute = tools.get('library_feedback').execute
  await execute({ id: 'paper' }, { signal: new AbortController().signal, agent: { options: { provider: 'conversation', model: 'selected', reasoningEffort: 'high' } } })
  assert.equal(options.provider, 'conversation')
  assert.equal(options.model, 'selected')
  assert.equal(options.reasoningEffort, 'high')
  await execute({ id: 'paper', provider: 'explicit', model: 'other' }, { signal: new AbortController().signal, agent: { options: { provider: 'conversation', model: 'selected', reasoningEffort: 'high' } } })
  assert.equal(options.reasoningEffort, undefined)
  await execute({ id: 'paper' }, { signal: new AbortController().signal })
  assert.equal(options.provider, 'fallback')
  assert.equal(options.model, 'fallback-model')
  await execute({ id: 'paper' }, { signal: new AbortController().signal, agent: { options: { provider: 'incomplete-route' } } })
  assert.equal(options.provider, 'fallback')
  assert.equal(options.model, 'fallback-model')
  dispose()
})
