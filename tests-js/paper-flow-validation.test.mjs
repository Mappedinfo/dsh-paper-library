import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { validateFlowWorkspace, FLOW_LIMITS } from '../src/paper-flow/validation.mjs'
import { createWorkspace, draftKey, parseFlowInput, serializeWorkspace } from '../vendor/paper-flow/document.js'
import { compareFlows, namespaceSvg, prepareGraph } from '../vendor/paper-flow/comparison.js'
import engine from '../vendor/paper-flow/core/graph.js'

const node = id => ({ id, label: id, type: 'method', ports: { in: { p: { type: 'value' } }, out: { p: { type: 'value' } } } })
const graph = (id = 'main') => ({ id, name: 'Synthetic', nodes: [node('a'), node('b')], edges: [{ id: 'ab', from: 'a:p', to: 'b:p' }] })
const document = () => ({ schemaVersion: 1, kind: 'paper-flow-document', paper: { id: 'synthetic', title: 'Synthetic' }, flows: [graph()] })
const rejected = (value, code) => assert.throws(() => validateFlowWorkspace(value), error => error.code === 'PAPER_FLOW_INVALID' && error.diagnostics.some(item => item.code === code))

test('synthetic teaching workspace and single documents normalize into isolated round-trippable workspaces', async () => {
  const sample = await readFile(new URL('../examples/paper-flow-teaching.json', import.meta.url), 'utf8')
  const workspace = validateFlowWorkspace(sample)
  assert.equal(workspace.kind, 'paper-flow-workspace')
  assert.deepEqual(validateFlowWorkspace(serializeWorkspace(workspace)), workspace)
  const source = document(), result = validateFlowWorkspace(source)
  source.flows[0].nodes[0].label = 'changed afterward'
  assert.equal(result.documents[0].flows[0].nodes[0].label, 'a')
  assert.equal(result.selection.left.flowId, 'main')
})

test('bytes, depth, strings, invalid JSON and recursive values are rejected before graph layout', () => {
  rejected(' '.repeat(FLOW_LIMITS.workspaceBytes + 1), 'budget.bytes')
  rejected('汉'.repeat(Math.floor(FLOW_LIMITS.workspaceBytes / 3) + 1), 'budget.bytes')
  rejected('{', 'json.parse')
  const value = document(); value.paper.title = 'x'.repeat(FLOW_LIMITS.textLength + 1)
  rejected(value, 'budget.structure')
  const deep = document(); let item = deep.paper
  for (let i = 0; i < FLOW_LIMITS.depth + 1; i++) item = item.next = {}
  rejected(deep, 'budget.structure')
  const cyclic = document(); cyclic.paper.loop = cyclic
  rejected(cyclic, 'budget.structure')
  const polluted = JSON.stringify(document()).replace('"title":"Synthetic"', '"title":"Synthetic","__proto__":{"x":1}')
  rejected(polluted, 'budget.structure')
})

test('input budgets restrict documents, per-flow and aggregate graph size and drafts', () => {
  const tooManyDocs = { kind: 'paper-flow-workspace', schemaVersion: 1, documents: Array.from({ length: FLOW_LIMITS.documents + 1 }, (_, i) => ({ ...document(), paper: { id: `p${i}`, title: 'S' } })) }
  rejected(tooManyDocs, 'budget.documents')
  const tooManyFlows = document(); tooManyFlows.flows = Array.from({ length: FLOW_LIMITS.flows + 1 }, (_, i) => graph(`g${i}`))
  rejected(tooManyFlows, 'budget.flows')
  const big = document(); big.flows[0].nodes = Array.from({ length: FLOW_LIMITS.nodesPerFlow + 1 }, (_, i) => node(`n${i}`))
  rejected(big, 'budget.flow')
  const tooManyEdges = document(); tooManyEdges.flows[0].edges = Array.from({ length: FLOW_LIMITS.edgesPerFlow + 1 }, (_, i) => ({ id: `e${i}`, from: 'a:p', to: 'b:p' }))
  rejected(tooManyEdges, 'budget.flow')
  const aggregate = document(); aggregate.flows = Array.from({ length: 5 }, (_, i) => ({ id: `g${i}`, name: 'S', nodes: Array.from({ length: 100 }, (_, n) => node(`n${n}`)), edges: [] }))
  rejected(aggregate, 'budget.graphs')
  const aggregateEdges = document(); aggregateEdges.flows = Array.from({ length: 5 }, (_, i) => ({ ...graph(`g${i}`), edges: Array.from({ length: 200 }, (_, n) => ({ id: `e${n}`, from: 'a:p', to: 'b:p' })) }))
  rejected(aggregateEdges, 'budget.graphs')
  const drafts = { ...validateFlowWorkspace(document()), drafts: Object.fromEntries(Array.from({ length: FLOW_LIMITS.drafts + 1 }, (_, i) => [`d${i}`, { nodes: {}, edges: {}, relations: [] }])) }
  rejected(drafts, 'budget.drafts')
})

test('malicious imported edge styles are rejected and renderers escape untrusted markup', () => {
  const malicious = document(), edge = malicious.flows[0].edges[0]
  edge.trunk_relation = 'test" onmouseover="synthetic()'
  rejected(malicious, 'edge.field')
  const prepared = prepareGraph(malicious.flows[0], { detail: 'full', arrangement: 'trunks', treeLevels: 'expanded', grouping: true })
  const svg = engine.svg(prepared).svg
  assert.ok(!svg.includes('class="edge single test" onmouseover="synthetic()'))
  assert.ok(svg.includes('&quot;'))
  const source = document()
  source.flows[0].subtitle = '<script>synthetic()</script>'
  source.flows[0].nodes[0].label = '<img onerror="synthetic()">'
  source.flows[0].nodes[0].state = '</text><script>synthetic()</script>'
  const rendered = engine.svg(prepareGraph(source.flows[0], { detail: 'full', arrangement: 'trunks', treeLevels: 'expanded', grouping: true }), { title: 'S' }).svg
  assert.ok(!rendered.includes('<script>synthetic()'))
  assert.ok(!rendered.includes('<img onerror='))
  assert.equal(parseFlowInput(malicious).ok, false)
})

test('independent synthetic graphs compare without inventing matches and preserve visual drafts', () => {
  const first = document(), second = document()
  second.paper.id = 'other'
  second.flows[0].nodes[0].label = 'Different step'
  const before = compareFlows(first.flows[0], second.flows[0])
  assert.equal(before.report.pairs.length, 0)
  for (const item of [first, second]) Object.assign(item.flows[0].nodes[0], { semantic_key: 'synthetic', op: 'normalize', config: { mode: 'sample' } })
  assert.equal(compareFlows(first.flows[0], second.flows[0]).report.pairs.length, 1)
  const workspace = createWorkspace([first, second], { left: { documentId: 'synthetic', flowId: 'main' }, right: { documentId: 'other', flowId: 'main' } })
  const layout = engine.layout(prepareGraph(first.flows[0], workspace.view)), chosen = layout.nodes[0]
  workspace.drafts[draftKey(workspace.selection.left, workspace.view)] = { nodes: { [chosen.id]: { x: chosen.x, y: chosen.y, fixed: true } }, edges: {}, relations: [] }
  assert.deepEqual(validateFlowWorkspace(serializeWorkspace(workspace)).drafts, workspace.drafts)
  const svg = engine.svg(prepareGraph(first.flows[0], workspace.view)).svg
  assert.ok(namespaceSvg(svg, 'one').includes('id="one-arrow-'))
  assert.ok(namespaceSvg(svg, 'two').includes('id="two-arrow-'))
})
