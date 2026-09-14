import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { registerLibraryTools, TOOL_SPECS } from '../src/harness/tools.mjs'
import { resolveConfig } from '../src/harness/config.mjs'

const root = resolve(process.env.DSH_CHECKOUT ?? join(dirname(fileURLToPath(import.meta.url)), '../../../deepseek-ai/deepseek-harness'))
const toolsPath = join(root, 'packages/core/tools/lib/index.js')

test('tool schemas register and execute through the actual built Harness runtime', { skip: !existsSync(toolsPath) && 'Set DSH_CHECKOUT to a built Harness checkout' }, async () => {
  const load = relative => import(pathToFileURL(join(root, relative)).href)
  const { Context } = await load('vendor/cordis/lib/index.js')
  const { default: SystemPrompt } = await load('packages/core/system-prompt/lib/index.js')
  const { default: ToolRuntime, defineTool } = await load('packages/core/tools/lib/index.js')
  const { ToolCallId } = await load('packages/llm/llm/lib/index.js')
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  let received
  const config = resolveConfig({ library: '/tmp/library-test', requireToolApproval: false })
  const dispose = registerLibraryTools(ctx, defineTool, async (request, options) => { received = { request, library: options.library }; return { items: [], total: 0 } }, { library: config.library }, config)
  try {
    assert.equal(ctx.tools.schemas().length, TOOL_SPECS.length)
    const result = await ctx.tools.execute({ callId: ToolCallId('paper-library-test'), name: 'library_search', arguments: { query: 'urban', library: '/wrong' }, signal: new AbortController().signal })
    assert.equal(result.isError, false)
    assert.deepEqual(received, { request: { action: 'list', query: 'urban' }, library: '/tmp/library-test' })
    const execute = (name, args) => ctx.tools.execute({ callId: ToolCallId(`test-${name}`), name, arguments: args, signal: new AbortController().signal })
    const metadata = { title: 'Synthetic native paper', author: [{ given: 'Ada', family: 'Reader', affiliation: [{ name: 'Synthetic Institute' }] }], publication_dates: { accepted: '2026-09-01' }, journal_rankings: [{ system: 'JCR', year: 2025, category: 'Synthetic category', quartile: 'Q2', source: 'Synthetic verification source' }] }
    assert.equal((await execute('library_create', { metadata })).isError, false)
    assert.deepEqual(received.request, { action: 'create', metadata })
    assert.equal((await execute('library_graph_node_put', { id: 'paper', type: 'evidence', label: 'Measured result', evidence: { page: null, quote: 'Original statement', note: 'Reader interpretation' } })).isError, false)
    assert.equal(received.request.evidence.page, null)
    assert.equal(received.request.evidence.quote, 'Original statement')
    assert.equal((await execute('library_graph_edge_put', { id: 'paper', source: 'evidence', target: 'claim', relation: 'supports', evidence: { page: 2 } })).isError, false)
    assert.deepEqual(received.request, { action: 'graph_edge_put', id: 'paper', source: 'evidence', target: 'claim', relation: 'supports', evidence: { page: 2 } })
    for (const name of ['library_archive', 'library_restore', 'library_graph_node_delete', 'library_graph_edge_delete']) {
      assert.equal((await execute(name, { id: 'paper', node_id: 'node', edge_id: 'edge' })).isError, false)
      assert.equal(received.request.action, name.slice('library_'.length))
    }
    received = undefined
    assert.equal((await execute('library_update', { id: 'paper', metadata: { title: 'Synthetic', path: '/forbidden' } })).isError, true)
    assert.equal(received, undefined, 'closed nested schema must reject extra worker fields before dispatch')
    assert.equal((await execute('library_graph_node_put', { id: 'paper', type: 'invented-inference', label: 'Unsupported type' })).isError, true)
    assert.equal(received, undefined)
  } finally {
    dispose()
    await ctx.fiber.dispose()
  }
})

test('selection-only UI fixture advertises valid routes and reasoning effort metadata', { skip: !existsSync(toolsPath) && 'Set DSH_CHECKOUT to a built Harness checkout' }, async () => {
  const load = relative => import(pathToFileURL(join(root, relative)).href)
  const { Context } = await load('vendor/cordis/lib/index.js')
  const { default: LlmRuntime } = await load('packages/llm/llm/lib/index.js')
  const fixture = await import('./fixtures/harness-models/index.mjs')
  const ctx = new Context()
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(fixture)
    const providers = ctx.llm.listProviders()
    assert.equal(providers.length, 2)
    for (const provider of providers) {
      const models = await ctx.llm.listModels(provider.id)
      assert.equal(models.length, 1)
      const info = await ctx.llm.resolveModelInfo(provider.id, models[0].id)
      assert.deepEqual(info.reasoning.efforts.map(effort => effort.id), ['low', 'high'])
    }
  } finally { await ctx.fiber.dispose() }
})
