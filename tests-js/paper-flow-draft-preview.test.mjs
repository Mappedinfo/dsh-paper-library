import test from 'node:test'
import assert from 'node:assert/strict'
import { previewEdit, describeAnchor, connectionPoint } from '../vendor/paper-flow/core/editing.js'
import router from '../vendor/paper-flow/core/routing.js'

function syntheticLayout() {
  const from = { id: 'a', x: 300, y: 120, width: 120, height: 60, node: { type: 'method' } }
  const to = { id: 'b', x: 300, y: 420, width: 120, height: 60, node: { type: 'method' } }
  const points = [{ x: 320, y: 150 }, { x: 320, y: 260 }, { x: 280, y: 260 }, { x: 280, y: 390 }]
  return { width: 700, height: 600, nodes: [from, to], routing: {}, edges: [{
    id: 'edge', from, to, edge: { id: 'edge', from: 'a:p', to: 'b:p' },
    sides: { start: 'bottom', end: 'top' }, points,
    locked_ends: { start: true, end: true }, manual_style: 'dashed', manual_route: points.map(p => ({ ...p })),
  }] }
}

test('preview reads locked anchors at group portals without mutating the displayed route', () => {
  const layout = syntheticLayout(), edge = layout.edges[0]
  edge.group_portals = { start: { ...edge.points[0] }, end: { ...edge.points.at(-1) } }
  edge.points = [{ x: 300, y: 120 }, ...edge.points, { x: 300, y: 420 }]
  const before = structuredClone(layout)
  const preview = previewEdit(layout, { nodes: { a: { x: 325, y: 120 } } }, router)
  const result = preview.edges[0]
  assert.deepEqual(describeAnchor(result.from, connectionPoint(result, 'start'), result.sides.start),
    describeAnchor(edge.from, edge.group_portals.start, edge.sides.start))
  assert.deepEqual(describeAnchor(result.to, connectionPoint(result, 'end'), result.sides.end),
    describeAnchor(edge.to, edge.group_portals.end, edge.sides.end))
  assert.deepEqual(layout, before)
})

for (const id of ['a', 'b']) {
  test(`preview keeps fixed anchors and hand-drawn route when moving ${id}`, () => {
    const layout = syntheticLayout(), before = structuredClone(layout)
    const originalEdge = layout.edges[0]
    const anchors = Object.fromEntries(['start', 'end'].map(end => [end,
      describeAnchor(end === 'start' ? originalEdge.from : originalEdge.to, connectionPoint(originalEdge, end), originalEdge.sides[end])]))
    const node = layout.nodes.find(n => n.id === id)
    const patch = { nodes: { [id]: { x: node.x + 25, y: node.y, fixed: true } } }
    const patchBefore = structuredClone(patch)
    const preview = previewEdit(layout, patch, router), edge = preview.edges[0]
    for (const end of ['start', 'end']) {
      assert.equal(edge.locked_ends[end], true)
      assert.deepEqual(describeAnchor(end === 'start' ? edge.from : edge.to, connectionPoint(edge, end), edge.sides[end]), anchors[end])
    }
    assert.equal(edge.manual_style, 'dashed')
    assert.deepEqual(edge.manual_route, originalEdge.manual_route)
    assert.deepEqual(layout, before)
    assert.deepEqual(patch, patchBefore)
  })
}
