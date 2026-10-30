import test from 'node:test'
import assert from 'node:assert/strict'
import { createGraph } from '../vendor/paper-flow/core/graph.js'
import dagre from '../vendor/paper-flow/core/dagre.min.js'
import routing from '../vendor/paper-flow/core/routing.js'
import math from '../vendor/paper-flow/core/math-svg.min.js'

const graph = () => ({ id: 'synthetic', name: 'Synthetic', presentation_layout: 'compact',
  nodes: ['a', 'b'].map(id => ({ id, label: id, type: 'method', ports: { in: { p: { type: 'text' } }, out: { p: { type: 'text' } } } })),
  edges: [{ id: 'ab', from: 'a:p', to: 'b:p', kind: 'data' }],
})

test('layout cache separates node movement preferences, fixed markers and edge hints', () => {
  let calls = 0
  const engine = createGraph(dagre, { ...routing, route(layout, source) { calls++; return routing.route(layout, source) } }, math)
  const original = graph()
  engine.layout(original); engine.layout(original)
  assert.equal(calls, 1, 'unchanged layouts reuse their geometry')
  const restricted = structuredClone(original); restricted.nodes[1].layout = { optimizePosition: false }
  engine.layout(restricted)
  assert.equal(calls, 2, 'an opt-out cannot reuse previously optimized coordinates')
  const fixed = structuredClone(original); fixed.nodes[1].fixed = true
  engine.layout(fixed)
  assert.equal(calls, 3)
  const hinted = structuredClone(original); hinted.edges[0].layout = { preferStraight: true }
  engine.layout(hinted)
  assert.equal(calls, 4)
})

test('saved presentation edits select conservative routing before restoring their geometry', () => {
  const modes = []
  const engine = createGraph(dagre, { ...routing, route(layout, source) { modes.push(source.preserve_draft_geometry); return routing.route(layout, source) } }, math)
  const original = graph(), base = engine.layout(original), chosen = base.nodes[0]
  const edited = { ...original, presentation_edits: { nodes: { [chosen.id]: { x: chosen.x, y: chosen.y, fixed: true } }, edges: {}, relations: [] } }
  const before = JSON.stringify(edited), restored = engine.layout(edited)
  assert.deepEqual(modes, [false, true])
  assert.equal(restored.nodes.find(n => n.id === chosen.id).x, chosen.x)
  assert.equal(restored.nodes.find(n => n.id === chosen.id).y, chosen.y)
  assert.equal(JSON.stringify(edited), before)
})

test('unrouted stage measurement does not try to attach presentation edits to missing routes', () => {
  const engine = createGraph(dagre, routing, math), original = graph()
  original.presentation_edits = { nodes: { a: { x: 900, y: 500, fixed: true } }, edges: {}, relations: [] }
  const before = JSON.stringify(original)
  const measured = engine.layout(original, false)
  assert.ok(measured.nodes.every(n => Number.isFinite(n.x) && Number.isFinite(n.y)))
  assert.notEqual(measured.nodes.find(n => n.id === 'a').x, 900)
  assert.equal(JSON.stringify(original), before)
})
