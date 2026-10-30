import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import engine from '../vendor/paper-flow/core/graph.js'
import { comparisonPeers } from '../vendor/paper-flow/core/hover.js'
import { trunkPresentation } from '../vendor/paper-flow/core/trunks.js'
import { prefersStraight, mayOptimizePosition, hoverKey, validCompareField } from '../vendor/paper-flow/core/hints.js'
import { validateFlowWorkspace } from '../src/paper-flow/validation.mjs'

const node = (id, port = 'p') => ({ id, label: id, type: 'method', ports: { in: { [port]: { type: 'data' } }, out: { p: { type: 'data' } } } })
function graph(domain, hinted, id = 'neutral') {
  const nodes = Array.from({ length: 5 }, (_, i) => node(`n${i}`, i === 4 ? domain ? 'features' : 'q' : 'p'))
  if (domain) nodes[4].role = 'training'
  const edges = [[0,1], [0,3], [0,4], [1,4]].map(([a, b]) => ({ id: `e${a}${b}`, from: `n${a}:p`, to: `n${b}:${b === 4 ? domain ? 'features' : 'q' : 'p'}`, kind: 'data', ...(hinted ? { layout: { preferStraight: true } } : {}) }))
  return { id, name: 'Synthetic', nodes, edges, presentation_layout: 'trunks', tree_levels: 'expanded' }
}

test('straightening requires an explicit hint, never a named training role, port or paper', () => {
  const positions = layout => layout.nodes.map(n => [n.id, n.x, n.y])
  const neutral = engine.layout(graph(false, false)), oldNames = engine.layout(graph(true, false, 'arbitrary-paper'))
  assert.deepEqual(positions(oldNames), positions(neutral))
  assert.equal(oldNames.routing.node_alignments.some(item => item.rule === 'hinted-straight-spine'), false)
  const hinted = engine.layout(graph(false, true))
  assert.equal(hinted.routing.node_alignments.some(item => item.rule === 'hinted-straight-spine'), true)
  assert.notDeepEqual(positions(hinted), positions(neutral))
  assert.equal(prefersStraight({ kind: 'data', to: 'x:features' }), false)
  assert.equal(prefersStraight({ layout: { preferStraight: true } }), true)
  assert.equal(mayOptimizePosition({ role: 'selection' }), false)
  assert.equal(mayOptimizePosition({ layout: { optimizePosition: true } }), true)
})

test('trunk style does not infer secondary relations from domain words', () => {
  const g = graph(false, false)
  for (const kind of ['train_target', 'parameter', 'selection', 'anything']) {
    g.edges[0].kind = kind
    assert.equal(trunkPresentation(g).edges[0].trunk_relation, 'lineage')
  }
  g.edges[0].trunk_relation = 'secondary'; assert.equal(trunkPresentation(g).edges[0].trunk_relation, 'secondary')
  delete g.edges[0].trunk_relation; g.nodes[0].trunk_control = true
  assert.equal(trunkPresentation(g).edges[0].trunk_relation, 'secondary')
})

test('edge hover uses explicit keys or ordinary kind equality without role inference', () => {
  const a = { nodes: [node('a1'), node('a2')], edges: [{ id: 'a-edge', from: 'a1:p', to: 'a2:p', kind: 'data' }] }
  const b = { nodes: [node('b1'), node('b2')], edges: [{ id: 'b-edge', from: 'b1:p', to: 'b2:p', kind: 'other' }] }
  a.nodes[0].hover_role = b.nodes[0].hover_role = 'task_fit'
  a.nodes[1].hover_role = b.nodes[1].hover_role = 'parameter_selection'
  const peers = () => comparisonPeers({ a, b, r: { pairs: [{ a: 'a1', b: 'b1' }, { a: 'a2', b: 'b2' }], edgePairs: [] } })('a', { nodes: [], edges: ['a-edge'] }).edges
  assert.equal(peers().size, 0, 'domain role names do not manufacture a match')
  b.edges[0].kind = 'data'; assert.equal(peers().has('b-edge'), true)
  a.edges[0].hover_key = 'explicit'; assert.equal(peers().size, 0, 'a one-sided hint is not equivalent')
  b.edges[0].hover_key = 'explicit'; b.edges[0].kind = 'other'; assert.equal(peers().has('b-edge'), true)
  b.edges[0].hover_key = 'different'; assert.equal(peers().size, 0)
  assert.equal(hoverKey({ kind: 'reference_test_selection' }), null)
  const blank = comparisonPeers({ a: { nodes: [{ id: 'x', hover_role: '  ' }], edges: [] }, b: { nodes: [{ id: 'y', hover_role: '  ' }], edges: [] }, r: { pairs: [], edgePairs: [] } })
  assert.equal(blank('a', { nodes: ['x'], edges: [] }).nodes.size, 0, 'empty legacy hover roles are not hints')
})

test('missing or unknown metadata never creates hover peers, while verified pairs remain', () => {
  const a = { nodes: [node('a1'), node('a2')], edges: [{ id: 'a-edge', from: 'a1:p', to: 'a2:p' }] }
  const b = { nodes: [node('b1'), node('b2')], edges: [{ id: 'b-edge', from: 'b1:p', to: 'b2:p' }] }
  const pairs = [{ a: 'a1', b: 'b1' }, { a: 'a2', b: 'b2' }]
  const peerEdges = edgePairs => comparisonPeers({ a, b, r: { pairs, edgePairs } })('a', { nodes: [], edges: ['a-edge'] }).edges
  for (const missing of [undefined, '', ' ', 'unknown', 'Unverified', '未知', '未核实']) {
    a.edges[0].kind = b.edges[0].kind = missing
    assert.equal(peerEdges([]).size, 0, String(missing))
    assert.equal(peerEdges([{ a: 'a-edge', b: 'b-edge' }]).has('b-edge'), true, 'actual comparison pairs stay visible')
  }
  a.edges[0].kind = b.edges[0].kind = 'documented'
  assert.equal(peerEdges([]).has('b-edge'), true)
  a.edges[0].hover_key = b.edges[0].hover_key = 'unknown'
  assert.equal(peerEdges([]).size, 0, 'unknown hover key does not override kind as known evidence')
  a.edges[0].hover_key = b.edges[0].hover_key = 'declared'
  assert.equal(peerEdges([]).has('b-edge'), true)
  for (const field of ['semantic_key', 'hover_role', 'logical']) {
    for (const missing of ['', ' ', 'unknown', 'Unverified', '未知', '未核实']) {
      const left = { id: 'x' }, right = { id: 'y' }
      left[field] = right[field] = field === 'logical' ? { key: missing } : missing
      const project = comparisonPeers({ a: { nodes: [left], edges: [] }, b: { nodes: [right], edges: [] }, r: { pairs: [], edgePairs: [] } })
      assert.equal(project('a', { nodes: ['x'], edges: [] }).nodes.size, 0, `${field}: ${missing}`)
    }
  }
})

test('schema and runtime validate generic layout, hover and logical comparison hints', async () => {
  const source = { schemaVersion: 1, kind: 'paper-flow-document', paper: { id: 'p', title: 'Example' }, flows: [graph(false, false)] }
  source.flows[0].nodes[0].logical = { key: 'k', function: 'f', compare_fields: ['space.scope', '阶段.范围'] }
  source.flows[0].nodes[1].layout = { optimizePosition: true }
  Object.assign(source.flows[0].edges[0], { hover_key: 'shared', layout: { preferStraight: true } })
  assert.equal(validateFlowWorkspace(source).documents[0].flows[0].edges[0].layout.preferStraight, true)
  const schema = JSON.parse(await readFile(new URL('../vendor/paper-flow/schema.json', import.meta.url), 'utf8'))
  const pattern = new RegExp(schema.$defs.logical.properties.compare_fields.items.pattern)
  for (const [field, valid] of [['space.scope', true], ['阶段.范围', true], ['a.__proto__.x', false], ['constructor.x', false], ['a.compare_fields.x', false], ['a..b', false], ['a[0]', false], ['a b', false]]) {
    assert.equal(validCompareField(field), valid, field); assert.equal(pattern.test(field), valid, field)
    const candidate = structuredClone(source); candidate.flows[0].nodes[0].logical.compare_fields = [field]
    if (valid) assert.doesNotThrow(() => validateFlowWorkspace(candidate))
    else assert.throws(() => validateFlowWorkspace(candidate), error => error.diagnostics.some(item => item.path.endsWith('.compare_fields')))
  }
  for (const fields of [[], ['a', 'a'], ['a', 1]]) {
    const candidate = structuredClone(source); candidate.flows[0].nodes[0].logical.compare_fields = fields
    assert.throws(() => validateFlowWorkspace(candidate), error => error.diagnostics.some(item => item.path.endsWith('.compare_fields')))
  }
  for (const change of [edge => { edge.layout = { preferStraight: 'yes' } }, edge => { edge.hover_key = '  ' }]) {
    const candidate = structuredClone(source); change(candidate.flows[0].edges[0])
    assert.throws(() => validateFlowWorkspace(candidate), error => error.diagnostics.some(item => item.code === 'edge.field'))
  }
  const candidate = structuredClone(source); candidate.flows[0].nodes[1].layout = { optimizePosition: 'yes' }
  assert.throws(() => validateFlowWorkspace(candidate), error => error.diagnostics.some(item => item.path.endsWith('.layout')))
  for (const [key, value] of [['trunk_control', 'false'], ['hover_role', 7]]) {
    const badNode = structuredClone(source); badNode.flows[0].nodes[1][key] = value
    assert.throws(() => validateFlowWorkspace(badNode), error => error.diagnostics.some(item => item.path.endsWith('.' + key)))
  }
  const legacy = structuredClone(source); legacy.flows[0].nodes[1].hover_role = '  '
  assert.doesNotThrow(() => validateFlowWorkspace(legacy))
  const group = structuredClone(source)
  group.flows[0].paper_groups = [{ id: 'group', label: 'Group', members: ['n0', 'n1'], logical: { key: 'k', function: 'f', compare_fields: ['constructor.value'] } }]
  assert.throws(() => validateFlowWorkspace(group), error => error.diagnostics.some(item => item.code === 'group.logical' && item.path.endsWith('.compare_fields')))
})
