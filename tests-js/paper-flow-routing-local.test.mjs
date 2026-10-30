import test from 'node:test'
import assert from 'node:assert/strict'
import engine from '../vendor/paper-flow/core/graph.js'
import router from '../vendor/paper-flow/core/routing.js'
import { prepareGraph } from '../vendor/paper-flow/comparison.js'

const view = { detail: 'full', arrangement: 'trunks', treeLevels: 'expanded', grouping: true }
function sample() {
  const nodes = Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, label: `Node ${i}`, type: 'method', ports: { in: { p: { type: 'text' } }, out: { p: { type: 'text' } } } }))
  const edges = [[0, 1], [0, 2], [0, 3], [1, 4], [0, 5], [1, 6], [0, 7]].map(([a, b], i) => ({ id: `e${i}`, from: `n${a}:p`, to: `n${b}:p`, kind: 'data' }))
  return { id: 'synthetic', name: 'Synthetic', nodes, edges }
}

test('unhinted single-parent node can move to simplify a synthetic fan without changing connectivity', () => {
  const graph = sample(), before = structuredClone(graph),
    layout = engine.layout(prepareGraph(graph, view)),
    post = layout.routing.post_node_search,
    repairs = post.changes.filter((c) => c.rule === 'avoidable-row-offset' && c.node === 'n2')
  assert.ok(post.accepted)
  assert.ok(post.after.crossings <= post.before.crossings)
  assert.ok(post.after.close_parallel_length <= post.before.close_parallel_length)
  assert.ok(post.after.length < post.before.length)
  assert.ok(post.changes.length <= post.pass_limit)
  assert.ok(repairs.length)
  assert.ok(repairs.some((c) => c.after.length < c.before.length))
  for (const c of repairs) {
    assert.ok(c.after.crossings <= c.before.crossings)
    assert.ok(c.after.close_parallel_length <= c.before.close_parallel_length)
  }
  assert.deepEqual(graph, before)
  assert.deepEqual(layout.edges.map((e) => [e.edge.from, e.edge.to]).sort(), graph.edges.map((e) => [e.from, e.to]).sort())
  const repeat = engine.layout(prepareGraph(graph, view))
  assert.deepEqual(repeat.nodes.map(({ id, x, y }) => ({ id, x, y })), layout.nodes.map(({ id, x, y }) => ({ id, x, y })))
  assert.deepEqual(repeat.edges.map(({ id, points }) => ({ id, points })), layout.edges.map(({ id, points }) => ({ id, points })))
})

test('explicit position opt-out keeps a node at its automatic baseline', () => {
  const graph = sample()
  const movable = engine.layout(prepareGraph(graph, view))
  const original = movable.routing.post_node_search.changes.find((c) => c.node === 'n2').from_x
  graph.nodes[2].layout = { optimizePosition: false }
  const result = engine.layout(prepareGraph(graph, view))
  assert.equal(result.nodes.find((n) => n.id === 'n2').x, original)
  assert.ok(!result.routing.post_node_search.changes.some((c) => c.node === 'n2'))
})

test('quality optimization preserves manual routes and locked endpoints', () => {
  const graph = sample(), layout = engine.layout(prepareGraph(graph, view))
  for (const edge of layout.edges) {
    edge.manual_route = edge.points.map((point) => ({ ...point }))
    edge.locked_ends = { start: true, end: true }
  }
  const before = layout.edges.map(({ id, points }) => ({ id, points: structuredClone(points) }))
  router.optimizeQuality(layout, graph)
  assert.deepEqual(layout.edges.map(({ id, points }) => ({ id, points })), before)
  for (const edge of layout.edges) delete edge.manual_route
  router.optimizeQuality(layout, graph)
  assert.deepEqual(layout.edges.map(({ id, points }) => ({ id, start: points[0], end: points.at(-1) })),
    before.map(({ id, points }) => ({ id, start: points[0], end: points.at(-1) })))
})

test('draft geometry mode does not apply the new unhinted node search', () => {
  const graph = sample(), initial = engine.layout(prepareGraph(graph, view)), node = initial.nodes.find((n) => n.id === 'n2')
  const draft = { nodes: { n2: { x: node.x, y: node.y, fixed: true } }, edges: {}, relations: [] }
  const result = engine.layout(prepareGraph(graph, view, draft)), saved = result.nodes.find((n) => n.id === 'n2')
  assert.equal(saved.x, node.x)
  assert.equal(saved.y, node.y)
  assert.equal(saved.draft_fixed, true)
  assert.equal(result.routing.post_node_search.skipped, 'draft')
})

test('joint face slots and a fresh channel can remove a synthetic crossing', () => {
  const from = { id: 'source', x: 100, y: 100, width: 120, height: 60, node: { type: 'method' } }
  const to = { id: 'target', x: 300, y: 300, width: 120, height: 60, node: { type: 'method' } }
  const edge = { id: 'wire', from, to, sides: { start: 'bottom', end: 'top' }, points: [{ x: 100, y: 130 }, { x: 100, y: 200 }, { x: 300, y: 200 }, { x: 300, y: 270 }] }
  const other = { id: 'other', from: { id: 'other-source' }, to: { id: 'other-target' }, sides: { start: 'bottom', end: 'top' }, points: [{ x: 240, y: 170 }, { x: 240, y: 240 }] }
  const boxes = [{ id: 'source', x: 22, y: 52, width: 156, height: 96 }, { id: 'target', x: 222, y: 252, width: 156, height: 96 }]
  const before = router.analyze([edge, other])
  const candidate = router.jointCorridors(edge, edge.points, [edge, other], boxes).find((points) => {
    const after = router.analyze([{ ...edge, points }, other])
    return points[0].x !== edge.points[0].x && points.at(-1).x !== edge.points.at(-1).x && after.crossings < before.crossings && after.close_parallel_length <= before.close_parallel_length
  })
  assert.equal(before.crossings, 1)
  assert.ok(candidate, 'a safe channel with both physical terminals moved removes the crossing')
  const shiftedTarget = { ...to, x: 160 }, shifted = { ...edge, to: shiftedTarget,
    points: [{ x: 100, y: 130 }, { x: 100, y: 200 }, { x: 160, y: 200 }, { x: 160, y: 270 }] }
  const shiftedBoxes = [boxes[0], { id: 'target', x: 82, y: 252, width: 156, height: 96 }]
  assert.ok(router.jointCorridors(shifted, shifted.points, [shifted], shiftedBoxes).some((points) => points.length === 2),
    'overlapping faces can share an exact physical coordinate for a straight connection')
})
